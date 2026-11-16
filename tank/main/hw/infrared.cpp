#include "hw/infrared.h"

#include "esp_log.h"

namespace {

constexpr const char* TAG = "hw::infrared";

void (*s_hit_handler)(uint8_t shooter, uint8_t shot) = nullptr;

} // namespace

// TODO
void hw::infrared::start(void (*hit_handler)(uint8_t shooter, uint8_t shot)) {
    s_hit_handler = hit_handler;
    ESP_LOGI(TAG, "IR receiver started");
}

// TODO
void hw::infrared::send(uint8_t shooter, uint8_t shot) {
    ESP_LOGI(TAG, "send shooter %d, shot %d", shooter, shot);
}
