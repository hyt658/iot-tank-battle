#pragma once

namespace core::tank_logic {

/**
 * @brief Start the tank logic and connect it to the game server in the background.
 *
 * @param server_uri  Server address, e.g. "ws://10.42.0.1:8000/ws/tank".
 */
void start(const char* server_uri);

} // namespace core::tank_logic
