#include "core/tank_logic.h"

#include <cstddef>

#include "esp_log.h"
#include "net/link.h"

namespace {

constexpr const char* TAG = "core::tank_logic";

void connected_handler() {
    // TODO
    net::link::send_text(R"({"type":"hello","tank_id":1})");
}

void disconnected_handler() {
    // TODO
    ESP_LOGW(TAG, "server disconnected");
}

void text_handler(const char* data, size_t len) {
    // TODO
    ESP_LOGI(TAG, "server: %.*s", static_cast<int>(len), data);
}

} // namespace

void core::tank_logic::start(const char* server_uri) {
    net::link::start(
        server_uri,
        {
            .connected_handler = connected_handler,
            .disconnected_handler = disconnected_handler,
            .text_handler = text_handler,
        }
    );
}
