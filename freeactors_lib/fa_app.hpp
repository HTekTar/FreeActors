#pragma once
#ifndef FA_APP_HPP
#define FA_APP_HPP

#include <array>
#include <cstring>
#include <utility>
#include <variant>

#include "fa_util.hpp"
#include "fa_freertos.hpp"
#include "fa_timeEvent.hpp"
#ifdef FA_TRACE
#include "fa_trace_service.hpp"
#endif
#ifdef FA_TRACE_COMMANDS
#ifndef FA_TRACE
#error "FA_TRACE_COMMANDS needs FA_TRACE: command replies travel on the trace stream"
#endif
#include "fa_command_service.hpp"
#endif

namespace Fa {

struct DefaultAppTraits {
    static constexpr size_t MaxTimerPayloadSize = 16;   // bytes per pending timer (largest actor event variant)
    static constexpr size_t MaxTimers           = 16;   // pending timers across all actors

    // Trace (built in; only with FA_TRACE). Optional in your traits:
    //   using TraceOut = MyTransport;                        // where trace bytes go; default: Platform (the board)
    //   static constexpr size_t TraceBufferRecords = 256;    // trace buffer, 8 bytes per record; default: 128
    // Commands from the PC (built in; only with FA_TRACE_COMMANDS). Optional in your traits:
    //   using CommandIn = MyReceiver;                        // where command bytes come from; default: Platform
};

// The Ctx each module gets inside an Application: routes post/schedule/cancel/mpsc_push/trace to it.
template <typename App>
struct Context {
    template <typename Owner, typename E>
    static bool schedule(E const& evt, uint16_t ms, bool periodic) {
        return App::template schedule_from<Owner>(evt, ms, periodic);
    }

    template <typename Owner, typename E>
    static void cancel() {
        App::template cancel_from<Owner, E>();
    }

    template <typename Sender, typename E>
    static void post(E const& evt) {
        App::template post_from<Sender>(evt);
    }

    // Modules that are not actors (e.g. a button poller) post without a sender type.
    template <typename E>
    static void post(E const& evt) {
        App::post(evt);
    }

    template <typename T>
    static bool mpsc_push(T const& item) {
        return App::mpsc_push(item);
    }

    template <typename M>
    static void trace(TraceKind kind, uint16_t id) {
        App::trace_record(kind, App::template sender_id<M>, id);
    }

    // Reflection and trace control, for the built-in trace and command services
    static CommandStatus post_by_index(uint8_t actor, uint8_t event, uint8_t const* payload, size_t n) {
        return App::post_by_index(actor, event, payload, n);
    }
    static uint16_t state_of(size_t actor) { return App::state_of(actor); }
    static void trace_control(uint8_t kind, uint16_t id) { App::trace_control(kind, id); }
    static void set_trace_filter(uint32_t kinds, uint32_t actors) { App::set_trace_filter(kinds, actors); }

    // Application description, for services such as TraceService (HELLO frame)
    static constexpr size_t actor_count() { return App::actor_count; }
    static char const* actor_name(size_t i) { return App::actor_names[i]; }
    static uint32_t actor_model_hash(size_t i) { return App::actor_model_hashes[i]; }
};

namespace detail {
    // Marker senders for posts that do not come from an actor
    struct ExternalSender {};   // non-actor code in a task
    struct PcSender {};         // a command from the PC

    // AppTraits::CommandIn if given, else the board (Platform)
    template <typename Traits, typename = void>
    struct command_in_of { using type = typename Traits::Platform; };
    template <typename Traits>
    struct command_in_of<Traits, std::void_t<typename Traits::CommandIn>> { using type = typename Traits::CommandIn; };

    template <typename Evt>
    inline constexpr bool is_reserved_signal_v = std::is_same_v<Evt, Enter_sig> || std::is_same_v<Evt, Exit_sig> ||
                                                 std::is_same_v<Evt, Init_sig> || std::is_same_v<Evt, ExitToParent_sig>;

    // Predicate: module M is a service of kind Kind (MpscKind / SpscKind) for items of type T
    template <typename T, typename Kind>
    struct owns_items {
        template <typename M, typename = void>
        struct pred : std::false_type {};
        template <typename M>
        struct pred<M, std::void_t<typename M::element_type, typename M::service_kind>>
            : std::bool_constant<std::is_same_v<typename M::element_type, T> && std::is_same_v<typename M::service_kind, Kind>> {};
    };

