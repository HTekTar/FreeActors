// ==========================================================================
// Continuous DMA reception ring (fa_dma.hpp) with scripted DMA positions, plus a threaded stress test.
// Built and run by tests/run.sh twice: optimised, and under ThreadSanitizer (-fsanitize=thread).
// ==========================================================================

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "fa_dma.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <random>
#include <thread>
#include <vector>

using bytes = std::vector<uint8_t>;

namespace {
    // Plays the DMA hardware: writes a running byte sequence at its own position (which runs ahead of what
    // has been reported) and reports positions like the half/complete/idle-line interrupts would.
    template <size_t N>
    struct FakeDma {
        Fa::DmaRing<uint8_t, N> &ring;
        size_t hw = 0;
        uint8_t next = 0;

        void write(size_t n) {
            for (size_t i = 0; i < n; ++i) {
                ring.buffer()[hw] = next++;
                hw = (hw + 1) % N;
            }
        }
        bool report() {
            bool wake = false;
            ring.progress(hw, wake);
            return wake;
        }
    };

    template <size_t N>
    std::vector<bytes> consume(Fa::DmaRing<uint8_t, N> &ring, size_t *lost = nullptr) {
        std::vector<bytes> spans;
        ring.consume_available([&](uint8_t const *d, size_t n) { spans.emplace_back(d, d + n); },
                               [&](size_t n) { if (lost) *lost = n; });
        return spans;
    }
}

TEST_CASE("idle-line bursts are delivered as they arrive; an empty report changes nothing") {
    Fa::DmaRing<uint8_t, 16> ring;
    FakeDma<16> dma{ring};
    dma.write(3);
    CHECK(dma.report());              // first data: wake the consumer
    dma.write(5);
    CHECK_FALSE(dma.report());        // consumer has not caught up: no second wake-up needed
    CHECK_FALSE(dma.report());        // idle line again, no new data
    auto spans = consume(ring);
    REQUIRE(spans.size() == 1);
    CHECK(spans[0] == bytes{0, 1, 2, 3, 4, 5, 6, 7});
}

TEST_CASE("data across the end of the buffer arrives as two spans") {
    Fa::DmaRing<uint8_t, 8> ring;
    FakeDma<8> dma{ring};
    dma.write(6);
    dma.report();
    consume(ring);
    dma.write(5);                     // positions 6, 7, then 0, 1, 2
    dma.report();
    auto spans = consume(ring);
    REQUIRE(spans.size() == 2);
    CHECK(spans[0] == bytes{6, 7});
    CHECK(spans[1] == bytes{8, 9, 10});
}

TEST_CASE("fixed blocks: half and complete reports give half-buffer blocks, intact when consumed in time") {
    Fa::DmaRing<uint8_t, 8> ring;
    FakeDma<8> dma{ring};
    bool intact = false;

    dma.write(4);
    dma.report();                     // half transfer
    ring.consume_available([&](uint8_t const *d, size_t n) { CHECK(bytes(d, d + n) == bytes{0, 1, 2, 3}); intact = ring.span_intact(); },
                           [](size_t) {});
    CHECK(intact);

    dma.write(4);
    dma.report();                     // transfer complete
    ring.consume_available([&](uint8_t const *d, size_t n) { CHECK(bytes(d, d + n) == bytes{4, 5, 6, 7}); intact = ring.span_intact(); },
                           [](size_t) {});
    CHECK(intact);
    CHECK(ring.overruns() == 0);
}

TEST_CASE("a block overwritten while being consumed is reported as not intact") {
    Fa::DmaRing<uint8_t, 8> ring;
    FakeDma<8> dma{ring};
    dma.write(4);
    dma.report();
    bool intact_at_end = true;
    ring.consume_available([&](uint8_t const *, size_t) {
        dma.write(4);                 // the DMA fills the other half and completes: it now overwrites this block
        dma.report();
        intact_at_end = ring.span_intact();
    }, [](size_t) {});
    CHECK_FALSE(intact_at_end);
    CHECK(ring.overruns() == 1);
}

TEST_CASE("a consumer lapped by the DMA gets on_overrun, discards the data and resynchronises") {
    Fa::DmaRing<uint8_t, 8> ring;
    FakeDma<8> dma{ring};
    for (int i = 0; i < 3; ++i) {     // 12 elements, nobody consuming: more than the buffer holds
        dma.write(4);
        dma.report();
    }
    size_t lost = 0;
    auto spans = consume(ring, &lost);
    CHECK(spans.empty());
    CHECK(lost == 12);
    CHECK(ring.overruns() == 1);

    dma.write(2);
    dma.report();
    spans = consume(ring);
    REQUIRE(spans.size() == 1);
    CHECK(spans[0] == bytes{12, 13});   // back in step with the stream
}

namespace {
    struct Notification {
        std::mutex m;
        std::condition_variable cv;
        bool pending = false;
        void give() {
            { std::lock_guard<std::mutex> lock(m); pending = true; }
            cv.notify_one();
        }
        // wait_until with system_clock: GCC 11's ThreadSanitizer does not intercept pthread_cond_clockwait
        bool take(std::chrono::milliseconds timeout) {
            std::unique_lock<std::mutex> lock(m);
            const bool got = cv.wait_until(lock, std::chrono::system_clock::now() + timeout, [&] { return pending; });
            pending = false;
            return got;
        }
    };
}

TEST_CASE("threaded: a DMA thread writing in bursts and a consumer; every byte once, in order, intact") {
    constexpr size_t N = 64;
    Fa::DmaRing<uint8_t, N> ring;
    Notification wake;
    std::atomic<bool> done{false};
    uint64_t received = 0, wrong = 0, not_intact = 0, lost_wakeups = 0;

    std::thread consumer([&] {
        uint8_t expected = 0;
        for (;;) {
            while (ring.available() > 0) {
                ring.consume_available([&](uint8_t const *d, size_t n) {
                    for (size_t i = 0; i < n; ++i, ++received) {
                        if (d[i] != expected) ++wrong;
                        expected = static_cast<uint8_t>(d[i] + 1);
                    }
                    if (!ring.span_intact()) ++not_intact;
                }, [&](size_t) { ++not_intact; });
            }
            if (done.load() && ring.available() == 0) return;
            if (!wake.take(std::chrono::milliseconds(200)) && ring.available() > 0 && !done.load()) ++lost_wakeups;
        }
    });

    // The DMA side: bursts of 1..N/4 bytes, each followed by a position report. It never gets more than N/2
    // ahead of the consumer (a real system meets this by consuming in time; here it is enforced so the
    // stress test exercises the protocol, not deliberate overruns, which the tests above cover).
    std::mt19937 rng(7);
    FakeDma<N> dma{ring};
    const uint64_t total = 500000;
    uint64_t sent = 0;
    while (sent < total) {
        const size_t burst = 1 + rng() % (N / 4);
        while (ring.available() + burst > N / 2) std::this_thread::yield();
        dma.write(burst);
        sent += burst;
        if (dma.report()) wake.give();
        if (rng() % 32 == 0) std::this_thread::sleep_for(std::chrono::microseconds(rng() % 50));
    }
    done.store(true);
    wake.give();
    consumer.join();

    CHECK(received == sent);
    CHECK(wrong == 0);
    CHECK(not_intact == 0);
    CHECK(lost_wakeups == 0);
    CHECK(ring.overruns() == 0);
}
