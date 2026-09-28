// ==========================================================================
// Lock-free SPSC ring (fa_spsc.hpp): stress tests with a real producer and consumer thread.
// Built and run by tests/run.sh twice: optimised, and under ThreadSanitizer (-fsanitize=thread).
// ==========================================================================

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "fa_spsc.hpp"

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <random>
#include <thread>
#include <vector>

namespace {
    // Binary semaphore, like a FreeRTOS task notification used with ulTaskNotifyTake(pdTRUE, ...)
    struct Notification {
        std::mutex m;
        std::condition_variable cv;
        bool pending = false;

        void give() {
            { std::lock_guard<std::mutex> lock(m); pending = true; }
            cv.notify_one();
        }
        // Returns false on timeout. wait_until with system_clock (pthread_cond_timedwait), not wait_for:
        // GCC 11's ThreadSanitizer does not intercept pthread_cond_clockwait and reports false races.
        bool take(std::chrono::milliseconds timeout) {
            std::unique_lock<std::mutex> lock(m);
            const bool got = cv.wait_until(lock, std::chrono::system_clock::now() + timeout, [&] { return pending; });
            pending = false;
            return got;
        }
    };

    struct Result {
        uint64_t received = 0;
        uint64_t out_of_order = 0;
        uint64_t lost_wakeups = 0;
        size_t max_span = 0;
    };

    // One producer pushing count sequential numbers, one consumer sleeping whenever the ring is empty.
    template <size_t N>
    Result run(uint32_t count, bool producer_pauses, uint32_t &dropped) {
        Fa::SpscRing<uint32_t, N> ring;
        Notification wake;
        std::atomic<bool> done{false};
        Result r;

        std::thread consumer([&] {
            uint32_t expected_min = 0;
            for (;;) {
                while (ring.available() > 0) {
                    ring.consume_available([&](uint32_t const *data, size_t n) {
                        r.max_span = n > r.max_span ? n : r.max_span;
                        for (size_t i = 0; i < n; ++i) {
                            if (data[i] < expected_min) ++r.out_of_order;   // duplicates or reordering
                            expected_min = data[i] + 1;
                            ++r.received;
                        }
                    });
                }
                if (done.load() && ring.available() == 0) {
                    return;
                }
                if (!wake.take(std::chrono::milliseconds(200)) && ring.available() > 0 && !done.load()) {
                    ++r.lost_wakeups;   // slept past a timeout although items were waiting: a lost notification
                }
            }
        });

        std::mt19937 rng(42);
        for (uint32_t i = 0; i < count; ++i) {
            bool notify = false;
            ring.push(i, notify);
            if (notify) wake.give();
            if (producer_pauses && rng() % 64 == 0) {
                std::this_thread::sleep_for(std::chrono::microseconds(rng() % 50));   // let the ring run empty
            }
        }
        done.store(true);
        wake.give();
        consumer.join();
        dropped = ring.dropped();
        return r;
    }
}

TEST_CASE("SPSC: nothing lost, duplicated or reordered; drops are counted; no lost wake-ups") {
    uint32_t dropped = 0;
    const uint32_t count = 1000000;
    Result r = run<256>(count, true, dropped);
    CHECK(r.out_of_order == 0);
    CHECK(r.lost_wakeups == 0);
    CHECK(r.received + dropped == count);
}

TEST_CASE("SPSC: a tiny ring under a full-speed producer drops, counts, and stays consistent") {
    uint32_t dropped = 0;
    const uint32_t count = 1000000;
    Result r = run<4>(count, false, dropped);
    CHECK(r.out_of_order == 0);
    CHECK(r.lost_wakeups == 0);
    CHECK(r.received + dropped == count);
    CHECK(r.max_span <= 4);
}

TEST_CASE("SPSC: batches arrive as at most two spans around the wrap") {
    Fa::SpscRing<int, 8> ring;
    bool wake = false;
    for (int i = 0; i < 6; ++i) ring.push(i, wake);
    ring.consume_available([](int const *, size_t) {});          // consumed = 6
    for (int i = 6; i < 12; ++i) ring.push(i, wake);              // slots 6,7 then 0..3: wraps

    std::vector<std::vector<int>> spans;
    CHECK(ring.consume_available([&](int const *data, size_t n) { spans.emplace_back(data, data + n); }) == 6);
    REQUIRE(spans.size() == 2);
    CHECK(spans[0] == std::vector<int>{6, 7});
    CHECK(spans[1] == std::vector<int>{8, 9, 10, 11});
}

TEST_CASE("SPSC: wake is requested only when the consumer had caught up") {
    Fa::SpscRing<int, 8> ring;
    bool wake = false;
    ring.push(1, wake);
    CHECK(wake);                // empty before: the consumer may be asleep
    ring.push(2, wake);
    CHECK_FALSE(wake);          // consumer has not caught up: it will see this item anyway
    ring.consume_available([](int const *, size_t) {});
    ring.push(3, wake);
    CHECK(wake);
    CHECK(ring.high_water() == 2);
}

TEST_CASE("SPSC: full ring drops the new item and counts it") {
    Fa::SpscRing<int, 2> ring;
    bool wake = false;
    CHECK(ring.push(1, wake));
    CHECK(ring.push(2, wake));
    CHECK_FALSE(ring.push(3, wake));
    CHECK(ring.dropped() == 1);
    std::vector<int> got;
    ring.consume_available([&](int const *d, size_t n) { got.insert(got.end(), d, d + n); });
    CHECK(got == std::vector<int>{1, 2});
}
