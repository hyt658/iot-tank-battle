#pragma once

#include <cstdint>

namespace hw::motor {

/**
 * @brief Set the speed of both tracks, each in [-100, 100]. Positive is forward, 0 stops.
 */
void set(int8_t left, int8_t right);

} // namespace hw::motor
