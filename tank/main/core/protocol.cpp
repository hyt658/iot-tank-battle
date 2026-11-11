#include "core/protocol.h"

#include <memory>
#include <string>
#include <string_view>

#include "cJSON.h"

using namespace core::protocol;

namespace {

using JsonPtr = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

// Returns root[key] if it is a string, std::nullopt otherwise.
std::optional<std::string_view> get_string(const cJSON* root, const char* key) {
    const char* value = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(root, key));
    if (!value) {
        return std::nullopt;
    }
    return value;
}

// Returns root[key] if it is a number in [min, max], std::nullopt otherwise.
// Decimals will be truncated.
std::optional<int> get_int(const cJSON* root, const char* key, int min, int max) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsNumber(item)) {
        return std::nullopt;
    }

    // Check the range before converting since we don't want to convert an out-of-range
    // double to int
    double value = cJSON_GetNumberValue(item);
    if (value < min || value > max) {
        return std::nullopt;
    }

    return static_cast<int>(value);
}

Message::Type to_type(std::string_view name) {
    if (name == "error") return Message::Type::Error;
    if (name == "mode") return Message::Type::Mode;
    if (name == "drive") return Message::Type::Drive;
    if (name == "fire") return Message::Type::Fire;
    if (name == "sound") return Message::Type::Sound;
    return Message::Type::Unknown;
}

std::optional<Message::Mode> to_mode(std::string_view name) {
    if (name == "enabled") return Message::Mode::Enabled;
    if (name == "disabled") return Message::Mode::Disabled;
    return std::nullopt;
}

std::optional<Message::Sound> to_sound(std::string_view name) {
    if (name == "game_start") return Message::Sound::GameStart;
    if (name == "game_end") return Message::Sound::GameEnd;
    if (name == "respawn") return Message::Sound::Respawn;
    if (name == "hurt") return Message::Sound::Hurt;
    if (name == "death") return Message::Sound::Death;
    if (name == "hit_confirm") return Message::Sound::HitConfirm;
    return std::nullopt;
}

} // namespace

std::optional<Message> core::protocol::parse(const char* data, size_t len) {
    JsonPtr root(cJSON_ParseWithLength(data, len), &cJSON_Delete);
    if (!cJSON_IsObject(root.get())) {
        return std::nullopt;
    }

    auto type = get_string(root.get(), "type");
    if (!type) {
        return std::nullopt;
    }

    Message msg = {};
    msg.type = to_type(*type);

    switch (msg.type) {
        case Message::Type::Unknown:
            [[fallthrough]];
        case Message::Type::Error:
            break;
        case Message::Type::Mode: {
            auto name = get_string(root.get(), "mode");
            if (!name) {
                return std::nullopt;
            }
            auto mode = to_mode(*name);
            if (!mode) {
                return std::nullopt;
            }
            msg.mode = *mode;
            break;
        }
        case Message::Type::Drive: {
            auto left = get_int(root.get(), "left", -100, 100);
            auto right = get_int(root.get(), "right", -100, 100);
            auto turret = get_int(root.get(), "turret", -90, 90);
            if (!left || !right || !turret) {
                return std::nullopt;
            }
            msg.drive = {
                .left = static_cast<int8_t>(*left),
                .right = static_cast<int8_t>(*right),
                .turret = static_cast<int8_t>(*turret),
            };
            break;
        }
        case Message::Type::Fire: {
            auto shot = get_int(root.get(), "shot", 0, 15);
            if (!shot) {
                return std::nullopt;
            }
            msg.shot = static_cast<uint8_t>(*shot);
            break;
        }
        case Message::Type::Sound: {
            auto name = get_string(root.get(), "name");
            if (!name) {
                return std::nullopt;
            }
            auto sound = to_sound(*name);
            if (!sound) {
                return std::nullopt;
            }
            msg.sound = *sound;
            break;
        }
    }

    return msg;
}

std::string core::protocol::encode_hello(uint8_t tank_id) {
    return R"({"type":"hello","tank_id":)" + std::to_string(tank_id) + "}";
}

std::string core::protocol::encode_hit(uint8_t shooter, uint8_t shot) {
    return R"({"type":"hit","shooter":)" + std::to_string(shooter) + R"(,"shot":)" +
           std::to_string(shot) + "}";
}
