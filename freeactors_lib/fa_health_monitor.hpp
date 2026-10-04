#ifndef FA_HEALTH_MONITOR_HPP
#define FA_HEALTH_MONITOR_HPP

// ==========================================================================
// Fa::HealthMonitor — watchdog manager and health monitoring (docs/design/health.md).
//
// Built into Fa::Application, like the trace service: define FA_HEALTH and the application creates it.
// Every HealthCheckMs it checks every task the framework runs (ProgressWatch, fa_health.hpp) and feeds the
// hardware watchdog only while all are healthy. After the first fault it never feeds it again: the
// watchdog resets the chip. The fault is kept in no-init RAM and reported at the next start-up.
//
// Board (AppTraits::Watchdog, default: the board), all optional:
//   static void watchdog_start(uint32_t timeout_ms) noexcept;   // start the hardware watchdog (once)
//   static void watchdog_kick() noexcept;                         // feed it
//   static Fa::ResetCause reset_cause() noexcept;                // why the chip last started
// Without a watchdog the monitor still detects, traces and calls AppTraits::on_health_fault.
// ==========================================================================

#include <array>
#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "fa_common.hpp"
#include "fa_freertos.hpp"
#include "fa_health.hpp"
#include "fa_interrupt.hpp"

namespace Fa {

namespace detail {
    template <typename B, typename = void>
    struct has_watchdog : std::false_type {};
    template <typename B>
    struct has_watchdog<B, std::void_t<decltype(B::watchdog_start(uint32_t{})), decltype(B::watchdog_kick())>>
        : std::true_type {};

    template <typename B, typename = void>
    struct has_reset_cause : std::false_type {};
    template <typename B>
    struct has_reset_cause<B, std::void_t<decltype(B::reset_cause())>> : std::true_type {};

    constexpr uint32_t ticks_to_ms(uint32_t ticks) {
        return static_cast<uint32_t>(static_cast<uint64_t>(ticks) * 1000u / configTICK_RATE_HZ);
    }
}

// The first fault before a reset (no-init RAM: survives the watchdog reset)
FA_NOINIT inline HealthRecord health_record;

template <typename Hw, typename Ctx, typename Config>
struct HealthMonitor;

template <typename Hw, typename Ctx, typename Config>
struct TimeServiceTraits<HealthMonitor<Hw, Ctx, Config>> {
    static constexpr const char* name     = "FaHealth";
    static constexpr size_t stack_size    = 192;   // words
    static constexpr UBaseType_t priority = 1;     // lowest application priority: a starved CPU stops the feeding
};

// Config (from Fa::Application): check_ms, watchdog_timeout_ms, Board, entries (std::array<TaskEntry, n>),
// on_fault(module, fault, elapsed_ms).
template <typename Hw, typename Ctx, typename Config>
struct HealthMonitor : TimeServiceInterface<HealthMonitor<Hw, Ctx, Config>, Config::check_ms> {
    using Board = typename Config::Board;
    static constexpr size_t count = Config::entries.size();
    static constexpr bool has_watchdog = detail::has_watchdog<Board>::value;

    static_assert(count <= 32, "FA_HEALTH monitors at most 32 tasks");
    static_assert(!has_watchdog || Config::watchdog_timeout_ms >= 3 * Config::check_ms,
        "WatchdogTimeoutMs must be at least 3 x HealthCheckMs, so one late check does not reset the chip");

    static void task() noexcept {
        if (!started_) {
            start();
        }
        check(static_cast<uint32_t>(xTaskGetTickCount()));
    }

    // True once a fault was found: the watchdog is no longer fed
    static bool failed() { return failed_; }

