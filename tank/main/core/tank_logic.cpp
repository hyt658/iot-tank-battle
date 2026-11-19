#include "core/tank_logic.h"

#include <cstddef>
#include <cstdint>
#include <cstdlib>

#include "core/protocol.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hw/infrared.h"
#include "hw/motor.h"
#include "hw/turret.h"
#include "net/link.h"

using namespace core::protocol;

namespace {

constexpr const char* TAG = "core::tank_logic";
constexpr uint32_t TaskStackSize = 4096;
constexpr UBaseType_t TaskPriority = 5;
constexpr UBaseType_t QueueSize = 32;

constexpr TickType_t DriveTimeout = pdMS_TO_TICKS(300);
constexpr TickType_t HitDedupeTime = pdMS_TO_TICKS(1000);

struct Input {
    enum class Type : uint8_t { Connect, Disconnect, Message, Hit };

    struct HitInfo {
        uint8_t shooter;
        uint8_t shot;
    };

    Type type;
    Message msg = {};
    HitInfo hit = {};
};

uint8_t s_tank_id = 0;
bool s_enabled = false;
bool s_moving = false;
QueueHandle_t s_input_queue = nullptr;

Input::HitInfo s_last_hit = {};
TickType_t s_last_drive_time = 0;
TickType_t s_last_hit_time = 0;

void tank_logic_task(void* arg);
void connect_handler();
void disconnect_handler();
void text_handler(const char* data, size_t len);
void hit_handler(uint8_t shooter, uint8_t shot);

} // namespace

void core::tank_logic::start(const char* server_host, uint8_t tank_id) {
    s_tank_id = tank_id;
    s_input_queue = xQueueCreate(QueueSize, sizeof(Input));

    if (!s_input_queue) {
        ESP_LOGE(TAG, "xQueueCreate failed");
        abort();
    }
    if (xTaskCreate(
            tank_logic_task, "tank_logic", TaskStackSize, nullptr, TaskPriority, nullptr
        ) != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate failed");
        abort();
    }

    hw::infrared::start(hit_handler);
    auto uri = tank_uri(server_host, tank_id);
    net::link::start(
        uri.c_str(),
        {
            .connect_handler = connect_handler,
            .disconnect_handler = disconnect_handler,
            .text_handler = text_handler,
        }
    );
}

namespace {

void stop_tank();
void enqueue(const Input& input);
void process_message(const Message& msg);
void process_hit(const Input::HitInfo& hit);

void tank_logic_task(void* arg) {
    (void)arg;
    while (true) {
        auto wait_time = portMAX_DELAY;
        if (s_moving) {
            TickType_t elapsed = xTaskGetTickCount() - s_last_drive_time;
            if (elapsed < DriveTimeout) {
                wait_time = DriveTimeout - elapsed;
            } else {
                wait_time = 0;
            }
        }

        Input input;
        BaseType_t res = xQueueReceive(s_input_queue, &input, wait_time);

        // xQueueReceive only times out when s_moving is true, otherwise it waits forever.
        if (res != pdTRUE) {
            ESP_LOGW(TAG, "no drive for 300 ms, stopping");
            stop_tank();
            continue;
        }

        // Handle the input.
        switch (input.type) {
            case Input::Type::Connect:
                // Connect input wants to disable the tank since we want a known state
                // before the server sends control messages.
                [[fallthrough]];
            case Input::Type::Disconnect:
                // Disconnect input wants to disable the tank since we don't want the
                // tank to keep moving when the server is disconnected.
                s_enabled = false;
                stop_tank();
                break;
            case Input::Type::Message:
                process_message(input.msg);
                break;
            case Input::Type::Hit:
                process_hit(input.hit);
                break;
        }
    }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

void enqueue(const Input& input) {
    if (xQueueSend(s_input_queue, &input, 0) != pdTRUE) {
        ESP_LOGW(TAG, "input queue is full, dropped an input");
    }
}

void stop_tank() {
    hw::motor::set(0, 0);
    s_moving = false;
}

void process_message(const Message& msg) {
    switch (msg.type) {
        case Message::Type::State: {
            s_enabled = msg.enable;
            const char* state_str = "enabled";
            if (!s_enabled) {
                state_str = "disabled";
                stop_tank();
            }
            ESP_LOGI(TAG, "tank %s", state_str);
            break;
        }
        case Message::Type::Drive:
            if (!s_enabled) {
                break;
            }
            s_moving = (msg.drive.left != 0 || msg.drive.right != 0);
            s_last_drive_time = xTaskGetTickCount();
            hw::motor::set(msg.drive.left, msg.drive.right);
            hw::turret::set(msg.drive.turret);
            break;
        case Message::Type::Fire:
            if (!s_enabled) {
                break;
            }
            hw::infrared::send(s_tank_id, msg.shot);
            break;
        case Message::Type::Hurt:
            [[fallthrough]];
        case Message::Type::Death:
            [[fallthrough]];
        case Message::Type::Respawn:
            // TODO: how do we play the sound?
            break;
        case Message::Type::Error:
            [[fallthrough]];
        case Message::Type::Unknown:
            // Error and Unknown messages are handled in text_handler. We don't want them
            // to pollute our input queue.
            break;
    }
}

void process_hit(const Input::HitInfo& hit) {
    // The tank receiver may also see its own shot.
    if (hit.shooter == s_tank_id) {
        return;
    }

    // The same shot can reach us several times, since each shot could be sent in several
    // frames and more than one receiver may decode the same frame. Report it only once.
    TickType_t now = xTaskGetTickCount();
    if (hit.shooter == s_last_hit.shooter && hit.shot == s_last_hit.shot &&
        now - s_last_hit_time < HitDedupeTime) {
        return;
    }
    s_last_hit = hit;
    s_last_hit_time = now;

    ESP_LOGI(TAG, "hit by tank %d, shot %d", hit.shooter, hit.shot);
    net::link::send_text(encode_hit(hit.shooter, hit.shot));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

void connect_handler() {
    ESP_LOGD(TAG, "server connected");
    enqueue({.type = Input::Type::Connect});
}

void disconnect_handler() {
    ESP_LOGW(TAG, "server disconnected");
    enqueue({.type = Input::Type::Disconnect});
}

void text_handler(const char* data, size_t len) {
    auto msg = parse(data, len);
    if (!msg) {
        ESP_LOGW(TAG, "invalid message: %.*s", static_cast<int>(len), data);
        return;
    }

    if (msg->type == Message::Type::Unknown) {
        ESP_LOGD(TAG, "unknown message: %.*s", static_cast<int>(len), data);
        return;
    }

    if (msg->type == Message::Type::Error) {
        ESP_LOGW(TAG, "server error: %.*s", static_cast<int>(len), data);
        return;
    }

    enqueue({.type = Input::Type::Message, .msg = *msg});
}

void hit_handler(uint8_t shooter, uint8_t shot) {
    enqueue({.type = Input::Type::Hit, .hit = {.shooter = shooter, .shot = shot}});
}

} // namespace
