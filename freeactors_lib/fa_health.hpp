#ifndef FA_HEALTH_HPP
#define FA_HEALTH_HPP

// ==========================================================================
// Health monitoring core (docs/design/health.md). No FreeRTOS dependency: host tests drive it with
// scripted ticks. The FreeRTOS side is Fa::HealthMonitor (fa_health_monitor.hpp), built into
// Fa::Application with FA_HEALTH.
//
// Every task loop the framework runs (actors, periodic modules, MPSC/SPSC/DMA services) brackets each unit
// of work with ProgressProbe::begin/end: one run-to-completion step, one task() iteration, one consumed span.
// The monitor compares the probes with the clock (ProgressWatch::check):
//   Stuck       busy in one unit of work longer than max_step      (endless loop, deadlock, blocked driver)
//   NoProgress  work pending, no progress for longer than max_stall  (starved, suspended, stopped iterating)
//   Idle        no progress at all for longer than max_idle (opt-in) (expected input stopped arriving)
// Times are ticks; differences use unsigned arithmetic, so the tick counter may wrap.
// ==========================================================================

#include <atomic>
#include <cstddef>
#include <cstdint>

// Variables that survive a reset (not zeroed at start-up): the board's linker script needs a NOLOAD
// .noinit section in RAM (docs/design/health.md). Override for another section name.
#ifndef FA_NOINIT
#define FA_NOINIT __attribute__((section(".noinit")))
#endif

namespace Fa {

    enum class HealthFault : uint8_t {
        None       = 0,
        Stuck      = 1,
        NoProgress = 2,
        Idle       = 3,
        Paused     = 4,   // status only (HEALTH frame), never a fault: paused from the PC, not checked
    };

    // Why the chip last started, as reported by the board's optional reset_cause()
    enum class ResetCause : uint8_t {
        Unknown  = 0,
        PowerOn  = 1,
        Pin      = 2,   // reset pin / debugger
        Software = 3,   // e.g. the RESET command
        Watchdog = 4,
        Brownout = 5,
        LowPower = 6,
        Other    = 7,
    };

    // Written only by the monitored module's own task; read by the monitor.
    struct ProgressProbe {
        std::atomic<uint32_t> progress{0};     // units of work completed (only changes matter)
        std::atomic<uint32_t> busy_since{0};   // start tick of the current unit | 1; 0 = not busy
        std::atomic<uint32_t> max_step{0};     // longest unit of work so far, ticks

        void begin(uint32_t now) {
            busy_since.store(now | 1u, std::memory_order_release);   // | 1: tick 0 must not read as idle
        }

        void end(uint32_t now) {
            const uint32_t step = now - (busy_since.load(std::memory_order_relaxed) & ~1u);
            if (step > max_step.load(std::memory_order_relaxed)) {
                max_step.store(step, std::memory_order_relaxed);
            }
            busy_since.store(0, std::memory_order_release);
            progress.store(progress.load(std::memory_order_relaxed) + 1, std::memory_order_release);
        }
    };

    // Limits for one module, in ticks; 0 switches a check off
    struct HealthLimits {
        uint32_t max_step;    // Stuck
        uint32_t max_stall;   // NoProgress
        uint32_t max_idle;    // Idle (opt-in)
    };

    // The monitor's view of one module (monitor task only)
    class ProgressWatch {
    public:
        // pending: the module has work waiting (queued events, buffered items; always true for periodic
        // modules). elapsed: how long the fault condition has lasted, in ticks.
        HealthFault check(ProgressProbe const &probe, bool pending, uint32_t now, HealthLimits const &limits,
                          uint32_t &elapsed) {
            const uint32_t busy = probe.busy_since.load(std::memory_order_acquire);
            const uint32_t progress = probe.progress.load(std::memory_order_acquire);
            if (!started_ || progress != seen_progress_) {
                started_ = true;
                seen_progress_ = progress;
                last_progress_ = now;
                stall_since_ = now;
            }
            if (busy != 0) {
                elapsed = now - (busy & ~1u);
                if (limits.max_step != 0 && elapsed > limits.max_step) {
                    return HealthFault::Stuck;
                }
                stall_since_ = now;          // working on it: a long step is the Stuck check's business
            } else if (!pending) {
                stall_since_ = now;          // nothing waiting: not stalled
            }
            elapsed = now - stall_since_;
            if (limits.max_stall != 0 && elapsed > limits.max_stall) {
                return HealthFault::NoProgress;
            }
            elapsed = now - last_progress_;
            if (busy == 0 && limits.max_idle != 0 && elapsed > limits.max_idle) {
                return HealthFault::Idle;
            }
            elapsed = 0;
            return HealthFault::None;
        }

        // Forget the history (a task resumed after a pause starts with a clean slate)
        void restart() { started_ = false; }

    private:
        bool started_ = false;
        uint32_t seen_progress_ = 0;
        uint32_t last_progress_ = 0;
        uint32_t stall_since_ = 0;
    };

    // The first fault before a reset, kept in no-init RAM so the next start-up can report it.
    struct HealthRecord {
        static constexpr uint32_t Magic = 0xFA4EA17Bu;

        uint32_t magic;
        uint8_t  module;
        uint8_t  fault;        // HealthFault
        uint16_t reserved;
        uint32_t elapsed_ms;
        uint32_t check;        // ~(magic ^ fields): rejects random RAM contents after power-on

        uint32_t checksum() const {
            return ~(magic ^ (static_cast<uint32_t>(module) << 8 | fault) ^ elapsed_ms);
        }
        bool valid() const { return magic == Magic && check == checksum(); }

        void store(uint8_t m, HealthFault f, uint32_t ms) {
            magic = Magic;
            module = m;
            fault = static_cast<uint8_t>(f);
            reserved = 0;
            elapsed_ms = ms;
            check = checksum();
        }
        void clear() { magic = 0; check = 0; }
    };

    // HealthFault trace record id (TraceKind::HealthFault)
    constexpr uint16_t health_fault_id(HealthFault fault, uint32_t elapsed_ms, bool previous_run) {
        return static_cast<uint16_t>((previous_run ? 0x8000u : 0u) | (static_cast<uint32_t>(fault) & 7u) << 12 |
                                     (elapsed_ms > 4095u ? 4095u : elapsed_ms));
    }

} // namespace Fa

#endif // FA_HEALTH_HPP