    // HEALTH frame body after the command sequence (docs/design/health.md):
    //   u8 reset cause · u8 failed · u32 uptime ms · u8 count · per task: u8 status (HealthFault),
    //   u16 longest step ms, u16 free stack words (0xFFFF: unknown)
    static size_t report(uint8_t *out, size_t max) {
        if (max < 7) return 0;
        size_t n = 0;
        out[n++] = static_cast<uint8_t>(reset_cause_);
        out[n++] = failed_ ? 1 : 0;
        const uint32_t uptime = detail::ticks_to_ms(static_cast<uint32_t>(xTaskGetTickCount()));
        for (int i = 0; i < 4; ++i) out[n++] = static_cast<uint8_t>(uptime >> (8 * i));
        const size_t fits = (max - 7) / 5;
        const size_t shown = count < fits ? count : fits;
        out[n++] = static_cast<uint8_t>(shown);
        for (size_t i = 0; i < shown; ++i) {
            const TaskEntry &e = Config::entries[i];
            const uint32_t step = detail::ticks_to_ms(e.probe->max_step.load(std::memory_order_relaxed));
            const uint16_t step16 = static_cast<uint16_t>(step > 0xFFFFu ? 0xFFFFu : step);
            uint16_t stack = 0xFFFF;
#if defined(INCLUDE_uxTaskGetStackHighWaterMark) && INCLUDE_uxTaskGetStackHighWaterMark
            if (TaskHandle_t t = e.task()) {
                const UBaseType_t words = uxTaskGetStackHighWaterMark(t);
                stack = static_cast<uint16_t>(words > 0xFFFEu ? 0xFFFEu : words);
            }
#endif
            out[n++] = static_cast<uint8_t>(status_[i]);
            out[n++] = static_cast<uint8_t>(step16);
            out[n++] = static_cast<uint8_t>(step16 >> 8);
            out[n++] = static_cast<uint8_t>(stack);
            out[n++] = static_cast<uint8_t>(stack >> 8);
        }
        return n;
    }

private:
    // First run, in the monitor task: report why we started, then start the watchdog
    static void start() {
        started_ = true;
        if constexpr (detail::has_reset_cause<Board>::value) {
            reset_cause_ = Board::reset_cause();
        }
        Ctx::trace_raw(TraceKind::HealthReset, TraceSender::Health, static_cast<uint16_t>(reset_cause_));
        if (health_record.valid()) {   // the fault that stopped the previous run
            Ctx::trace_raw(TraceKind::HealthFault, health_record.module,
                           health_fault_id(static_cast<HealthFault>(health_record.fault), health_record.elapsed_ms, true));
        }
        health_record.clear();
        if constexpr (has_watchdog) {
            Board::watchdog_start(Config::watchdog_timeout_ms);
            Board::watchdog_kick();
        }
    }

    static void check(uint32_t now) {
        bool healthy = true;
        for (size_t i = 0; i < count; ++i) {
            const TaskEntry &e = Config::entries[i];
            bool pending = e.pending();
#ifdef FA_DEBUG_COMMANDS
            const uint8_t mode = e.gate->mode.load(std::memory_order_acquire);
            if (mode == PauseGate::Paused) {         // paused from the PC for debugging: not checked
                status_[i] = HealthFault::Paused;
                watch_[i].restart();
                reported_[i] = false;
                continue;
            }
            pending = pending || mode == PauseGate::HealthTest;   // "health test": looks like work waiting
#endif
            uint32_t elapsed = 0;
            const HealthFault fault = watch_[i].check(*e.probe, pending, now, e.limits, elapsed);
            status_[i] = fault;
            if (fault == HealthFault::None) {
                reported_[i] = false;
                continue;
            }
            healthy = false;
            if (!reported_[i]) {             // once per fault, not every check
                reported_[i] = true;
                on_fault(static_cast<uint8_t>(i), fault, detail::ticks_to_ms(elapsed));
            }
        }
        // An interrupt storm or an unexpected interrupt, recorded by the interrupt itself (it already traced it)
        auto& irq = detail::interrupt_fault;
        if (irq.pending.load(std::memory_order_acquire) && !interrupt_fault_taken_) {
            interrupt_fault_taken_ = true;
            healthy = false;
            if (!health_record.valid()) {
                health_record.store(irq.module, static_cast<HealthFault>(irq.fault), irq.value);
            }
            if (static_cast<HealthFault>(irq.fault) == HealthFault::Unexpected) {
                // the unexpected-interrupt handler cannot trace (any priority): traced here, from the task
                Ctx::trace_raw(TraceKind::HealthFault, irq.module, health_fault_id(HealthFault::Unexpected, irq.value, false));
            }
            Config::on_fault(irq.module, static_cast<HealthFault>(irq.fault), irq.value);
        } else if (interrupt_fault_taken_) {
            healthy = false;
        }
        if (!healthy) {
            failed_ = true;                  // sticky: a recovered system still gets its reset
        }
        if constexpr (has_watchdog) {
            if (!failed_) {
                Board::watchdog_kick();
            }
        }
    }

    static void on_fault(uint8_t module, HealthFault fault, uint32_t elapsed_ms) {
        if (!health_record.valid()) {
            health_record.store(module, fault, elapsed_ms);   // the first fault is the cause
        }
        Ctx::trace_raw(TraceKind::HealthFault, module, health_fault_id(fault, elapsed_ms, false));
        Config::on_fault(module, fault, elapsed_ms);
    }

    static inline bool started_ = false;
    static inline bool failed_ = false;
    static inline bool interrupt_fault_taken_ = false;
    static inline ResetCause reset_cause_ = ResetCause::Unknown;
    static inline std::array<ProgressWatch, count> watch_{};
    static inline std::array<HealthFault, count> status_{};
    static inline std::array<bool, count> reported_{};
};

} // namespace Fa

#endif // FA_HEALTH_MONITOR_HPP
