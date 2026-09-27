// ==========================================================================
// A realistic Timebomb actor for tests/fixtures/timebomb.hsm.json, written the way a designer would.
// Used by the POSIX runtime test and the target compile check (in place of the empty generated stub).
//
// Behaviour: arming (ButtonPressed) waits in WAIT; the next ButtonPressed starts blinking the LED
// (LEDON/LEDOFF alternate on Tick, every BlinkMs). After BlinksToBoom blinks, the Tick in LEDOFF takes
// the TimeUp guard to BOOM. Leaving ARMED (defuse or BOOM) cancels the pending Tick.
// ==========================================================================
#pragma once

#include "timebomb_hsm.hpp"
#include "timebomb_hw_contract.hpp"

namespace Timebomb {

template <typename HwPolicy, typename Ctx = Fa::NullContext>
class Actor : public Fa::Hsm<Actor<HwPolicy, Ctx>, Event> {
    static_assert(HwContract<HwPolicy>::verify());

public:
    using Policy = HwPolicy;
    using Context = Ctx;
    using EventType = Event;

    static constexpr uint8_t instance_id = Fa::InstanceIdOf<HwPolicy>::value;
    static constexpr uint16_t BlinkMs = 50;
    static constexpr int BlinksToBoom = 3;

    int blinks = 0;

    bool TimeUp() const { return blinks >= BlinksToBoom; }
    bool TimeUp(Tick const &) const { return TimeUp(); }

    void entry_ROOT() {}
    void exit_ROOT() {}

    void entry_DISARMED() { HwPolicy::set_led(false); }
    void exit_DISARMED() {}

    void entry_ARMED() { blinks = 0; }
    void exit_ARMED() { this->cancel(Tick{}); }

    void entry_WAIT() {}
    void exit_WAIT() {}

    void entry_LEDON() {
        HwPolicy::set_led(true);
        ++blinks;
        this->schedule(Tick{}, BlinkMs);
    }
    void exit_LEDON() {}

    void entry_LEDOFF() {
        HwPolicy::set_led(false);
        this->schedule(Tick{}, BlinkMs);
    }
    void exit_LEDOFF() {}

    void entry_BOOM() { HwPolicy::set_led(true); }
    void exit_BOOM() {}
};

} // namespace Timebomb

namespace Fa {
template <typename HwPolicy, typename Ctx>
struct ActorTraits<Timebomb::Actor<HwPolicy, Ctx>> {
    static constexpr size_t QueueLength     = 8;
    static constexpr size_t StackDepthWords = 128;
    static constexpr unsigned Priority      = 2;
    static constexpr const char* Name       = "Timebomb";
};
} // namespace Fa
