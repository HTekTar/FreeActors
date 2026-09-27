// ==========================================================================
// Debounced user button for the Timebomb example: a periodic process module (Fa::TimeServiceInterface).
// Used by the POSIX runtime test and the target compile check; also an example of application code.
//
// Every SampleMs it reads Hw::read_button(). A new level is accepted only after StableSamples identical
// samples in a row; an accepted press (released -> pressed) posts one Timebomb::ButtonPressed.
// Register it with the actors: Fa::Application<AppTraits, Timebomb::Actor, TimebombButton>.
// ==========================================================================
#pragma once

#include "fa_freertos.hpp"
#include "timebomb_events.hpp"

template <typename Hw, typename Ctx>
struct TimebombButton;

namespace Fa {
template <typename Hw, typename Ctx>
struct TimeServiceTraits<TimebombButton<Hw, Ctx>> {
    static constexpr const char* name       = "Button";
    static constexpr size_t stack_size      = 128;   // words
    static constexpr UBaseType_t priority   = 3;
};
} // namespace Fa

template <typename Hw, typename Ctx>
struct TimebombButton : Fa::TimeServiceInterface<TimebombButton<Hw, Ctx>, 5> {
    static constexpr int StableSamples = 3;

    static void task() noexcept {
        const bool raw = Hw::read_button();
        stable_count = (raw == last_sample) ? stable_count + 1 : 1;
        last_sample = raw;

        if (stable_count >= StableSamples && raw != pressed) {
            pressed = raw;
            if (pressed) {
                Ctx::post(Timebomb::ButtonPressed{});
            }
        }
    }

private:
    static inline bool last_sample = false;
    static inline int stable_count = 0;
    static inline bool pressed = false;   // debounced level
};
