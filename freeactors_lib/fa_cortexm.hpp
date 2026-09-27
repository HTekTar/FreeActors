#ifndef FA_CORTEXM_HPP
#define FA_CORTEXM_HPP

// ==========================================================================
// Cortex-M helpers that are the same on every vendor's part (no vendor or CMSIS headers needed):
// the registers used here are defined by the ARMv7-M architecture (Cortex-M3, M4, M7).
//
// Fa::CortexM::CycleCounter — the DWT cycle counter, a sub-microsecond trace clock:
//   static void init()  { Fa::CortexM::CycleCounter::enable(); ... }             // in the board's init()
//   static uint32_t trace_timestamp() noexcept { return Fa::CortexM::CycleCounter::now(); }
//   static uint32_t trace_timestamp_hz() noexcept { return SystemCoreClock; }  // the core clock
// It wraps every 2^32 cycles (about 24 s at 180 MHz); the PC decoder unwraps it.
// Cortex-M0/M0+ have no cycle counter: use the RTOS tick count there instead.
// ==========================================================================

#include <cstdint>

namespace Fa::CortexM {

    struct CycleCounter {
        static void enable() {
            demcr() |= (1u << 24);          // DEMCR.TRCENA: enable the DWT and ITM blocks
            dwt_lar() = 0xC5ACCE55u;        // unlock the DWT (needed on Cortex-M7, ignored elsewhere)
            dwt_cyccnt() = 0;
            dwt_ctrl() |= 1u;               // DWT_CTRL.CYCCNTENA: start counting
        }

        static uint32_t now() {
            return dwt_cyccnt();
        }

    private:
        static volatile uint32_t &demcr()      { return *reinterpret_cast<volatile uint32_t *>(0xE000EDFCu); }
        static volatile uint32_t &dwt_ctrl()   { return *reinterpret_cast<volatile uint32_t *>(0xE0001000u); }
        static volatile uint32_t &dwt_cyccnt() { return *reinterpret_cast<volatile uint32_t *>(0xE0001004u); }
        static volatile uint32_t &dwt_lar()    { return *reinterpret_cast<volatile uint32_t *>(0xE0001FB0u); }
    };

} // namespace Fa::CortexM

#endif // FA_CORTEXM_HPP