    // AppTraits::TraceOut if given, else the board (Platform)
    template <typename Traits, typename = void>
    struct trace_out_of { using type = typename Traits::Platform; };
    template <typename Traits>
    struct trace_out_of<Traits, std::void_t<typename Traits::TraceOut>> { using type = typename Traits::TraceOut; };

    // AppTraits::TraceBufferRecords if given, else 128
    template <typename Traits, typename = void>
    struct trace_buffer_records_of { static constexpr size_t value = 128; };
    template <typename Traits>
    struct trace_buffer_records_of<Traits, std::void_t<decltype(Traits::TraceBufferRecords)>> {
        static constexpr size_t value = Traits::TraceBufferRecords;
    };

    template <typename M, typename = void>
    struct model_hash_of { static constexpr uint32_t value = 0; };
    template <typename M>
    struct model_hash_of<M, std::void_t<decltype(HsmTraits<M>::ModelHash)>> {
        static constexpr uint32_t value = HsmTraits<M>::ModelHash;
    };

    template <typename List>
    struct ActorTable;
    template <typename... As>
    struct ActorTable<TypeList<As...>> {
        static constexpr size_t count = sizeof...(As);
        static constexpr std::array<char const*, sizeof...(As)> names = { ActorTraits<As>::Name... };
        static constexpr std::array<uint32_t, sizeof...(As)> model_hashes = { model_hash_of<As>::value... };
    };
}

// Interrupt entry points (postFromISR, mpsc_push_from_isr, spsc_push_from_isr, dma_progress_from_isr, and
// on_tick_isr from the tick hook) call FreeRTOS "FromISR" functions: like any FreeRTOS FromISR API on
// Cortex-M, they may only be called from interrupts whose priority is at or below (numerically at or above)
// configMAX_SYSCALL_INTERRUPT_PRIORITY. Pass &woken and end the handler with portYIELD_FROM_ISR(woken).
template <typename AppTraits, template<typename, typename> class... Modules>
class Application {
public:
    struct AppContext: Context<Application>{};

    // The board, passed to every module as its HwPolicy
    using Hw = typename AppTraits::Platform;
    using AllModules = TypeList<Modules<Hw, AppContext>...>;
    using ActorList = typename filter_types<is_hsm_actor, AllModules>::type;
    using TimerService = TimeEventService<ActorList, AppTraits::MaxTimerPayloadSize, AppTraits::MaxTimers, Application>;
#ifdef FA_TRACE
    // Built-in trace service, like the timer service: FA_TRACE is the only switch
    using Tracer = TraceService<Hw, AppContext, typename detail::trace_out_of<AppTraits>::type,
                                detail::trace_buffer_records_of<AppTraits>::value>;
#endif
#ifdef FA_TRACE_COMMANDS
    // Built-in command service (commands from the PC): FA_TRACE_COMMANDS is the switch
    using Commander = CommandService<Hw, AppContext, typename detail::command_in_of<AppTraits>::type>;
#endif

    // Number of registered modules that accept event type Evt (routing requires exactly one)
    template <typename Evt>
    static constexpr size_t receivers_of = (static_cast<size_t>(actor_accepts_event_v<Modules<Hw, AppContext>, Evt>) + ... + 0);

    // Registered MPSC / SPSC services owning items of type T (routing requires exactly one)
    template <typename T>
    using services_for = typename filter_types<detail::owns_items<T, detail::MpscKind>::template pred, AllModules>::type;
    template <typename T>
    using spsc_services_for = typename filter_types<detail::owns_items<T, detail::SpscKind>::template pred, AllModules>::type;

    // Actors as the PC sees them: index = position in ActorList (also the timer and trace actor id)
    static constexpr size_t actor_count = detail::ActorTable<ActorList>::count;
    static constexpr auto actor_names = detail::ActorTable<ActorList>::names;
    static constexpr auto actor_model_hashes = detail::ActorTable<ActorList>::model_hashes;

    // Trace id of a sender: its actor index, or TraceSender::Task for non-actor code in a task
    template <typename S>
    static constexpr uint8_t sender_id = [] {
        if constexpr (std::is_same_v<S, detail::PcSender>) {
            return TraceSender::Pc;
        } else if constexpr (ListContains<S, ActorList>::value) {
            return static_cast<uint8_t>(type_id_v<S, ActorList>);
        } else {
            return TraceSender::Task;
        }
    }();

    static void init() {
        AppTraits::Platform::init();
#ifdef FA_TRACE
        Tracer::create_task();
#endif
#ifdef FA_TRACE_COMMANDS
        Commander::create_task();
#endif
        (init_module<Modules<Hw,AppContext>>(), ...);
    }

