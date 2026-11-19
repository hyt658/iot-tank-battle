#pragma once

#include "soc/gpio_num.h"

namespace hw::pins {

// Front, back, left, right.
constexpr gpio_num_t IrRx[] = {GPIO_NUM_5, GPIO_NUM_6, GPIO_NUM_7, GPIO_NUM_15};
constexpr gpio_num_t IrTx = GPIO_NUM_4;

constexpr gpio_num_t Buzzer = GPIO_NUM_16;
constexpr gpio_num_t Turret = GPIO_NUM_17;

// MDD3A M1A/M1B for the left motor, M2A/M2B for the right.
constexpr gpio_num_t MotorLeftA = GPIO_NUM_18;
constexpr gpio_num_t MotorLeftB = GPIO_NUM_8;
constexpr gpio_num_t MotorRightA = GPIO_NUM_9;
constexpr gpio_num_t MotorRightB = GPIO_NUM_10;

} // namespace hw::pins
