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
#include "fa_cortexm.hpp"
#ifdef FA_TRACE
#include "fa_trace_service.hpp"
#endif
#include "fa_app.hpp"

// Stand-in board providing Timebomb's hardware requirements (tests/fixtures/timebomb.bsp_policy.hpp).
struct TargetBoard {
    static void init() {}
    static void set_led(bool) {}
    static uint16_t read_adc(uint8_t) { return 0; }
    static bool read_button() { return false; }

    // Trace transport (FA_TRACE): a real board sends the bytes over a UART; the cycle counter is the clock
    static void trace_write(uint8_t const *, size_t) noexcept {}
    static uint32_t trace_timestamp() noexcept { return Fa::CortexM::CycleCounter::now(); }
    static uint32_t trace_timestamp_hz() noexcept { return 16000000; }
};

struct AppTraits : Fa::DefaultAppTraits {
    using Platform = TargetBoard;
};

#ifdef FA_TRACE
using App = Fa::Application<AppTraits, Timebomb::Actor, TimebombButton, Fa::TraceService>;
#else
using App = Fa::Application<AppTraits, Timebomb::Actor, TimebombButton>;
#endif

extern "C" void vApplicationTickHook(void) {
    App::on_tick_isr();
}

int main() {
    App::init();
    App::post(Timebomb::ButtonPressed{});
    App::start();
}