    static void start() {
        vTaskStartScheduler();
        for (;;) {}
    }

    // Call from vApplicationTickHook (configUSE_TICK_HOOK = 1): counts timers down and delivers expired ones.
    static void on_tick_isr() {
        TimerService::on_tick_isr();
        (notify_tick<Modules<Hw, AppContext>>(), ...);
    }

    // ---- Events ------------------------------------------------------------------------------------------

    // Every event goes through here: POST record, queue send (never blocking), DROPPED record if it was full.
    template <typename Sender, typename Evt>
    static void post_from(Evt const& evt) {
        check_route<Evt>();
        deliver<target_of<Evt>, Sender>(evt);
    }

    // From code that is not an actor (start-up code, periodic modules)
    template <typename Evt>
    static void post(Evt const& evt) {
        post_from<detail::ExternalSender>(evt);
    }

    template <typename Evt>
    static void postFromISR(Evt const& evt, BaseType_t* pxHigherPriorityTaskWoken) {
        check_route<Evt>();
        using Target = target_of<Evt>;
        using Storage = StaticActorStorage<Target>;
#ifndef FA_TRACE_NO_POST
        trace_record_isr(TraceKind::Post, TraceSender::Isr, event_id<Target, Evt>(), pxHigherPriorityTaskWoken);
#endif
        typename Target::EventType message = evt;
        if (xQueueSendFromISR(Storage::queueHandle, &message, pxHigherPriorityTaskWoken) != pdPASS) {
            trace_record_isr(TraceKind::Dropped, TraceSender::Isr, event_id<Target, Evt>(), pxHigherPriorityTaskWoken);
            Storage::on_queue_full();
        }
    }

    // ---- Reflection (commands from the PC) -----------------------------------------------------------------

    // Posts event number `event` (its index in the actor's Event variant) to actor number `actor`, rebuilt
    // from its bytes; the sender is recorded as the PC. Reserved signals cannot be posted.
    static CommandStatus post_by_index(uint8_t actor, uint8_t event, uint8_t const* payload, size_t n) {
        if (actor >= actor_count) {
            return CommandStatus::UnknownActor;
        }
        return post_by_index_in(ActorList{}, actor, event, payload, n);
    }

    // The actor's current (leaf) state: its index in the actor's StateCatalog
    static uint16_t state_of(size_t actor) {
        return actor < actor_count ? state_of_in(ActorList{}, actor) : 0xFFFFu;
    }

#ifdef FA_TRACE_COMMANDS
    // Board's UART interrupt, receive DMA (board provides rx_stream_start): the DMA has written up to position
    static void command_rx_progress_from_isr(size_t position, BaseType_t* pxHigherPriorityTaskWoken) {
        static_assert(Commander::uses_dma, "The command input has no rx_stream_start(): use command_rx_byte_from_isr");
        Commander::progress_from_isr(position, pxHigherPriorityTaskWoken);
    }

    // Board's UART interrupt, one byte at a time (no receive DMA)
    static void command_rx_byte_from_isr(uint8_t byte, BaseType_t* pxHigherPriorityTaskWoken) {
        static_assert(!Commander::uses_dma, "The command input uses receive DMA: use command_rx_progress_from_isr");
        Commander::push_from_isr(byte, pxHigherPriorityTaskWoken);
    }
#endif

    // ---- Timers ------------------------------------------------------------------------------------------

    // Timer for Evt owned by actor Owner (normally called via Hsm::schedule in an action).
    template <typename Owner, typename Evt>
    static bool schedule_from(Evt const& evt, uint16_t ms, bool periodic = false) {
        check_route<Evt>();
        using Target = target_of<Evt>;
#ifndef FA_TRACE_NO_POST
        trace_record(TraceKind::TimerSchedule, sender_id<Owner>, event_id<Target, Evt>());
#endif
        const bool armed = TimerService::template schedule<Owner, Target>(evt, ms, periodic);
        configASSERT(armed);   // timer pool full: increase MaxTimers in your AppTraits
        return armed;
    }

    template <typename Owner, typename Evt>
    static void cancel_from() {
        check_route<Evt>();
        using Target = target_of<Evt>;
#ifndef FA_TRACE_NO_POST
        trace_record(TraceKind::TimerCancel, sender_id<Owner>, event_id<Target, Evt>());
#endif
        TimerService::template cancel<Owner, Target, Evt>();
    }

