#pragma once

#include <cstdint>

namespace hw::turret {

/**
 * @brief Turn the turret to the given angle in degrees, [-90, 90]. 0 points straight
 * ahead, positive is clockwise.
 */
void set(int8_t angle);

} // namespace hw::turret
