#pragma once

#include <cstddef>
#include <string_view>

namespace net::link {

struct Handlers {
    void (*connected_handler)();
    void (*disconnected_handler)();
    void (*text_handler)(const char* data, size_t len);
};

/**
 * @brief Connect to the game server over WebSocket in the background. If the connection
 * fails or drops later, it keeps retrying until it is connected again.
 *
 * @param uri
 * @param handlers
 */
void start(const char* uri, const Handlers& handlers);

/**
 * @brief Send one text message to the server.
 *
 * @return true if it was sent, false if not connected or the send failed.
 */
bool send_text(std::string_view text);

} // namespace net::link
