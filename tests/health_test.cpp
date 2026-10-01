// ==========================================================================
// Health monitoring core (fa_health.hpp) with scripted ticks: the decisions of Fa::HealthMonitor without
// FreeRTOS. Built and run by tests/run.sh.
// ==========================================================================

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "fa_health.hpp"

using Fa::HealthFault;
using Fa::HealthLimits;
using Fa::ProgressProbe;
using Fa::ProgressWatch;

namespace {
    // One monitored task and the monitor's view of it, checked every 10 ticks
    struct Rig {
        ProgressProbe probe;
        ProgressWatch watch;
        HealthLimits limits{100, 100, 0};
        uint32_t now = 0;
        bool pending = false;
        uint32_t elapsed = 0;

        HealthFault check() { return watch.check(probe, pending, now, limits, elapsed); }

        // Advances time in monitor periods, returning the first fault seen (or None)
        HealthFault run(uint32_t ticks) {
            HealthFault first = HealthFault::None;
            for (uint32_t t = 0; t < ticks; t += 10) {
                now += 10;
                const HealthFault f = check();
                if (first == HealthFault::None) first = f;
            }
            return first;
        }

        void step(uint32_t duration) {   // one unit of work, while the monitor keeps checking
            probe.begin(now);
            run(duration);
            probe.end(now);
        }
    };
}

TEST_CASE("an idle task with nothing queued is healthy however long it waits") {
    Rig r;
    r.check();
    CHECK(r.run(100000) == HealthFault::None);
}

TEST_CASE("steps within the budget are healthy, and the longest step is recorded") {
    Rig r;
    r.check();
    r.pending = true;
    for (int i = 0; i < 20; ++i) {
        r.step(50);
        CHECK(r.run(10) == HealthFault::None);
    }
    r.step(90);
    CHECK(r.check() == HealthFault::None);
    CHECK(r.probe.max_step.load() >= 90);
    CHECK(r.probe.max_step.load() < 100);
}

TEST_CASE("Stuck: busy in one step longer than max_step, even with nothing queued") {
    Rig r;
    r.check();
    r.probe.begin(r.now);
    CHECK(r.run(100) == HealthFault::None);
    CHECK(r.run(20) == HealthFault::Stuck);
    CHECK(r.elapsed > 100);
}

TEST_CASE("NoProgress: work waiting and no progress (a starved or suspended task)") {
    Rig r;
    r.check();
    CHECK(r.run(5000) == HealthFault::None);   // idle for a long time first: must not count as stalled
    r.pending = true;                           // an event arrives; the task never runs
    CHECK(r.run(100) == HealthFault::None);
    CHECK(r.run(20) == HealthFault::NoProgress);
    CHECK(r.elapsed > 100);
    CHECK(r.elapsed < 130);                     // measured from when the work appeared, not from the last step
}

TEST_CASE("a task that keeps completing steps is not stalled, however long the queue stays non-empty") {
    Rig r;
    r.check();
    r.pending = true;
    for (int i = 0; i < 100; ++i) {
        r.step(30);
    }
    CHECK(r.check() == HealthFault::None);
}

TEST_CASE("a long step counts as Stuck, never as NoProgress, while events wait behind it") {
    Rig r;
    r.limits = HealthLimits{200, 50, 0};
    r.check();
    r.pending = true;
    r.probe.begin(r.now);
    CHECK(r.run(200) == HealthFault::None);
    CHECK(r.run(20) == HealthFault::Stuck);
}

TEST_CASE("Idle (opt-in): no progress at all for longer than max_idle, nothing queued") {
    Rig r;
    r.limits = HealthLimits{100, 100, 300};
    r.check();
    r.step(10);
    CHECK(r.run(290) == HealthFault::None);
    CHECK(r.run(30) == HealthFault::Idle);       // progress is seen at the next check: up to one period late
    r.step(10);                                 // input arrives again: healthy
    CHECK(r.check() == HealthFault::None);
}

TEST_CASE("a periodic module that stops iterating is NoProgress (always pending)") {
    Rig r;
    r.limits = HealthLimits{100, 3 * 20 + 100, 0};   // period 20 ms: three periods plus a step
    r.pending = true;
    r.check();
    for (int i = 0; i < 50; ++i) {
        r.step(5);
        r.run(15);
    }
    CHECK(r.check() == HealthFault::None);
    CHECK(r.run(140) == HealthFault::None);
    CHECK(r.run(40) == HealthFault::NoProgress);
}

TEST_CASE("the tick counter wrapping around changes nothing") {
    Rig r;
    r.now = 0xFFFFFF00u;
    r.check();
    r.pending = true;
    for (int i = 0; i < 40; ++i) {
        r.step(30);                              // crosses 2^32 on the way
    }
    CHECK(r.check() == HealthFault::None);
    r.probe.begin(r.now);
    CHECK(r.run(100) == HealthFault::None);
    CHECK(r.run(20) == HealthFault::Stuck);
}

TEST_CASE("a step starting at tick 0 still reads as busy") {
    Rig r;
    r.now = 0xFFFFFFF6u;
    r.check();
    r.now = 0;
    r.probe.begin(0);
    CHECK(r.probe.busy_since.load() != 0);
    CHECK(r.run(120) == HealthFault::Stuck);
}

TEST_CASE("HealthRecord: a stored fault survives as valid; random RAM does not pass as one") {
    Fa::HealthRecord rec;
    rec.magic = 0x12345678u;
    rec.check = 0x9ABCDEF0u;
    CHECK_FALSE(rec.valid());
    rec.store(3, HealthFault::NoProgress, 750);
    CHECK(rec.valid());
    CHECK(rec.module == 3);
    CHECK(rec.elapsed_ms == 750);
    rec.elapsed_ms = 751;                         // corrupted
    CHECK_FALSE(rec.valid());
    rec.store(3, HealthFault::NoProgress, 750);
    rec.clear();
    CHECK_FALSE(rec.valid());
}

TEST_CASE("HealthFault record id: previous-run flag, kind, elapsed ms capped at 4095") {
    CHECK(Fa::health_fault_id(HealthFault::Stuck, 812, false) == (1u << 12 | 812u));
    CHECK(Fa::health_fault_id(HealthFault::Idle, 99999, true) == (0x8000u | 3u << 12 | 4095u));
}
