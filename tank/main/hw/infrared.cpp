#include "hw/infrared.h"

#include <algorithm>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iterator>
#include <optional>

#include "driver/rmt_rx.h"
#include "driver/rmt_tx.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hw/pins.h"

namespace {

constexpr const char* TAG = "hw::infrared";
constexpr uint32_t TaskStackSize = 4096;
constexpr UBaseType_t TaskPriority = 5;

// How our protocol sends a shot over NEC.
constexpr uint8_t Address = 0x54;
constexpr uint8_t AddressInv = ~Address;
constexpr size_t FramesPerShot = 3;
constexpr int32_t FrameEndIdleUs = 50'000;

// NEC protocol timing.
constexpr size_t NEC_FrameBits = 32;
constexpr int32_t NEC_LeadMarkUs = 9000;
constexpr int32_t NEC_LeadSpaceUs = 4500;
constexpr int32_t NEC_BitMarkUs = 560;   // Approximated from 562.5 us
constexpr int32_t NEC_OneSpaceUs = 1690; // Approximated from 1687.5 us
constexpr int32_t NEC_ZeroSpaceUs = 560; // Approximated from 562.5 us
constexpr uint32_t NEC_BlinkHz = 38'000; // 38 kHz IR
constexpr float NEC_BlinkDuty = 0.33f;

// RMT configuration.
constexpr uint32_t RMT_TickHz = 1'000'000;    // 1 us per tick
constexpr size_t RMT_MemSymsPerChan = 48;     // Each channel takes one mem block
constexpr int32_t RMT_MaxDurationUs = 32767;  // A level's duration only has 15 bits
constexpr uint32_t RMT_MinLevelNs = 1250;     // Copied from IDF NEC example
constexpr uint32_t RMT_MaxLevelNs = 12000000; // Copied from IDF NEC example
// FrameEndIdleUs may not fit in one level.
constexpr size_t IdleLevelCount =
    FrameEndIdleUs / RMT_MaxDurationUs + (FrameEndIdleUs % RMT_MaxDurationUs != 0);
// 1 lead + 32 data (one per bit) + 1 end pulse with the first idle level + the rest
// idle levels (each symbol contains two levels).
constexpr size_t RMT_TxBufferSyms = 1 + NEC_FrameBits + 1 + (IdleLevelCount / 2);
// 34 symbols for a received frame (none for idle time) and extra room for noise.
constexpr size_t RMT_RxBufferSyms = std::bit_ceil(RMT_TxBufferSyms);

constexpr int32_t RxToleranceUs = 200; // Copied from IDF NEC example
constexpr size_t ReceiverCount = std::size(hw::pins::IrRx);

struct Transmitter {
    rmt_encoder_handle_t encoder;
    rmt_channel_handle_t channel;
    rmt_symbol_word_t symbols[RMT_TxBufferSyms];
};

struct Receiver {
    rmt_channel_handle_t channel;
    rmt_symbol_word_t symbols[RMT_RxBufferSyms];
    size_t num_symbols;
};

Transmitter s_transmitter = {};
Receiver s_receivers[ReceiverCount] = {};
rmt_receive_config_t s_receive_config = {};
QueueHandle_t s_rx_queue = nullptr;
void (*s_hit_handler)(uint8_t shooter, uint8_t shot) = nullptr;

void start_tx();
void start_rx();
void encode_frame(uint8_t data); // Encode data into transmitter symbols

} // namespace

void hw::infrared::start(void (*hit_handler)(uint8_t shooter, uint8_t shot)) {
    s_hit_handler = hit_handler;
    start_tx();
    start_rx();
    ESP_LOGI(TAG, "IR started with %d receivers", ReceiverCount);
}

void hw::infrared::send(uint8_t shooter, uint8_t shot) {
    // s_transmitter.symbols must not change while the last shot is still being sent.
    if (rmt_tx_wait_all_done(s_transmitter.channel, 0) != ESP_OK) {
        ESP_LOGW(TAG, "still sending the last shot, dropped shot %d", shot);
        return;
    }

    uint8_t data = (shooter << 4) | shot;
    encode_frame(data);

    // RMT sends the frames one after another in the background.
    rmt_transmit_config_t config = {};
    for (size_t i = 0; i < FramesPerShot; ++i) {
        ESP_ERROR_CHECK(rmt_transmit(
            s_transmitter.channel, s_transmitter.encoder, s_transmitter.symbols,
            sizeof(s_transmitter.symbols), &config
        ));
    }

    ESP_LOGI(TAG, "send shooter %d, shot %d", shooter, shot);
}

