#pragma once

#include <cstdint>
#include <span>

namespace hw::buzzer {

struct Note {
    uint16_t hz;
    uint16_t ms;
};

/**
 * @brief Get ready to play sounds in the background.
 */
void start();

/**
 * @brief Play the notes in the background, stopping the sound being played.
 *
 * @param notes  Must stay valid while being played.
 */
void play(std::span<const Note> notes);

} // namespace hw::buzzer
