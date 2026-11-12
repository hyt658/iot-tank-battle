#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace core::protocol {

struct Message {
    enum class Type : uint8_t { Unknown, State, Drive, Fire, Event, Error };
    enum class Event : uint8_t { GameStart, GameEnd, Respawn, Hurt, Death, HitConfirm };

    struct Drive {
        int8_t left;   // [-100, 100], positive is forward.
        int8_t right;  // [-100, 100], positive is forward.
        int8_t turret; // [-90, 90], positive is clockwise.
    };

    Type type;
    bool enable;
    Drive drive;
    Event event;
    uint8_t shot; // [0, 15]
};

/**
 * @brief Parse data from the server to a Message.
 *
 * @return the Message, or std::nullopt if the data is not a valid Message.
 */
std::optional<Message> parse(const char* data, size_t len);

/**
 * @brief Build the hello message, sent right after connecting to the server.
 */
std::string encode_hello(uint8_t tank_id);

/**
 * @brief Build the hit message, sent when the IR receiver decodes a shot.
 *
 * @param shooter  Number of the shooter tank.
 * @param shot  Number of the shot.
 */
std::string encode_hit(uint8_t shooter, uint8_t shot);

} // namespace core::protocol
