#include "hw/infrared.h"

#include "esp_log.h"

namespace {

constexpr const char* TAG = "hw::infrared";

} // namespace

// TODO
void hw::infrared::send(uint8_t shooter, uint8_t shot) {
    ESP_LOGI(TAG, "send shooter %d, shot %d", shooter, shot);
}
