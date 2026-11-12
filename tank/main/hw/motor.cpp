#include "hw/motor.h"

#include "esp_log.h"

namespace {

constexpr const char* TAG = "hw::motor";

int8_t s_left = 0;
int8_t s_right = 0;

} // namespace

// TODO
void hw::motor::set(int8_t left, int8_t right) {
    if (left == s_left && right == s_right) {
        return;
    }
    s_left = left;
    s_right = right;
    ESP_LOGI(TAG, "left %d, right %d", left, right);
}
