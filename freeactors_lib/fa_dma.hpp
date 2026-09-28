#ifndef FA_DMA_HPP
#define FA_DMA_HPP

// ==========================================================================
// Continuous (circular) DMA reception ring (docs/design/dma.md, section 3). The core of
// Fa::DmaRingInterface; no FreeRTOS dependency, so host tests can script DMA positions.
//
// The DMA hardware writes the buffer continuously. The board's interrupt (half transfer, transfer
// complete, and e.g. UART idle line) reports the DMA's write position; progress() turns positions into
// `written`, the consumer takes spans in place and releases them (`consumed`). Same counters and
// lost-wake-up-free protocol as Fa::SpscRing (fa_spsc.hpp).
//
// Assumptions: at least two position reports per lap (half/complete interrupts guarantee it), and
// interrupts are serviced within half a buffer period. The hardware may then be up to N/2 elements ahead
// of the last reported position, which is what span_intact() allows for.
//
// Overruns (the hardware cannot be refused):
//   - more than N elements unread when the consumer starts: the DMA lapped it. All unread data is
//     discarded (consumed := written), on_overrun(lost) is called, counted.
//   - a span overwritten while being consumed: span_intact() turns false (checked by the consumer before
//     acting on its result), counted after the span is released.
// ==========================================================================

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <type_traits>

// Place DMA buffers in DMA-capable memory, e.g. #define FA_DMA_BUFFER __attribute__((section(".dma_ram")))
// (on STM32F4 the CCM RAM is not reachable by DMA). Empty by default.
#ifndef FA_DMA_BUFFER
#define FA_DMA_BUFFER
#endif

namespace Fa {

template <typename T, size_t N>
class DmaRing {
    static_assert(N >= 2, "DmaRing needs at least two elements (half and complete interrupts)");
    static_assert(std::is_trivially_copyable_v<T>, "DMA elements must be trivially copyable");

public:
    T *buffer() { return buffer_.data(); }
    static constexpr size_t size = N;

    // ---- Producer side: the DMA interrupt (exactly one) ----

    // position: the DMA's write index in the buffer (0 <= position < N). Sets wake if the consumer may be
    // sleeping and must be notified. A report equal to the previous one (e.g. an idle-line interrupt with
    // no new data) changes nothing.
    void progress(size_t position, bool &wake) {
        position %= N;
        const size_t delta = (position + N - last_position_) % N;
        last_position_ = position;
        wake = false;
        if (delta == 0) {
            return;
        }
        const uint32_t before = written_.load(std::memory_order_relaxed);   // only the producer writes it
        const uint32_t w = before + static_cast<uint32_t>(delta);
        written_.store(w, std::memory_order_seq_cst);

        const uint32_t caught_up = consumed_.load(std::memory_order_seq_cst);
        wake = (caught_up == before);
        const size_t fill = w - caught_up;
        if (fill > high_water_.load(std::memory_order_relaxed)) {
            high_water_.store(fill, std::memory_order_relaxed);
        }
    }

    // ---- Consumer side (exactly one consumer) ----

    size_t available() const {
        return written_.load(std::memory_order_seq_cst) - consumed_.load(std::memory_order_relaxed);
    }

    // Hands the available data to f(T const *data, size_t n) as at most two spans (ring wrap), then
    // releases it. If the DMA already lapped the consumer, calls on_overrun(lost) instead and discards all
    // unread data. Returns the number of elements consumed or discarded.
    template <typename F, typename OnOverrun>
    size_t consume_available(F &&f, OnOverrun &&on_overrun) {
        const uint32_t c = consumed_.load(std::memory_order_relaxed);
        const uint32_t w = written_.load(std::memory_order_acquire);
        const size_t n = w - c;
        if (n == 0) {
            return 0;
        }
        if (n > N) {
            overruns_.store(overruns_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
            consumed_.store(w, std::memory_order_seq_cst);
            on_overrun(n);
            return n;
        }
        span_start_ = c;
        const size_t first = c % N;
        const size_t before_wrap = (n < N - first) ? n : N - first;
        f(&buffer_[first], before_wrap);
        if (n > before_wrap) {
            f(&buffer_[0], n - before_wrap);
        }
        if (!span_intact()) {
            overruns_.store(overruns_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
        }
        consumed_.store(w, std::memory_order_seq_cst);
        return n;
    }

    // During consume_available: true while the DMA cannot have reached the first element of the data being
    // consumed, allowing for up to N/2 elements written since the last reported position.
    bool span_intact() const {
        return written_.load(std::memory_order_acquire) - span_start_ <= N / 2;
    }

    uint32_t overruns() const { return overruns_.load(std::memory_order_relaxed); }
    size_t high_water() const { return high_water_.load(std::memory_order_relaxed); }

private:
    alignas(32) std::array<T, N> buffer_{};   // 32: a Cortex-M7 cache line, so invalidation never spills over
    size_t last_position_ = 0;               // producer only
    uint32_t span_start_ = 0;                // consumer only
    std::atomic<uint32_t> written_{0};
    std::atomic<uint32_t> consumed_{0};
    std::atomic<uint32_t> overruns_{0};
    std::atomic<size_t> high_water_{0};
};

} // namespace Fa

#endif // FA_DMA_HPP
