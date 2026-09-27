#ifndef FA_TRACE_SERVICE_HPP
#define FA_TRACE_SERVICE_HPP

// ==========================================================================
// Fa::TraceService — sends the application's trace to the PC (docs/design/trace.md, sections 2 and 4).
//
// Register it as a module and define FA_TRACE:
//   using Application = Fa::Application<Traits, MyMachine::Actor, Fa::TraceService>;
//
// Output policy (default: the board, Hw) must provide:
//   static void trace_write(uint8_t const *data, size_t n) noexcept;  // may block: called from the trace task
//   static uint32_t trace_timestamp() noexcept;                       // any context, including interrupts
//   static uint32_t trace_timestamp_hz() noexcept;                    // sent to the PC in HELLO
// A different transport without touching the board:
//   template <typename Hw, typename Ctx> using MyTrace = Fa::TraceService<Hw, Ctx, MyOut>;
//
// Frames sent: HELLO at start-up and again every 256 RECORDS frames (so a PC that starts listening later
// still learns the clock and actor names), RECORDS (up to 31 records each), LOST after the buffer overflowed.
// The trace task runs at the lowest application priority (TimeServiceTraits below).
// ==========================================================================

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "fa_common.hpp"
#include "fa_frame.hpp"
#include "fa_freertos.hpp"

namespace Fa {

namespace trace_frame {
    constexpr uint8_t ProtocolVersion = 1;
    constexpr uint8_t Hello   = 0x01;
    constexpr uint8_t Records = 0x02;
    constexpr uint8_t Lost    = 0x03;
    constexpr uint8_t States  = 0x04;
    constexpr uint8_t Ack     = 0x05;
    constexpr size_t RecordsPerFrame = 31;   // 1 + 31 * 8 = 249 bytes <= frame::MaxBody
}

namespace detail {
    template <typename Out, typename = void>
    struct has_trace_write : std::false_type {};
    template <typename Out>
    struct has_trace_write<Out, std::void_t<decltype(Out::trace_write(std::declval<uint8_t const *>(), size_t{}))>>
        : std::true_type {};

    template <typename Out, typename = void>
    struct has_trace_timestamp : std::false_type {};
    template <typename Out>
    struct has_trace_timestamp<Out, std::void_t<decltype(Out::trace_timestamp()), decltype(Out::trace_timestamp_hz())>>
        : std::true_type {};

    inline void put_u32(uint8_t *p, uint32_t v) {
        p[0] = static_cast<uint8_t>(v);
        p[1] = static_cast<uint8_t>(v >> 8);
        p[2] = static_cast<uint8_t>(v >> 16);
        p[3] = static_cast<uint8_t>(v >> 24);
    }
}

template <typename Hw, typename Ctx, typename Out = Hw, size_t N = 128>
struct TraceService;

template <typename Hw, typename Ctx, typename Out, size_t N>
struct TimeServiceTraits<TraceService<Hw, Ctx, Out, N>> {
    static constexpr const char* name     = "FaTrace";
    static constexpr size_t stack_size    = 256;   // words: frame buffers live on this stack
    static constexpr UBaseType_t priority = 1;     // lowest application priority: uses otherwise idle time
};

template <typename Hw, typename Ctx, typename Out, size_t N>
struct TraceService : MpscServiceInterface<TraceService<Hw, Ctx, Out, N>, TraceRecord, N> {
    using Base = MpscServiceInterface<TraceService<Hw, Ctx, Out, N>, TraceRecord, N>;

    static_assert(detail::has_trace_write<Out>::value,
        "TraceService output must define: static void trace_write(uint8_t const *data, size_t n) noexcept");
    static_assert(detail::has_trace_timestamp<Out>::value,
        "TraceService output must define: static uint32_t trace_timestamp() noexcept and "
        "static uint32_t trace_timestamp_hz() noexcept");

    // Trace overflow is expected under load: it is reported to the PC as LOST, not treated as an error.
    static constexpr bool assert_on_full = false;

