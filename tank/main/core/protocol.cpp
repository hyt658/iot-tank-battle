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

// Returns root[key] if it is a bool, std::nullopt otherwise.
std::optional<bool> get_bool(const cJSON* root, const char* key) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsBool(item)) {
        return std::nullopt;
    }
    return cJSON_IsTrue(item);
}

Message::Type to_type(std::string_view name) {
    if (name == "error") return Message::Type::Error;
    if (name == "state") return Message::Type::State;
    if (name == "drive") return Message::Type::Drive;
    if (name == "fire") return Message::Type::Fire;
    if (name == "event") return Message::Type::Event;
    return Message::Type::Unknown;
}

std::optional<Message::Event> to_event(std::string_view kind) {
    if (kind == "game_start") return Message::Event::GameStart;
    if (kind == "game_end") return Message::Event::GameEnd;
    if (kind == "respawn") return Message::Event::Respawn;
    if (kind == "hurt") return Message::Event::Hurt;
    if (kind == "death") return Message::Event::Death;
    if (kind == "hit_confirm") return Message::Event::HitConfirm;
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
        case Message::Type::State: {
            auto has_enable = get_bool(root.get(), "enable");
            if (!has_enable) {
                return std::nullopt;
            }
            msg.enable = *has_enable;
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
        case Message::Type::Event: {
            auto kind = get_string(root.get(), "kind");
            if (!kind) {
                return std::nullopt;
            }
            // Ignore unknown kinds
            auto event = to_event(*kind);
            if (!event) {
                msg.type = Message::Type::Unknown;
                break;
            }
            msg.event = *event;
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
