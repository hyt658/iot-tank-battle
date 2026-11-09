#include "core/tank_logic.h"
#include "esp_err.h"
#include "esp_log.h"
#include "net/wifi.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

namespace {

constexpr const char* TAG = "main";

void init_nvs() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

} // namespace

extern "C" void app_main() {
    ESP_LOGI(TAG, "Tank firmware started");

    init_nvs();
    net::wifi::start(CONFIG_TANK_WIFI_SSID, CONFIG_TANK_WIFI_PASSWORD);
    core::tank_logic::start(CONFIG_TANK_SERVER_URI);
}