    // From outside any actor (e.g. application start-up): the receiving actor owns the timer.
    template <typename Evt>
    static bool schedule(Evt const& evt, uint16_t ms, bool periodic = false) {
        return schedule_from<target_of<Evt>>(evt, ms, periodic);
    }

    template <typename Evt>
    static void cancel() {
        cancel_from<target_of<Evt>, Evt>();
    }

    // ---- MPSC services -----------------------------------------------------------------------------------

    template <typename T>
    static bool mpsc_push(T const& item) {
        static_assert(type_list_size_v<services_for<T>> > 0, "No registered MPSC service owns this item type");
        static_assert(type_list_size_v<services_for<T>> == 1, "Ambiguous: several MPSC services own this item type");
        return services_for<T>::FirstType::push(item);
    }

    template <typename T>
    static bool mpsc_push_from_isr(T const& item, BaseType_t* pxHigherPriorityTaskWoken) {
        static_assert(type_list_size_v<services_for<T>> > 0, "No registered MPSC service owns this item type");
        static_assert(type_list_size_v<services_for<T>> == 1, "Ambiguous: several MPSC services own this item type");
        return services_for<T>::FirstType::push_from_isr(item, pxHigherPriorityTaskWoken);
    }

    // ---- SPSC services (exactly one producer each) --------------------------------------------------------

    template <typename T>
    static bool spsc_push_from_isr(T const& item, BaseType_t* pxHigherPriorityTaskWoken) {
        static_assert(type_list_size_v<spsc_services_for<T>> > 0, "No registered SPSC service owns this item type");
        static_assert(type_list_size_v<spsc_services_for<T>> == 1, "Ambiguous: several SPSC services own this item type");
        return spsc_services_for<T>::FirstType::push_from_isr(item, pxHigherPriorityTaskWoken);
    }

    template <typename T>
    static bool spsc_push(T const& item) {
        static_assert(type_list_size_v<spsc_services_for<T>> > 0, "No registered SPSC service owns this item type");
        static_assert(type_list_size_v<spsc_services_for<T>> == 1, "Ambiguous: several SPSC services own this item type");
        return spsc_services_for<T>::FirstType::push(item);
    }

    // ---- DMA ring services (the DMA hardware is the producer) ------------------------------------------

    // From the board's DMA / UART interrupt: the DMA of Service has written up to position.
    template <template <typename, typename> class Service>
    static void dma_progress_from_isr(size_t position, BaseType_t* pxHigherPriorityTaskWoken) {
        using Registered = Service<Hw, AppContext>;
        static_assert(ListContains<Registered, AllModules>::value, "This DMA ring service is not registered in the Application");
        Registered::progress_from_isr(position, pxHigherPriorityTaskWoken);
    }

    // ---- Trace (FA_TRACE) --------------------------------------------------------------------------------

    // The trace service is built in; registering it as a module as well would start a second one
    static_assert(type_list_size_v<services_for<TraceRecord>> == 0,
        "Fa::TraceService is built into Fa::Application (enabled by FA_TRACE): remove it from the module list");

    static void trace_record(TraceKind kind, uint8_t actor, uint16_t id) {
#ifdef FA_TRACE
        Tracer::record(kind, actor, id);
#else
        (void)kind; (void)actor; (void)id;
#endif
    }

    // Control records for the trace task (replies to PC commands); nothing without FA_TRACE
    static void trace_control(uint8_t kind, uint16_t id) {
#ifdef FA_TRACE
        Tracer::control(kind, id);
#else
        (void)kind; (void)id;
#endif
    }

    static void set_trace_filter(uint32_t kinds, uint32_t actors) {
#ifdef FA_TRACE
        Tracer::kinds_mask = kinds;
        Tracer::actors_mask = actors;
#else
        (void)kinds; (void)actors;
#endif
    }

    static void trace_record_isr(TraceKind kind, uint8_t actor, uint16_t id, BaseType_t* pxHigherPriorityTaskWoken) {
#ifdef FA_TRACE
        Tracer::record_from_isr(kind, actor, id, pxHigherPriorityTaskWoken);
#else
        (void)kind; (void)actor; (void)id; (void)pxHigherPriorityTaskWoken;
#endif
    }

private:
    template <typename Evt>
    using target_of = find_actor_for_event_t<Evt, Modules<Hw, AppContext>...>;

