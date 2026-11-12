#pragma once

#include <cstdint>

namespace hw::infrared {

/**
 * @brief Fire one IR shot that carries the shooter and the shot number.
 *
 * @param shooter  Number of this tank.
 * @param shot  Number of the shot, [0, 15].
 */
void send(uint8_t shooter, uint8_t shot);

} // namespace hw::infrared
