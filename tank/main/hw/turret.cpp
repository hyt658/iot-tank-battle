#include "hw/turret.h"

#include "esp_log.h"

namespace {

constexpr const char* TAG = "hw::turret";

int8_t s_angle = 0;

} // namespace

// TODO
void hw::turret::set(int8_t angle) {
    if (angle == s_angle) {
        return;
    }
    s_angle = angle;
    ESP_LOGI(TAG, "angle %d", angle);
}
