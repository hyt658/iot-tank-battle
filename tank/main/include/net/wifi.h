#pragma once

namespace net::wifi {

/**
 * @brief Start connecting to the given Wi-Fi network in the background. If the connection
 * fails or drops later, it keeps retrying until it is connected again
 */
void start(const char* ssid, const char* password);

} // namespace net::wifi