    // Queues evt for actor Target: POST record, send (never blocking), DROPPED record if the queue was full.
    template <typename Target, typename Sender, typename Evt>
    static bool deliver(Evt const& evt) {
        using Storage = StaticActorStorage<Target>;
#ifndef FA_TRACE_NO_POST
        trace_record(TraceKind::Post, sender_id<Sender>, event_id<Target, Evt>());   // before the send: see trace.md 2.1.1
#endif
        typename Target::EventType message = evt;
        if (xQueueSend(Storage::queueHandle, &message, 0) != pdPASS) {
            trace_record(TraceKind::Dropped, sender_id<Sender>, event_id<Target, Evt>());
            Storage::on_queue_full();
            return false;
        }
        return true;
    }

    // Reflection tables: one function per (actor, event index), built at compile time
    template <typename A, size_t I>
    static CommandStatus post_alternative(uint8_t const* payload, size_t n) {
        using Evt = std::variant_alternative_t<I, typename A::EventType>;
        if constexpr (detail::is_reserved_signal_v<Evt>) {
            return CommandStatus::UnknownEvent;
        } else if constexpr (!std::is_trivially_copyable_v<Evt> || !std::is_default_constructible_v<Evt>) {
            return CommandStatus::NotSupported;
        } else {
            constexpr size_t expected = std::is_empty_v<Evt> ? 0 : sizeof(Evt);
            if (n != expected) {
                return CommandStatus::PayloadSize;
            }
            Evt evt{};
            if constexpr (expected > 0) {
                std::memcpy(static_cast<void*>(&evt), payload, expected);
            }
            return deliver<A, detail::PcSender>(evt) ? CommandStatus::Ok : CommandStatus::QueueFull;
        }
    }

    template <typename A, size_t... I>
    static CommandStatus post_to_actor(uint8_t event, uint8_t const* payload, size_t n, std::index_sequence<I...>) {
        using Fn = CommandStatus (*)(uint8_t const*, size_t);
        static constexpr Fn table[] = { &post_alternative<A, I>... };
        return event < sizeof...(I) ? table[event](payload, n) : CommandStatus::UnknownEvent;
    }

    template <typename A>
    static CommandStatus post_to_actor_entry(uint8_t event, uint8_t const* payload, size_t n) {
        return post_to_actor<A>(event, payload, n, std::make_index_sequence<std::variant_size_v<typename A::EventType>>{});
    }

    template <typename... As>
    static CommandStatus post_by_index_in(TypeList<As...>, uint8_t actor, uint8_t event, uint8_t const* payload, size_t n) {
        using Fn = CommandStatus (*)(uint8_t, uint8_t const*, size_t);
        static constexpr Fn table[] = { &post_to_actor_entry<As>... };
        return table[actor](event, payload, n);
    }

    template <typename A>
    static uint16_t state_of_actor() {
        return StaticActorStorage<A>::instance.state_id;
    }

    template <typename... As>
    static uint16_t state_of_in(TypeList<As...>, size_t actor) {
        using Fn = uint16_t (*)();
        static constexpr Fn table[] = { &state_of_actor<As>... };
        return table[actor]();
    }

    // Single-receiver rule, checked first so it is the error a designer sees
    template <typename Evt>
    static constexpr void check_route() {
        static_assert(receivers_of<Evt> > 0, "Routing Error: No registered actor accepts this event type!");
        static_assert(receivers_of<Evt> < 2, "Routing Error: Ambiguous event recipient! Multiple actors accept this type.");
    }

    // Trace id of an event: target actor index << 8 | index in the target's event variant
    template <typename Target, typename Evt>
    static constexpr uint16_t event_id() {
        return static_cast<uint16_t>((type_id_v<Target, ActorList> << 8) | get_index_v<Evt, typename Target::EventType>);
    }

    template <typename M>
    static void init_module() {
        if constexpr (is_hsm_actor_v<M>) {
            using Storage = StaticActorStorage<M>;
            using Traits  = ActorTraits<M>;
            using EvtType = typename M::EventType;

            Storage::queueHandle = xQueueCreateStatic(
                Traits::QueueLength,
                sizeof(EvtType),
                Storage::queueStorage,
                &Storage::queueControlBlock
            );

            Storage::taskHandle = xTaskCreateStatic(
                Storage::taskLoop,
                Traits::Name,
                Traits::StackDepthWords,
                nullptr,
                Traits::Priority,
                Storage::taskStack,
                &Storage::taskControlBlock
            );
        } else if constexpr (is_time_service_v<M>) {
            M::create_task();   // periodic process module (TimeServiceInterface) or MPSC service
        }
    }

    template <typename M>
    static void notify_tick() {
        if constexpr (has_tick_hook_v<M>) {
            M::on_tick_isr();
        }
    }
};

} // namespace Fa

#endif //FA_APP_HPP
