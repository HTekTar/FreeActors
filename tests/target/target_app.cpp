// ==========================================================================
// FreeActors target compile check (tests/run.sh)
// A minimal application for a Cortex-M4, compiled with arm-none-eabi-g++ against real FreeRTOS headers.
// Compiled, not linked: it proves the firmware code path builds with target flags
// (-fno-exceptions -fno-rtti, FPU and no-FPU) and reports the size of the resulting code.
// ==========================================================================

#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"

#include "timebomb_app_actor.hpp"      // realistic actor: blinks with a Tick timer (tests/fixtures)
#include "timebomb_button.hpp"         // periodic process module: debounced button (tests/fixtures)
#include "fa_app.hpp"

// Stand-in board providing Timebomb's hardware requirements (tests/fixtures/timebomb.bsp_policy.hpp).
struct TargetBoard {
    static void init() {}
    static void set_led(bool) {}
    static uint16_t read_adc(uint8_t) { return 0; }
    static bool read_button() { return false; }
};

struct AppTraits : Fa::DefaultAppTraits {
    using Platform = TargetBoard;
};

using App = Fa::Application<AppTraits, Timebomb::Actor, TimebombButton>;

extern "C" void vApplicationTickHook(void) {
    App::on_tick_isr();
}

int main() {
    App::init();
    App::post(Timebomb::ButtonPressed{});
    App::start();
}
