#pragma once

#include "soc/gpio_num.h"

namespace hw::pins {

constexpr gpio_num_t IrTx = GPIO_NUM_4;
// Front, back, left, right.
constexpr gpio_num_t IrRx[] = {GPIO_NUM_5, GPIO_NUM_6, GPIO_NUM_7, GPIO_NUM_15};

} // namespace hw::pins
