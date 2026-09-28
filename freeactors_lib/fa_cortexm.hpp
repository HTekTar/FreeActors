#ifndef FA_CORTEXM_HPP
#define FA_CORTEXM_HPP

// ==========================================================================
// Cortex-M helpers that are the same on every vendor's part (no vendor or CMSIS headers needed):
// the registers used here are defined by the ARMv7-M architecture (Cortex-M3, M4, M7).
//
// Fa::CortexM::CycleCounter — the DWT cycle counter, a sub-microsecond trace clock:
//   static void init() { cycles = Fa::CortexM::CycleCounter::enable(); ... }   // in the board's init()
//   static uint32_t trace_timestamp() noexcept { return Fa::CortexM::CycleCounter::now(); }
//   static uint32_t trace_timestamp_hz() noexcept { return SystemCoreClock; }  // the core clock (CMSIS)
// It wraps every 2^32 cycles (about 24 s at 180 MHz); the PC decoder unwraps it.
//
// The DWT and its cycle counter are OPTIONAL in ARMv7-M: most Cortex-M4 parts implement them, but not all.
// enable() returns false when the counter is not implemented; use the RTOS tick count instead then
// (xTaskGetTickCount / xTaskGetTickCountFromISR, trace_timestamp_hz = configTICK_RATE_HZ).
// Cortex-M0/M0+ never have one.
// ==========================================================================

#include <cstdint>

namespace Fa::CortexM {

    struct CycleCounter {
        // Starts the counter. Returns false if this core has no cycle counter (DWT_CTRL.NOCYCCNT).
        static bool enable() {
            demcr() |= (1u << 24);                  // DEMCR.TRCENA: enable the DWT and ITM blocks
            if (dwt_ctrl() & (1u << 25)) {          // DWT_CTRL.NOCYCCNT: cycle counter not implemented
                return false;
            }
            if (cpuid_part_number() == 0xC27u) {    // Cortex-M7: its DWT has a software lock
                dwt_lar() = 0xC5ACCE55u;
            }
            dwt_cyccnt() = 0;
            dwt_ctrl() |= 1u;                       // DWT_CTRL.CYCCNTENA: start counting
            return (dwt_ctrl() & 1u) != 0;
        }

        static uint32_t now() {
            return dwt_cyccnt();
        }

    private:
        // CPUID.PARTNO (bits 15:4): 0xC23 Cortex-M3, 0xC24 Cortex-M4, 0xC27 Cortex-M7
        static uint32_t cpuid_part_number() { return (*reinterpret_cast<volatile uint32_t *>(0xE000ED00u) >> 4) & 0xFFFu; }
        static volatile uint32_t &demcr()      { return *reinterpret_cast<volatile uint32_t *>(0xE000EDFCu); }
        static volatile uint32_t &dwt_ctrl()   { return *reinterpret_cast<volatile uint32_t *>(0xE0001000u); }
        static volatile uint32_t &dwt_cyccnt() { return *reinterpret_cast<volatile uint32_t *>(0xE0001004u); }
        static volatile uint32_t &dwt_lar()    { return *reinterpret_cast<volatile uint32_t *>(0xE0001FB0u); }
    };

} // namespace Fa::CortexM

#endif // FA_CORTEXM_HPP