    // Run-time filter (all on by default): bit n of kinds_mask = TraceKind n, bit n of actors_mask = actor n.
    // Records from non-actor senders (interrupts, timers, PC) pass the actor filter.
    static inline uint32_t kinds_mask = 0xFFFFFFFFu;
    static inline uint32_t actors_mask = 0xFFFFFFFFu;

    static bool enabled(TraceKind kind, uint8_t actor) {
        const bool kind_on = (kinds_mask >> static_cast<uint8_t>(kind)) & 1u;
        const bool actor_on = actor >= 32 || ((actors_mask >> actor) & 1u);
        return kind_on && actor_on;
    }

    static void record(TraceKind kind, uint8_t actor, uint16_t id) {
        if (enabled(kind, actor)) {
            Base::push(TraceRecord{Out::trace_timestamp(), static_cast<uint8_t>(kind), actor, id});
        }
    }

    static void record_from_isr(TraceKind kind, uint8_t actor, uint16_t id, BaseType_t *woken) {
        if (enabled(kind, actor)) {
            Base::push_from_isr(TraceRecord{Out::trace_timestamp(), static_cast<uint8_t>(kind), actor, id}, woken);
        }
    }

    // ---- Consumer side (the trace task) -----------------------------------------------------------------

    static void on_start() noexcept {
        send_hello();
    }

    static void consume_batch(TraceRecord const *records, size_t n) noexcept {
        report_lost();
        while (n > 0) {
            if (sequence_ == 0 && sent_first_records_) {
                send_hello();                              // periodic HELLO for late listeners
            }
            sent_first_records_ = true;
            const size_t count = n < trace_frame::RecordsPerFrame ? n : trace_frame::RecordsPerFrame;
            uint8_t body[1 + trace_frame::RecordsPerFrame * sizeof(TraceRecord)];
            body[0] = sequence_++;
            for (size_t i = 0; i < count; ++i) {
                uint8_t *p = body + 1 + i * sizeof(TraceRecord);
                detail::put_u32(p, records[i].timestamp);
                p[4] = records[i].kind;
                p[5] = records[i].actor;
                p[6] = static_cast<uint8_t>(records[i].id);
                p[7] = static_cast<uint8_t>(records[i].id >> 8);
            }
            send(trace_frame::Records, body, 1 + count * sizeof(TraceRecord));
            records += count;
            n -= count;
        }
    }

private:
    static void send(uint8_t type, uint8_t const *body, size_t n) {
        uint8_t wire[frame::MaxEncoded];
        const size_t length = frame::encode(type, body, n, wire);
        if (length > 0) {
            Out::trace_write(wire, length);
        }
    }

    // HELLO: protocol version, timestamp frequency, and every actor's name and model hash
    static void send_hello() {
        uint8_t body[frame::MaxBody];
        size_t n = 0;
        body[n++] = trace_frame::ProtocolVersion;
        detail::put_u32(body + n, Out::trace_timestamp_hz());
        n += 4;
        body[n++] = static_cast<uint8_t>(Ctx::actor_count());
        for (size_t a = 0; a < Ctx::actor_count(); ++a) {
            char const *name = Ctx::actor_name(a);
            size_t length = 0;
            while (name[length] != '\0' && length < 32) ++length;
            if (n + 1 + length + 4 > frame::MaxBody) break;   // HELLO is one frame: very many actors are cut off
            body[n++] = static_cast<uint8_t>(length);
            for (size_t i = 0; i < length; ++i) body[n++] = static_cast<uint8_t>(name[i]);
            detail::put_u32(body + n, Ctx::actor_model_hash(a));
            n += 4;
        }
        send(trace_frame::Hello, body, n);
    }

    // LOST: records dropped since the previous report (the gap marker)
    static void report_lost() {
        const uint32_t dropped = Base::dropped();
        if (dropped != reported_lost_) {
            uint8_t body[4];
            detail::put_u32(body, dropped - reported_lost_);
            send(trace_frame::Lost, body, sizeof(body));
            reported_lost_ = dropped;
        }
    }

    static inline uint8_t sequence_ = 0;
    static inline bool sent_first_records_ = false;
    static inline uint32_t reported_lost_ = 0;
};

} // namespace Fa

#endif // FA_TRACE_SERVICE_HPP
