#include "hw/buzzer.h"

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <span>

#include "driver/ledc.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hal/ledc_types.h"
#include "hw/pins.h"

using hw::buzzer::Note;

namespace {

constexpr const char* TAG = "hw::buzzer";
constexpr uint32_t TaskStackSize = 2048;
constexpr UBaseType_t TaskPriority = 5;

constexpr ledc_mode_t LEDC_SpeedMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t LEDC_Timer = LEDC_TIMER_0;
constexpr ledc_channel_t LEDC_Channel = LEDC_CHANNEL_0;
constexpr ledc_timer_bit_t LEDC_DutyBits = LEDC_TIMER_10_BIT;
constexpr uint32_t LEDC_HalfDuty = 1 << (LEDC_DutyBits - 1);
// Could be any value APB_CLK can make because each note will set its own freq later
constexpr uint32_t LEDC_InitHz = 2000;

QueueHandle_t s_play_queue = nullptr;

void buzzer_task(void* arg);

} // namespace

void hw::buzzer::start() {
    ledc_timer_config_t timer = {};
    timer.speed_mode = LEDC_SpeedMode;
    timer.duty_resolution = LEDC_DutyBits;
    timer.timer_num = LEDC_Timer;
    timer.freq_hz = LEDC_InitHz;
    // Ensure all LEDC timers share the same clock source
    timer.clk_cfg = LEDC_USE_APB_CLK;
    ESP_ERROR_CHECK(ledc_timer_config(&timer));

    ledc_channel_config_t channel = {};
    channel.gpio_num = hw::pins::Buzzer;
    channel.speed_mode = LEDC_SpeedMode;
    channel.channel = LEDC_Channel;
    channel.timer_sel = LEDC_Timer;
    channel.duty = 0;
    ESP_ERROR_CHECK(ledc_channel_config(&channel));

    // We only play the last incoming sound. A new one will replace it.
    s_play_queue = xQueueCreate(1, sizeof(std::span<const Note>));
    if (!s_play_queue) {
        ESP_LOGE(TAG, "xQueueCreate failed");
        abort();
    }
    if (xTaskCreate(
            buzzer_task, "buzzer", TaskStackSize, nullptr, TaskPriority, nullptr
        ) != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate failed");
        abort();
    }

    ESP_LOGI(TAG, "buzzer started");
}

void hw::buzzer::play(std::span<const Note> notes) {
    xQueueOverwrite(s_play_queue, &notes);
}

namespace {

void set_tone(uint16_t hz) {
    uint32_t duty = 0;
    if (hz > 0) {
        ESP_ERROR_CHECK(ledc_set_freq(LEDC_SpeedMode, LEDC_Timer, hz));
        duty = LEDC_HalfDuty;
    }
    ESP_ERROR_CHECK(ledc_set_duty(LEDC_SpeedMode, LEDC_Channel, duty));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_SpeedMode, LEDC_Channel));
}

void buzzer_task(void* arg) {
    (void)arg;

    std::span<const Note> notes;
    while (true) {
        // Stay silent until a sound comes.
        set_tone(0);
        xQueueReceive(s_play_queue, &notes, portMAX_DELAY);

        // Play the notes in order. A new sound coming in the middle will replaces notes
        // and starts over from its first note.
        size_t note_idx = 0;
        while (note_idx < notes.size()) {
            set_tone(notes[note_idx].hz);
            TickType_t note_time = pdMS_TO_TICKS(notes[note_idx].ms);

            if (xQueueReceive(s_play_queue, &notes, note_time)) {
                note_idx = 0;
            } else {
                ++note_idx;
            }
        }
    }
}

} // namespace
