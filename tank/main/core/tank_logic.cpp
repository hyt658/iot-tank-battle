#include "core/tank_logic.h"

#include <cstddef>
#include <cstdint>

#include "core/protocol.h"
#include "esp_log.h"
#include "net/link.h"

using namespace core::protocol;

namespace {

constexpr const char* TAG = "core::tank_logic";

uint8_t s_tank_id = 0;

void connected_handler() {
    // TODO
    net::link::send_text(encode_hello(s_tank_id));
}

void disconnected_handler() {
    // TODO
    ESP_LOGW(TAG, "server disconnected");
}

void text_handler(const char* data, size_t len) {
    // TODO
    auto msg = parse(data, len);
    if (!msg) {
        ESP_LOGW(TAG, "invalid message: %.*s", static_cast<int>(len), data);
        return;
    }

    switch (msg->type) {
        case Message::Type::Error:
            ESP_LOGW(TAG, "server error: %.*s", static_cast<int>(len), data);
            break;

        // TODO: handle mode, drive, fire and sound.
        case Message::Type::Mode:
        case Message::Type::Drive:
        case Message::Type::Fire:
        case Message::Type::Sound:
        case Message::Type::Unknown:
            ESP_LOGI(TAG, "server: %.*s", static_cast<int>(len), data);
            break;
    }
}

} // namespace

void core::tank_logic::start(const char* server_uri, uint8_t tank_id) {
    s_tank_id = tank_id;
    net::link::start(
        server_uri,
        {
            .connected_handler = connected_handler,
            .disconnected_handler = disconnected_handler,
            .text_handler = text_handler,
        }
    );
}
