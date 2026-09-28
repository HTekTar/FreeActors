#ifndef FA_SPSC_HPP
#define FA_SPSC_HPP

// ==========================================================================
// Lock-free single-producer / single-consumer ring (docs/design/dma.md, sections 1 and 2).
// The core of Fa::SpscServiceInterface (and, later, of the DMA ring). No FreeRTOS dependency:
// the service supplies how the consumer is woken; host tests drive it with threads.
//
//   written  — elements published; advanced ONLY by the producer
//   consumed — elements released;  advanced ONLY by the consumer
// Both are monotonic 32-bit counters (available = written - consumed, correct across wrap-around);
// element k lives in slot k % N.
//
// Wake-up without lost notifications (the consumer sleeps when the ring is empty):
//   producer: publish (written, seq_cst)   then check consumed (seq_cst): caught up -> wake the consumer
//   consumer: release (consumed, seq_cst)  then check written (seq_cst) before going back to sleep
// With sequentially consistent ordering at least one side sees the other, so an item can never wait
// behind a sleeping consumer. A spurious wake-up is possible and harmless.
// ==========================================================================

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace Fa {

template <typename T, size_t N>
class SpscRing {
    static_assert(N > 0, "SpscRing needs at least one slot");
    static_assert(std::is_trivially_copyable_v<T>, "SPSC items must be trivially copyable");

public:
    // ---- Producer side (exactly one producer) ----

    // Copies item in. Returns false (and counts it) if the ring is full. Sets wake if the consumer may be
    // sleeping and must be notified.
    bool push(T const &item, bool &wake) {
        const uint32_t w = written_.load(std::memory_order_relaxed);   // only the producer writes it
        const uint32_t c = consumed_.load(std::memory_order_acquire);
        if (w - c >= N) {
            dropped_.store(dropped_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
            wake = false;
            return false;
        }
        slots_[w % N] = item;
        written_.store(w + 1, std::memory_order_seq_cst);                // publish

        const uint32_t caught_up = consumed_.load(std::memory_order_seq_cst);
        wake = (caught_up == w);                                          // consumer had nothing left before this item
        const size_t fill = (w + 1) - caught_up;
        if (fill > high_water_.load(std::memory_order_relaxed)) {
            high_water_.store(fill, std::memory_order_relaxed);
        }
        return true;
    }

    // ---- Consumer side (exactly one consumer) ----

    // Elements ready to consume (seq_cst: pairs with the producer's wake check).
    size_t available() const {
        return written_.load(std::memory_order_seq_cst) - consumed_.load(std::memory_order_relaxed);
    }

    // Hands up to two contiguous spans (before and after the wrap) of the currently available elements to
    // f(T const *data, size_t n), then releases them. Returns how many were consumed.
    template <typename F>
    size_t consume_available(F &&f) {
        const uint32_t c = consumed_.load(std::memory_order_relaxed);
        const size_t n = written_.load(std::memory_order_acquire) - c;
        if (n == 0) {
            return 0;
        }
        const size_t first = c % N;
        const size_t before_wrap = (n < N - first) ? n : N - first;
        f(&slots_[first], before_wrap);
        if (n > before_wrap) {
            f(&slots_[0], n - before_wrap);
        }
        consumed_.store(c + static_cast<uint32_t>(n), std::memory_order_seq_cst);   // release the slots
        return n;
    }

    uint32_t dropped() const { return dropped_.load(std::memory_order_relaxed); }
    size_t high_water() const { return high_water_.load(std::memory_order_relaxed); }

private:
    std::array<T, N> slots_{};
    std::atomic<uint32_t> written_{0};
    std::atomic<uint32_t> consumed_{0};
    std::atomic<uint32_t> dropped_{0};
    std::atomic<size_t> high_water_{0};
};

} // namespace Fa

#endif // FA_SPSC_HPP