namespace {

void infrared_task(void* arg);
bool rx_done_handler(
    rmt_channel_handle_t channel, const rmt_rx_done_event_data_t* edata, void* user_ctx
);

void start_tx() {
    rmt_tx_channel_config_t config = {};
    config.gpio_num = hw::pins::IrTx;
    config.clk_src = RMT_CLK_SRC_DEFAULT;
    config.resolution_hz = RMT_TickHz;
    config.mem_block_symbols = RMT_MemSymsPerChan;
    config.trans_queue_depth = FramesPerShot;
    ESP_ERROR_CHECK(rmt_new_tx_channel(&config, &s_transmitter.channel));

    rmt_carrier_config_t carrier = {};
    carrier.frequency_hz = NEC_BlinkHz;
    carrier.duty_cycle = NEC_BlinkDuty;
    ESP_ERROR_CHECK(rmt_apply_carrier(s_transmitter.channel, &carrier));

    rmt_copy_encoder_config_t encoder_config = {};
    ESP_ERROR_CHECK(rmt_new_copy_encoder(&encoder_config, &s_transmitter.encoder));
    ESP_ERROR_CHECK(rmt_enable(s_transmitter.channel));
}

void start_rx() {
    // Once a receiver puts an event into the queue, it stops receiving until
    // infrared_task handles that event. So each receiver has at most one event in the
    // queue, and ReceiverCount entries are just enough.
    s_rx_queue = xQueueCreate(ReceiverCount, sizeof(Receiver*));
    if (!s_rx_queue) {
        ESP_LOGE(TAG, "xQueueCreate failed");
        abort();
    }

    s_receive_config.signal_range_min_ns = RMT_MinLevelNs;
    s_receive_config.signal_range_max_ns = RMT_MaxLevelNs;

    for (size_t i = 0; i < ReceiverCount; ++i) {
        auto& receiver = s_receivers[i];

        rmt_rx_channel_config_t config = {};
        config.gpio_num = hw::pins::IrRx[i];
        config.clk_src = RMT_CLK_SRC_DEFAULT;
        config.resolution_hz = RMT_TickHz;
        config.mem_block_symbols = RMT_MemSymsPerChan;
        ESP_ERROR_CHECK(rmt_new_rx_channel(&config, &receiver.channel));

        rmt_rx_event_callbacks_t callbacks = {};
        callbacks.on_recv_done = rx_done_handler;
        ESP_ERROR_CHECK(
            rmt_rx_register_event_callbacks(receiver.channel, &callbacks, &receiver)
        );

        ESP_ERROR_CHECK(rmt_enable(receiver.channel));
        ESP_ERROR_CHECK(rmt_receive(
            receiver.channel, receiver.symbols, sizeof(receiver.symbols),
            &s_receive_config
        ));
    }

    if (xTaskCreate(
            infrared_task, "infrared", TaskStackSize, nullptr, TaskPriority, nullptr
        ) != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate failed");
        abort();
    }
}

void encode_frame(uint8_t data) {
    auto& symbols = s_transmitter.symbols;
    size_t sym_idx = 0;

    // symbols[0] is the leading code.
    symbols[sym_idx++] = {
        .duration0 = NEC_LeadMarkUs,
        .level0 = 1,
        .duration1 = NEC_LeadSpaceUs,
        .level1 = 0,
    };

    // NEC sends each byte LSB first.
    uint8_t bytes[] = {Address, AddressInv, data, static_cast<uint8_t>(~data)};
    for (uint8_t byte : bytes) {
        for (int bit_idx = 0; bit_idx < 8; ++bit_idx) {
            bool bit = (byte >> bit_idx) & 1;
            uint16_t space_us = bit ? NEC_OneSpaceUs : NEC_ZeroSpaceUs;
            symbols[sym_idx++] = {
                .duration0 = NEC_BitMarkUs,
                .level0 = 1,
                .duration1 = space_us,
                .level1 = 0,
            };
        }
    }

    // After sending all data frame (symbols), we need to send a ending burst (one level,
    // half symbol), then idle for FrameEndIdleUs.
    int32_t idle_us = FrameEndIdleUs;
    auto next_idle_us = [&] {
        int32_t us = std::min(idle_us, RMT_MaxDurationUs);
        idle_us -= us;
        return static_cast<uint16_t>(us);
    };

    symbols[sym_idx++] = {
        .duration0 = NEC_BitMarkUs,
        .level0 = 1,
        .duration1 = next_idle_us(),
        .level1 = 0,
    };

    while (idle_us > 0) {
        symbols[sym_idx++] = {
            .duration0 = next_idle_us(),
            .level0 = 0,
            .duration1 = next_idle_us(),
            .level1 = 0,
        };
    }
}

std::optional<uint8_t> decode_frame(
    const rmt_symbol_word_t* symbols, size_t num_symbols
) {
    // We don't care about the ending burst level so not include it during checking
    if (num_symbols < 1 + NEC_FrameBits) {
        return std::nullopt;
    }

    if (std::abs(symbols[0].duration0 - NEC_LeadMarkUs) >= RxToleranceUs ||
        std::abs(symbols[0].duration1 - NEC_LeadSpaceUs) >= RxToleranceUs) {
        return std::nullopt;
    }

    // NEC sends each byte LSB first.
    uint8_t bytes[4] = {};
    size_t sym_idx = 1; // Skip symbols[0] since it is the leading code.
    for (auto& byte : bytes) {
        for (int bit_idx = 0; bit_idx < 8; ++bit_idx) {
            // The receiver module will turns a mark into a low level, but it does not
            // matter since the order of symbols and levels are fixed and we actually
            // classify logic 1 and 0 by `duration1`
            const auto& symbol = symbols[sym_idx++];
            bool mark_ok = (std::abs(symbol.duration0 - NEC_BitMarkUs) < RxToleranceUs);
            bool is_one = (std::abs(symbol.duration1 - NEC_OneSpaceUs) < RxToleranceUs);
            bool is_zero = (std::abs(symbol.duration1 - NEC_ZeroSpaceUs) < RxToleranceUs);
            if (!mark_ok || !(is_one || is_zero)) {
                return std::nullopt;
            }
            if (is_one) {
                byte |= 1 << bit_idx;
            }
        }
    }

    if (bytes[0] != Address || bytes[1] != AddressInv ||
        bytes[3] != static_cast<uint8_t>(~bytes[2])) {
        return std::nullopt;
    }
    return bytes[2];
}

void infrared_task(void* arg) {
    (void)arg;

    while (true) {
        Receiver* receiver = nullptr;
        xQueueReceive(s_rx_queue, static_cast<void*>(&receiver), portMAX_DELAY);
        int index = receiver - s_receivers;

        // Keep a copy for num_symbols since we will invoke `rmt_receive()` right after
        // decode to receive future Rx events, which could cause `receiver->num_symbols`
        // be overwritten.
        size_t num_symbols = receiver->num_symbols;
        auto data = decode_frame(receiver->symbols, num_symbols);
        ESP_ERROR_CHECK(rmt_receive(
            receiver->channel, receiver->symbols, sizeof(receiver->symbols),
            &s_receive_config
        ));

        if (!data) {
            ESP_LOGD(
                TAG, "receiver %d: invalid frame with %d symbols", index, num_symbols
            );
            continue;
        }

        uint8_t shooter = *data >> 4;
        uint8_t shot = *data & 0x0F;
        ESP_LOGD(TAG, "receiver %d: shooter %d, shot %d", index, shooter, shot);

        if (s_hit_handler) {
            s_hit_handler(shooter, shot);
        }
    }
}

bool rx_done_handler(
    rmt_channel_handle_t channel, const rmt_rx_done_event_data_t* edata, void* user_ctx
) {
    (void)channel;

    auto* receiver = static_cast<Receiver*>(user_ctx);
    receiver->num_symbols = edata->num_symbols;
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR(s_rx_queue, static_cast<const void*>(&receiver), &woken);
    return woken == pdTRUE;
}

} // namespace
