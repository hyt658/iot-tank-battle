#include "hw/motor.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <initializer_list>

#include "driver/ledc.h"
#include "esp_err.h"
#include "esp_log.h"
#include "hal/ledc_types.h"
#include "hw/pins.h"

namespace {

constexpr const char* TAG = "hw::motor";

constexpr ledc_mode_t LEDC_SpeedMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t LEDC_Timer = LEDC_TIMER_3;
constexpr ledc_timer_bit_t LEDC_DutyBits = LEDC_TIMER_10_BIT;

// The highest PWM frequency the MDD3A takes, so the motors don't whine.
constexpr uint32_t MDD3A_PwmHz = 20000;

// The MDD3A turns a motor forward with PWM on input A and B low, and backward with A low
// and PWM on B. Both low brakes it.
struct Motor {
    gpio_num_t pin_a;
    gpio_num_t pin_b;
    ledc_channel_t channel_a;
    ledc_channel_t channel_b;
};

constexpr Motor Left = {
    .pin_a = hw::pins::MotorLeftA,
    .pin_b = hw::pins::MotorLeftB,
    .channel_a = LEDC_CHANNEL_3,
    .channel_b = LEDC_CHANNEL_4,
};
constexpr Motor Right = {
    .pin_a = hw::pins::MotorRightA,
    .pin_b = hw::pins::MotorRightB,
    .channel_a = LEDC_CHANNEL_5,
    .channel_b = LEDC_CHANNEL_6,
};

int8_t s_left = 0;
int8_t s_right = 0;

void config_channel(gpio_num_t pin, ledc_channel_t channel) {
    ledc_channel_config_t config = {};
    config.gpio_num = pin;
    config.speed_mode = LEDC_SpeedMode;
    config.channel = channel;
    config.timer_sel = LEDC_Timer;
    config.duty = 0;
    ESP_ERROR_CHECK(ledc_channel_config(&config));
}

void set_duty(ledc_channel_t channel, uint32_t duty) {
    ESP_ERROR_CHECK(ledc_set_duty(LEDC_SpeedMode, channel, duty));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_SpeedMode, channel));
}

void set_speed(const Motor& motor, int8_t speed) {
    auto magnitude = static_cast<uint32_t>(std::abs(speed));
    uint32_t duty = magnitude * (1U << LEDC_DutyBits) / 100;
    set_duty(motor.channel_a, speed > 0 ? duty : 0);
    set_duty(motor.channel_b, speed < 0 ? duty : 0);
}

} // namespace

void hw::motor::start() {
    ledc_timer_config_t timer = {};
    timer.speed_mode = LEDC_SpeedMode;
    timer.duty_resolution = LEDC_DutyBits;
    timer.timer_num = LEDC_Timer;
    timer.freq_hz = MDD3A_PwmHz;
    // Ensure all LEDC timers share the same clock source
    timer.clk_cfg = LEDC_USE_APB_CLK;
    ESP_ERROR_CHECK(ledc_timer_config(&timer));

    for (const Motor& motor : {Left, Right}) {
        config_channel(motor.pin_a, motor.channel_a);
        config_channel(motor.pin_b, motor.channel_b);
    }

    ESP_LOGI(TAG, "motor started");
}

void hw::motor::set(int8_t left, int8_t right) {
    left = std::clamp<int8_t>(left, -100, 100);
    right = std::clamp<int8_t>(right, -100, 100);
    if (left == s_left && right == s_right) {
        return;
    }
    s_left = left;
    s_right = right;
    set_speed(Left, left);
    set_speed(Right, right);
    ESP_LOGD(TAG, "left %d, right %d", left, right);
}
