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
#include "fa_app.hpp"

// Stand-in board providing Timebomb's hardware requirements (tests/fixtures/timebomb.bsp_policy.hpp).
struct TargetBoard {
    static void init() {}
    static void set_led(bool) {}
    static uint16_t read_adc(uint8_t) { return 0; }
    static bool read_button() { return false; }

    // Trace transport (FA_TRACE): a real board sends the bytes over a UART; the cycle counter is the clock
    static void trace_write(uint8_t const *data, size_t n) noexcept {   // like a UART driver: every byte is used
        for (size_t i = 0; i < n; ++i) *reinterpret_cast<volatile uint32_t *>(0x40004804u) = data[i];
    }
    static uint32_t trace_timestamp() noexcept { return Fa::CortexM::CycleCounter::now(); }
    static uint32_t trace_timestamp_hz() noexcept { return 16000000; }

    // Command input (FA_TRACE_COMMANDS) without receive DMA: one byte per UART interrupt (UART4 below)
    static void reset() noexcept { Fa::CortexM::system_reset(); }

    // Hardware watchdog (FA_HEALTH): like a real board, register writes the compiler must keep
    static void watchdog_start(uint32_t timeout_ms) noexcept { *reinterpret_cast<volatile uint32_t *>(0x40003008u) = timeout_ms; }
    static void watchdog_kick() noexcept { *reinterpret_cast<volatile uint32_t *>(0x40003000u) = 0xAAAAu; }
    static Fa::ResetCause reset_cause() noexcept {
        return (*reinterpret_cast<volatile uint32_t *>(0x40023874u) & (1u << 29)) ? Fa::ResetCause::Watchdog : Fa::ResetCause::Other;
    }
};

// SPSC service with an interrupt producer (compiles the lock-free path with M4 flags)
template <typename Hw, typename Ctx>
struct SampleSink;
namespace Fa {
template <typename Hw, typename Ctx>
struct TimeServiceTraits<SampleSink<Hw, Ctx>> {
    static constexpr const char* name     = "Samples";
    static constexpr size_t stack_size    = 128;
    static constexpr UBaseType_t priority = 2;
};
}
template <typename Hw, typename Ctx>
struct SampleSink : Fa::SpscServiceInterface<SampleSink<Hw, Ctx>, uint16_t, 32> {
    static inline uint32_t sum = 0;
    static void consume(uint16_t const &sample) noexcept { sum += sample; }
};

// DMA ring service: a board's UART/DMA interrupt reports the write position
template <typename Hw, typename Ctx>
struct CommandRx;
namespace Fa {
template <typename Hw, typename Ctx>
struct TimeServiceTraits<CommandRx<Hw, Ctx>> {
    static constexpr const char* name     = "CmdRx";
    static constexpr size_t stack_size    = 128;
    static constexpr UBaseType_t priority = 2;
};
}
template <typename Hw, typename Ctx>
struct CommandRx : Fa::DmaRingInterface<CommandRx<Hw, Ctx>, uint8_t, 256> {
    static inline uint32_t bytes = 0;
    static void consume_batch(uint8_t const *, size_t n) noexcept { bytes += n; }
};

struct AppTraits : Fa::DefaultAppTraits {
    using Platform = TargetBoard;
};

using App = Fa::Application<AppTraits, Timebomb::Actor, TimebombButton, SampleSink, CommandRx>;   // + trace with FA_TRACE, + commands with FA_TRACE_COMMANDS, + health with FA_HEALTH

extern "C" void USART3_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    App::dma_progress_from_isr<CommandRx>(17, &woken);   // a board reads the DMA's position here
    portYIELD_FROM_ISR(woken);
}

#ifdef FA_TRACE_COMMANDS
extern "C" void UART4_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    App::command_rx_byte_from_isr(0x00, &woken);          // a board reads the received byte here
    portYIELD_FROM_ISR(woken);
}
#endif

extern "C" void ADC_IRQHandler(void) {
    BaseType_t woken = pdFALSE;
    App::spsc_push_from_isr(static_cast<uint16_t>(42), &woken);
    portYIELD_FROM_ISR(woken);
}

extern "C" void vApplicationTickHook(void) {
    App::on_tick_isr();
}

int main() {
    App::init();
    App::post(Timebomb::ButtonPressed{});
    App::start();
}
