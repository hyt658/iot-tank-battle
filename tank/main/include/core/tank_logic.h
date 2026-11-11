#pragma once

#include <cstdint>

namespace core::tank_logic {

/**
 * @brief Start the tank logic and connect it to the game server in the background.
 */
void start(const char* server_uri, uint8_t tank_id);

} // namespace core::tank_logic
