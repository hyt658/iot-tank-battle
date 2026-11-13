#include "net/link.h"

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string_view>

#include "cJSON.h"
#include "esp_err.h"
#include "esp_event_base.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"

namespace {

using JsonPtr = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

constexpr const char* TAG = "net::link";
constexpr int ReconnectTimeoutMs = 1000;
constexpr TickType_t SendTimeout = pdMS_TO_TICKS(100);
constexpr size_t PingIntervalSec = 1;
constexpr int PongTimeoutSec = 3;

esp_websocket_client_handle_t s_client = nullptr;
net::link::Handlers s_handlers = {};

// We only want to invoke the disconnect_handler when an established connection drops, not
// on every failed reconnect attempt. Therefore, we track the connection state ourselves.
bool s_connected = false;

// Handler sever's ping. Returns true if the message is a valid ping, false otherwise.
bool handle_ping(const char* data, size_t len) {
    JsonPtr root(cJSON_ParseWithLength(data, len), &cJSON_Delete);
    const char* type =
        cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(root.get(), "type"));
    if (!type || std::string_view(type) != "ping") {
        return false;
    }

    cJSON* ts = cJSON_GetObjectItemCaseSensitive(root.get(), "ts");
    if (!cJSON_IsNumber(ts)) {
        ESP_LOGW(TAG, "ping without a numeric ts: %.*s", static_cast<int>(len), data);
        return true;
    }

    char pong[48];
    snprintf(
        pong, sizeof(pong), R"({"type":"pong","ts":%.0f})", cJSON_GetNumberValue(ts)
    );
    net::link::send_text(pong);

    return true;
}

void ws_event_handler(
    void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data
) {
    (void)arg;
    (void)event_base;
    auto* data = static_cast<esp_websocket_event_data_t*>(event_data);

    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED:
            s_connected = true;
            ESP_LOGI(TAG, "connected to server");

            if (s_handlers.connect_handler) {
                s_handlers.connect_handler();
            }
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
            [[fallthrough]];
        case WEBSOCKET_EVENT_CLOSED:
            if (!s_connected) {
                break;
            }
            s_connected = false;

            // Websocket client will automatically reconnect after ReconnectTimeoutMs.
            ESP_LOGW(
                TAG, "disconnected from server, retrying in %d ms", ReconnectTimeoutMs
            );

            if (s_handlers.disconnect_handler) {
                s_handlers.disconnect_handler();
            }
            break;
        case WEBSOCKET_EVENT_DATA:
            // We only care about text frames. Ping, pong and close frames also arrive
            // here.
            if (data->op_code != WS_TRANSPORT_OPCODES_TEXT) {
                break;
            }

            // Websocket allows to send messages in multiple frames. We only support
            // single-frame messages, so drop the rest.
            if (!data->fin || data->data_len != data->payload_len) {
                if (data->payload_offset == 0) {
                    ESP_LOGW(
                        TAG, "dropped a split message (%d bytes)", data->payload_len
                    );
                }
                break;
            }

            if (handle_ping(data->data_ptr, data->data_len)) {
                break;
            }

            if (s_handlers.text_handler) {
                s_handlers.text_handler(data->data_ptr, data->data_len);
            }
            break;
        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGE(
                TAG, "error: type %d, socket errno %d", data->error_handle.error_type,
                data->error_handle.esp_transport_sock_errno
            );
            break;
        default:
            break;
    }
}

} // namespace

void net::link::start(const char* uri, const Handlers& handlers) {
    s_handlers = handlers;

    esp_websocket_client_config_t config = {};
    config.uri = uri;
    config.reconnect_timeout_ms = ReconnectTimeoutMs;
    // We want to reconnect even after a clean close from the server.
    config.enable_close_reconnect = true;
    config.ping_interval_sec = PingIntervalSec;
    config.pingpong_timeout_sec = PongTimeoutSec;

    s_client = esp_websocket_client_init(&config);
    if (!s_client) {
        ESP_LOGE(TAG, "esp_websocket_client_init failed");
        abort();
    }
    ESP_ERROR_CHECK(esp_websocket_register_events(
        s_client, WEBSOCKET_EVENT_ANY, &ws_event_handler, nullptr
    ));
    ESP_ERROR_CHECK(esp_websocket_client_start(s_client));

    ESP_LOGI(TAG, "connecting to %s", uri);
}

bool net::link::send_text(std::string_view text) {
    if (!s_client || !esp_websocket_client_is_connected(s_client)) {
        return false;
    }

    int sent = esp_websocket_client_send_text(
        s_client, text.data(), static_cast<int>(text.size()), SendTimeout
    );
    if (sent < 0) {
        ESP_LOGW(TAG, "send failed: %.*s", static_cast<int>(text.size()), text.data());
        return false;
    }
    return true;
}
