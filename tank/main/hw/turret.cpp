#include "hw/turret.h"

#include <algorithm>
#include <cstdint>

#include "driver/ledc.h"
#include "esp_err.h"
#include "esp_log.h"
#include "hal/ledc_types.h"
#include "hw/pins.h"

namespace {

constexpr const char* TAG = "hw::turret";

constexpr ledc_mode_t LEDC_SpeedMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t LEDC_Timer = LEDC_TIMER_2;
constexpr ledc_channel_t LEDC_Channel = LEDC_CHANNEL_2;
constexpr ledc_timer_bit_t LEDC_DutyBits = LEDC_TIMER_14_BIT;

// The angle the servo turns to depends on the width of the pulse of each period.
constexpr uint32_t Servo_Hz = 50;
constexpr uint32_t Servo_PeriodUs = 1'000'000 / Servo_Hz;
constexpr int32_t Servo_CenterUs = 1500;    // Points straight ahead
constexpr int32_t Servo_MaxOffsetUs = 1000; // Turns 90 degrees from the center

int8_t s_angle = 0;

uint32_t to_duty(int8_t angle) {
    int32_t offset_us = angle * Servo_MaxOffsetUs / 90;
    auto pulse_us = static_cast<uint32_t>(Servo_CenterUs + offset_us);
    return pulse_us * (1U << LEDC_DutyBits) / Servo_PeriodUs;
}

} // namespace

void hw::turret::start() {
    ledc_timer_config_t timer = {};
    timer.speed_mode = LEDC_SpeedMode;
    timer.duty_resolution = LEDC_DutyBits;
    timer.timer_num = LEDC_Timer;
    timer.freq_hz = Servo_Hz;
    // Ensure all LEDC timers share the same clock source
    timer.clk_cfg = LEDC_USE_APB_CLK;
    ESP_ERROR_CHECK(ledc_timer_config(&timer));

    ledc_channel_config_t channel = {};
    channel.gpio_num = hw::pins::Turret;
    channel.speed_mode = LEDC_SpeedMode;
    channel.channel = LEDC_Channel;
    channel.timer_sel = LEDC_Timer;
    channel.duty = to_duty(s_angle);
    ESP_ERROR_CHECK(ledc_channel_config(&channel));

    ESP_LOGI(TAG, "turret started");
}

void hw::turret::set(int8_t angle) {
    angle = std::clamp<int8_t>(angle, -90, 90);
    if (angle == s_angle) {
        return;
    }
    s_angle = angle;
    ESP_ERROR_CHECK(ledc_set_duty(LEDC_SpeedMode, LEDC_Channel, to_duty(angle)));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_SpeedMode, LEDC_Channel));
    ESP_LOGD(TAG, "angle %d", angle);
}
