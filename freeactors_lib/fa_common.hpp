#pragma once
#ifndef FA_COMMON_HPP
#define FA_COMMON_HPP

#include <cstddef>
#include <cstdint>

namespace Fa{
    enum class Status {
        Handled,
        Ignored,
        Transitioned
    };
    // Base marker for the top-level absolute root state
    struct None {
        template <typename M, typename E>
        static Status Dispatch(M&, E const&) { return Status::Ignored; }
    };



    // Standard uniform function pointer type for the runtime execution engine
    template<typename M, typename E>
    using HandlerRef = Status (*) (M &, E const &);


    struct Enter_sig {};
    struct Exit_sig  {};
    struct Init_sig  {};
    struct ExitToParent_sig {};

    template <typename E>
    struct EventDescriptor;

    template <> struct EventDescriptor<Enter_sig> { static constexpr const char* name = "Enter_sig"; };
    template <> struct EventDescriptor<Exit_sig> { static constexpr const char* name = "Exit_sig"; };
    template <> struct EventDescriptor<Init_sig> { static constexpr const char* name = "Init_sig"; };
    template <> struct EventDescriptor<ExitToParent_sig> { static constexpr const char* name = "ExitToParent_sig"; };

    template<typename M>
    struct HsmTraits;

    template <typename E>
    struct StateDescriptor;

    template <typename E>
    struct GuardDescriptor;

    template <typename E>
    struct ActionDescriptor;

    template <typename A>
    struct ActorTraits;

    // Default actor context: routes nothing. Used standalone and as the target default for Ctx.
    // ----------------------------------------------------------------------
    // Trace records (docs/design/trace.md, section 2): 8 bytes, sent little-endian as-is.
    // ----------------------------------------------------------------------
    enum class TraceKind : uint8_t {
        Event         = 0,   // id: event index in the actor's Event variant
        GuardFalse    = 1,   // id: GuardDescriptor<G>::id
        GuardTrue     = 2,   // id: GuardDescriptor<G>::id
        Action        = 3,   // id: ActionDescriptor<A>::id
        Transition    = 4,   // id: src_state << 8 | dst_state (StateCatalog indices)
        Dropped       = 5,   // id: target_actor << 8 | event_index; actor = sender
        Post          = 6,   // id: target_actor << 8 | event_index; actor = sender
        TimerSchedule = 7,   // id: target_actor << 8 | event_index; actor = owner
        TimerCancel   = 8,   // id: target_actor << 8 | event_index; actor = owner
        HealthFault   = 9,   // actor = monitored module index; id: bit 15 previous run, bits 12-14 HealthFault,
                             //   bits 0-11 elapsed ms (capped at 4095)  (FA_HEALTH, docs/design/health.md)
        HealthReset   = 10,  // actor = TraceSender::Health; id: ResetCause of this start-up
    };

    struct TraceRecord {
        uint32_t timestamp;  // Out::trace_timestamp() (wraps; the PC unwraps it)
        uint8_t  kind;       // TraceKind
        uint8_t  actor;      // actor index in the Application, or a TraceSender id
        uint16_t id;
    };
    static_assert(sizeof(TraceRecord) == 8, "TraceRecord must be exactly 8 bytes");

    // Result of a command from the PC (trace.md section 4.2, ACK frame)
    enum class CommandStatus : uint8_t {
        Ok           = 0,
        UnknownActor = 1,
        UnknownEvent = 2,   // no such event index, or a reserved signal (Enter/Exit/Init/ExitToParent)
        PayloadSize  = 3,   // payload bytes do not match the event's size
        QueueFull    = 4,
        NotSupported = 5,   // unknown command, or not provided by the board (e.g. reset)
        BadFrame     = 6,
        NotAllowed   = 7,   // e.g. pausing the framework's own services
    };

    // Senders that are not actors (TraceRecord::actor of Post/Dropped records)
    namespace TraceSender {
        constexpr uint8_t Isr   = 0xFF;   // interrupt handler (postFromISR)
        constexpr uint8_t Timer = 0xFE;   // timer expiry
        constexpr uint8_t Pc    = 0xFD;   // PC command
        constexpr uint8_t Task  = 0xFC;   // non-actor code in a task: start-up code, periodic modules
        constexpr uint8_t Health = 0xFB;  // the health monitor (HealthReset records)
        constexpr uint8_t FirstInterrupt = 0xC0;   // 0xC0 + n: interrupt module n (names: INTERRUPTS frame)
        constexpr uint8_t MaxInterrupts  = 32;
    }

    //
    // Context interface (what Hsm::post/schedule/cancel/mpsc_push forward to):
    //   post<Sender>(evt)                             deliver evt to its receiving actor
    //   schedule<Owner>(evt, ms, periodic) -> bool    (re)start Owner's timer for evt's type; false if it can't
    //   cancel<Owner, Evt>()                          stop Owner's pending timer for Evt, if any
    //   mpsc_push(item) -> bool                       hand item to the service owning its type
    //   trace<M>(kind, id)                            record a trace event of machine M (FA_TRACE)
    struct NullContext {
        template <typename Owner, typename Evt>
        static bool schedule(Evt const& /*evt*/, uint16_t /*ms*/, bool /*periodic*/) {
            return false;
        }

        template <typename Owner, typename Evt>
        static void cancel() {}

        template <typename Sender, typename Evt>
        static void post(Evt const& /*evt*/) {}

        template <typename T>
        static bool mpsc_push(T const& /*item*/) {
            return false;
        }

        template <typename M>
        static void trace(TraceKind /*kind*/, uint16_t /*id*/) {}
    };

#ifdef FA_IDE
    // Seen only by the IDE (clangd defines FA_IDE through the generated .clangd), never compiled: what a module's
    // Ctx and an interrupt module's IsrCtx offer, as concrete types, so the editor completes Ctx:: and IsrCtx::
    // (in the module, Ctx is a template parameter, which an IDE cannot look into)
    namespace ide {
        struct Context {   // periodic modules and services (Application::AppContext)
            template <typename E> static void post(E const& event);       // to the actor accepting E
            template <typename T> static bool mpsc_push(T const& item);   // to the MPSC service owning T
            template <typename T> static bool spsc_push(T const& item);   // to the SPSC service owning T (its only producer)
        };
        struct IsrContext {   // interrupt modules (only what an interrupt may do)
            template <typename E> static void post(E const& event);       // to the actor accepting E
            template <typename T> static bool push(T const& item);        // to the SPSC or MPSC service owning T
            template <template <typename, typename> class S>
            static void stream(size_t position);                          // DMA ring service S: written up to position
            static void command_rx(size_t position);                      // the PC commands' receive DMA: written up to position
        };
    }
#endif
}

#endif