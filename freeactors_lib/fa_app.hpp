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
#include "fa_interrupt.hpp"
#ifdef FA_TRACE
#include "fa_trace_service.hpp"
#endif
#ifdef FA_TRACE_COMMANDS
#ifndef FA_TRACE
#error "FA_TRACE_COMMANDS needs FA_TRACE: command replies travel on the trace stream"
#endif
#include "fa_command_service.hpp"
#endif
#ifdef FA_DEBUG_COMMANDS
#ifndef FA_TRACE_COMMANDS
#error "FA_DEBUG_COMMANDS needs FA_TRACE_COMMANDS: it unlocks commands from the PC (pause, resume, health test, reset)"
#endif
#endif
#ifdef FA_HEALTH
#include "fa_health_monitor.hpp"
#endif
#if defined(FA_HEALTH) || defined(FA_DEBUG_COMMANDS)
#define FA_TASK_TABLE   // the table of framework tasks (health monitor, pause commands)
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
    // Health monitor and watchdog manager (built in; only with FA_HEALTH). Optional in your traits:
    //   static constexpr size_t HealthCheckMs = 100;         // how often every task is checked; default: 100
    //   static constexpr uint32_t MaxStepMs = 500;           // default budget per step for every task; default: 500
    //   static constexpr uint32_t WatchdogTimeoutMs = 1000;  // >= 3 x HealthCheckMs; default: 1000
    //   using Watchdog = MyWatchdog;                         // watchdog_start/kick, reset_cause; default: Platform
    //   static void on_health_fault(uint8_t task, Fa::HealthFault fault, uint32_t elapsed_ms) noexcept;   // e.g. safe outputs
    // Per task (ActorTraits<A> or TimeServiceTraits<S>): MaxStepMs (override), MaxIdleMs (opt-in idle check).
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

    // To the SPSC service owning T (exactly one, and this task its only producer)
    template <typename T>
    static bool spsc_push(T const& item) {
        return App::spsc_push(item);
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

    // Health (FA_HEALTH): records with a raw actor field, the HEALTH reply, monitored task names
    static void trace_raw(TraceKind kind, uint8_t actor, uint16_t id) { App::trace_record(kind, actor, id); }
    static constexpr bool health_enabled = App::health_enabled;
    static size_t health_report(uint8_t* out, size_t max) { return App::health_report(out, max); }
    static constexpr size_t module_count() { return App::watched_count; }
    // Interrupt modules (trace sender 0xC0 + n, INTERRUPTS frame)
    static constexpr size_t interrupt_count() { return App::interrupt_count; }
    static char const* interrupt_name(size_t i) { return App::interrupt_name(i); }
    static int interrupt_irq(size_t i) { return App::interrupt_irq(i); }
#ifdef FA_DEBUG_COMMANDS
    static CommandStatus pause_task(uint8_t task) { return App::control_task(task, App::TaskControl::Pause); }
    static CommandStatus resume_task(uint8_t task) { return App::control_task(task, App::TaskControl::Resume); }
    static CommandStatus health_test_task(uint8_t task) { return App::control_task(task, App::TaskControl::HealthTest); }
#endif
    static char const* module_name(size_t i) { return App::watched_name(i); }

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

    // Optional numeric settings: Traits::Name if present, else Default
#define FA_OPTIONAL_SETTING(Name, Type)                                                                 \
    template <typename Traits, Type Default, typename = void>                                         \
    struct Name##_of { static constexpr Type value = Default; };                                       \
    template <typename Traits, Type Default>                                                           \
    struct Name##_of<Traits, Default, std::void_t<decltype(Traits::Name)>> {                           \
        static constexpr Type value = static_cast<Type>(Traits::Name);                                 \
    };
    FA_OPTIONAL_SETTING(HealthCheckMs, size_t)
    FA_OPTIONAL_SETTING(MaxStepMs, uint32_t)
    FA_OPTIONAL_SETTING(MaxIdleMs, uint32_t)
    FA_OPTIONAL_SETTING(WatchdogTimeoutMs, uint32_t)
#undef FA_OPTIONAL_SETTING

    // AppTraits::Watchdog if given, else the board (Platform)
    template <typename Traits, typename = void>
    struct watchdog_of { using type = typename Traits::Platform; };
    template <typename Traits>
    struct watchdog_of<Traits, std::void_t<typename Traits::Watchdog>> { using type = typename Traits::Watchdog; };

    template <typename Traits, typename = void>
    struct has_health_hook : std::false_type {};
    template <typename Traits>
    struct has_health_hook<Traits, std::void_t<decltype(Traits::on_health_fault(uint8_t{}, HealthFault{}, uint32_t{}))>>
        : std::true_type {};

    template <typename M, typename = void>
    struct is_periodic_module : std::false_type {};
    template <typename M>
    struct is_periodic_module<M, std::void_t<decltype(M::period_ms)>> : std::true_type {};

    template <typename M, typename = void>
    struct model_hash_of { static constexpr uint32_t value = 0; };
    template <typename M>
    struct model_hash_of<M, std::void_t<decltype(HsmTraits<M>::ModelHash)>> {
        static constexpr uint32_t value = HsmTraits<M>::ModelHash;
    };

#ifdef FA_TASK_TABLE
    // Every task the framework runs: actors, then services and periodic modules, then built-in services
    template <typename AppTraits>
    struct TaskTable {
        static constexpr uint32_t ms_ticks(uint32_t ms) { return ms == 0 ? 0 : static_cast<uint32_t>(ms_to_ticks_clamped(ms)); }
        static constexpr uint32_t default_step_ms = MaxStepMs_of<AppTraits, 500>::value;

        template <typename A>
        static constexpr TaskEntry actor_entry() {
            using Storage = StaticActorStorage<A>;
            constexpr uint32_t step = MaxStepMs_of<ActorTraits<A>, default_step_ms>::value;
            constexpr uint32_t idle = MaxIdleMs_of<ActorTraits<A>, 0>::value;
            return TaskEntry{ &Storage::health_probe, &Storage::pause_gate, &Storage::health_pending, &Storage::health_task,
                              ActorTraits<A>::Name, HealthLimits{ ms_ticks(step), ms_ticks(step), ms_ticks(idle) }, false };
        }

        template <typename S, bool Builtin>
        static constexpr TaskEntry service_entry() {
            using Traits = TimeServiceTraits<S>;
            constexpr uint32_t step = MaxStepMs_of<Traits, default_step_ms>::value;
            constexpr uint32_t idle = MaxIdleMs_of<Traits, 0>::value;
            // A periodic module must complete an iteration every period: allow three periods plus a step
            constexpr uint32_t stall = is_periodic_module<S>::value ? static_cast<uint32_t>(3 * period_of<S>()) + step : step;
            return TaskEntry{ &S::health_probe, &S::pause_gate, &S::health_pending, &S::health_task, Traits::name,
                              HealthLimits{ ms_ticks(step), ms_ticks(stall), ms_ticks(idle) }, Builtin };
        }

        template <typename S>
        static constexpr size_t period_of() {
            if constexpr (is_periodic_module<S>::value) return S::period_ms; else return 0;
        }

        template <typename... As, typename... Ss, typename... Bs>
        static constexpr auto make(TypeList<As...>, TypeList<Ss...>, TypeList<Bs...>) {
            return std::array<TaskEntry, sizeof...(As) + sizeof...(Ss) + sizeof...(Bs)>{
                actor_entry<As>()..., service_entry<Ss, false>()..., service_entry<Bs, true>()... };
        }
    };
#endif

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

    // Interrupt modules get this context instead of AppContext: only interrupt-safe operations
    struct IsrCtx : IsrContext<Application> {};

    // The board, passed to every module as its HwPolicy
    using Hw = typename AppTraits::Platform;

    // A module as the application instantiates it: interrupt modules with IsrCtx, all others with AppContext
    template <template <typename, typename> class M>
    using module_t = std::conditional_t<is_interrupt_module<M<Hw, AppContext>>::value, M<Hw, IsrCtx>, M<Hw, AppContext>>;

    using AllModules = TypeList<module_t<Modules>...>;
    using InterruptList = typename filter_types<is_interrupt_module, AllModules>::type;
    static constexpr size_t interrupt_count = type_list_size_v<InterruptList>;
    static_assert(interrupt_count <= TraceSender::MaxInterrupts, "At most 32 interrupt modules");

    // ---- Interrupt modules: what the vector table calls ------------------------------------------------------

    // Each interrupt module runs through this: the trace attributes its posts to it (0xC0 + n), and an
    // interrupt firing more often than its limit within one tick (a flag never cleared fires it back to back
    // and starves every task) is disabled and reported, instead of ending in an unexplained watchdog reset.
    template <typename I>
    static void run_interrupt() {
        constexpr uint8_t sender = static_cast<uint8_t>(TraceSender::FirstInterrupt + type_id_v<I, InterruptList>);
        constexpr uint32_t limit = detail::max_rate_of<I>::value / configTICK_RATE_HZ > 0
                                 ? detail::max_rate_of<I>::value / configTICK_RATE_HZ : 1;
        static uint32_t window_tick = 0;
        static uint32_t window_calls = 0;
        const uint32_t now = static_cast<uint32_t>(xTaskGetTickCountFromISR());
        if (now != window_tick) {
            window_tick = now;
            window_calls = 0;
        }
        if (++window_calls > limit) {
            I::disable();
            if (window_calls == limit + 1) {                 // report once
                interrupt_fault(sender, HealthFault::Storm, window_calls);
            }
            return;
        }
        const uint8_t outer = detail::current_isr_sender;
        detail::current_isr_sender = sender;
        I::handle();
        detail::current_isr_sender = outer;
    }

    // Every vector table slot without a module: disables that interrupt and records which one fired.
    // It may run at ANY priority (often 0, the reset default), so it must not call FreeRTOS: the health monitor
    // traces and reports the fault from its task; without the monitor, an assertion stops the program.
    static void unexpected_interrupt() {
#ifdef FA_CORTEX_M_NVIC
        uint32_t ipsr;
        __asm volatile("mrs %0, ipsr" : "=r"(ipsr));
        const int32_t irq = static_cast<int32_t>(ipsr & 0x1FFu) - 16;
        if (irq >= 0) {
            detail::nvic_icer()[irq >> 5] = 1u << (irq & 31);
        }
        detail::report_interrupt_fault(TraceSender::Isr, static_cast<uint8_t>(HealthFault::Unexpected),
                                       static_cast<uint16_t>(irq < 0 ? 0 : irq));
#ifndef FA_HEALTH
        FA_ASSERT(false /* an interrupt fired that is not in the application's vector table: see Fa::detail::interrupt_fault */);
#endif
#endif
    }

    static char const* interrupt_name(size_t i) { return interrupt_names_in(InterruptList{}, i); }
    static int interrupt_irq(size_t i) { return interrupt_irqs_in(InterruptList{}, i); }
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

    // Tasks the health monitor watches: actors (same indices as the trace), then periodic modules and
    // services in module order, then the built-in trace and command services
    using ServiceList = typename filter_types<is_time_service, AllModules>::type;
    using BuiltinServices = TypeList<
#ifdef FA_TRACE
        Tracer
#endif
#ifdef FA_TRACE_COMMANDS
        , Commander
#endif
    >;
#ifdef FA_TASK_TABLE
    // Every task the framework runs (index = health task index = MODULES frame order)
    static constexpr auto tasks = detail::TaskTable<AppTraits>::make(ActorList{}, ServiceList{}, BuiltinServices{});
    static constexpr size_t watched_count = tasks.size();
    static char const* watched_name(size_t i) { return i < watched_count ? tasks[i].name : ""; }
#else
    static constexpr size_t watched_count = 0;
    static char const* watched_name(size_t) { return ""; }
#endif
#ifdef FA_HEALTH
    static constexpr bool health_enabled = true;
    struct HealthConfig {
        static constexpr size_t check_ms = detail::HealthCheckMs_of<AppTraits, 100>::value;
        static constexpr uint32_t watchdog_timeout_ms = detail::WatchdogTimeoutMs_of<AppTraits, 1000>::value;
        using Board = typename detail::watchdog_of<AppTraits>::type;
        static constexpr auto entries = tasks;
        static void on_fault(uint8_t task, HealthFault fault, uint32_t elapsed_ms) {
            if constexpr (detail::has_health_hook<AppTraits>::value) {
                AppTraits::on_health_fault(task, fault, elapsed_ms);
            } else {
                (void)task; (void)fault; (void)elapsed_ms;
            }
        }
    };
    // Built-in health monitor and watchdog manager: FA_HEALTH is the switch
    using Monitor = HealthMonitor<Hw, AppContext, HealthConfig>;
    static size_t health_report(uint8_t* out, size_t max) { return Monitor::report(out, max); }
#else
    static constexpr bool health_enabled = false;
    static size_t health_report(uint8_t*, size_t) { return 0; }
#endif

#ifdef FA_DEBUG_COMMANDS
    // pause / resume / health test from the PC (FA_DEBUG_COMMANDS). The framework's own services are refused:
    // a paused command service could never receive the resume.
    enum class TaskControl : uint8_t { Pause, Resume, HealthTest };
    static CommandStatus control_task(uint8_t task, TaskControl op) {
        if (task >= watched_count) {
            return CommandStatus::UnknownActor;
        }
        TaskEntry const& e = tasks[task];
        if (e.builtin) {
            return CommandStatus::NotAllowed;
        }
        switch (op) {
            case TaskControl::Pause:
                e.gate->pause(PauseGate::Paused);
                return CommandStatus::Ok;
            case TaskControl::HealthTest:
                if constexpr (!health_enabled) {
                    return CommandStatus::NotSupported;
                }
                e.gate->pause(PauseGate::HealthTest);
                return CommandStatus::Ok;
            case TaskControl::Resume:
                e.gate->resume(e.task());
                return CommandStatus::Ok;
        }
        return CommandStatus::NotSupported;
    }
#endif

    // Number of registered modules that accept event type Evt (routing requires exactly one)
    template <typename Evt>
    static constexpr size_t receivers_of = (static_cast<size_t>(actor_accepts_event_v<module_t<Modules>, Evt>) + ... + 0);

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
        install_vector_table(InterruptList{});   // before anything can enable an interrupt
#ifdef FA_TRACE
        Tracer::create_task();
#endif
#ifdef FA_TRACE_COMMANDS
        Commander::create_task();
#endif
#ifdef FA_HEALTH
        Monitor::create_task();
#endif
        (init_module<module_t<Modules>>(), ...);
        enable_interrupts(InterruptList{});   // last: their handlers post to queues that now exist
    }

    static void start() {
        vTaskStartScheduler();
        for (;;) {}
    }

    // Call from vApplicationTickHook (configUSE_TICK_HOOK = 1): counts timers down and delivers expired ones.
    static void on_tick_isr() {
        TimerService::on_tick_isr();
        (notify_tick<module_t<Modules>>(), ...);
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
        trace_record_isr(TraceKind::Post, detail::current_isr_sender, event_id<Target, Evt>(), pxHigherPriorityTaskWoken);
#endif
        typename Target::EventType message = evt;
        if (xQueueSendFromISR(Storage::queueHandle, &message, pxHigherPriorityTaskWoken) != pdPASS) {
            trace_record_isr(TraceKind::Dropped, detail::current_isr_sender, event_id<Target, Evt>(), pxHigherPriorityTaskWoken);
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

    // From an interrupt: to the SPSC or MPSC service owning T (exactly one of either kind)
    template <typename T>
    static bool push_from_isr(T const& item, BaseType_t* pxHigherPriorityTaskWoken) {
        constexpr size_t spsc = type_list_size_v<spsc_services_for<T>>;
        constexpr size_t mpsc = type_list_size_v<services_for<T>>;
        static_assert(spsc + mpsc > 0, "No registered SPSC or MPSC service owns this item type");
        static_assert(spsc + mpsc == 1, "Ambiguous: several services own this item type");
        if constexpr (spsc == 1) {
            return spsc_services_for<T>::FirstType::push_from_isr(item, pxHigherPriorityTaskWoken);
        } else {
            return services_for<T>::FirstType::push_from_isr(item, pxHigherPriorityTaskWoken);
        }
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
    using target_of = find_actor_for_event_t<Evt, module_t<Modules>...>;

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

    // ---- Interrupt modules ----------------------------------------------------------------------------------

    // An interrupt storm (from run_interrupt, at the module's own, FreeRTOS-safe priority): traced at once; the
    // health monitor reports it and stops feeding the watchdog (FA_HEALTH); without the monitor, an assertion
    // stops the program in debug builds
    static void interrupt_fault(uint8_t module, HealthFault fault, uint32_t value) {
        detail::report_interrupt_fault(module, static_cast<uint8_t>(fault),
                                       static_cast<uint16_t>(value > 0xFFFFu ? 0xFFFFu : value));
        BaseType_t woken = pdFALSE;
        trace_record_isr(TraceKind::HealthFault, module, health_fault_id(fault, value, false), &woken);
#ifndef FA_HEALTH
        FA_ASSERT(false /* interrupt storm or unexpected interrupt: see Fa::detail::interrupt_fault */);
#endif
        FA_YIELD_FROM_ISR(woken);
    }

    template <typename... Is>
    static char const* interrupt_names_in(TypeList<Is...>, size_t i) {
        static constexpr char const* names[] = { detail::interrupt_name_of<Is>::value..., nullptr };
        return i < sizeof...(Is) ? names[i] : nullptr;
    }

    template <typename... Is>
    static int interrupt_irqs_in(TypeList<Is...>, size_t i) {
        static constexpr int irqs[] = { static_cast<int>(Is::IRQNum)..., -1 };
        return i < sizeof...(Is) ? irqs[i] : -1;
    }

    template <typename... Is>
    static void install_vector_table(TypeList<Is...>) {
        if constexpr (sizeof...(Is) > 0) {
            static_assert((Is::check() && ...));
            static_assert(detail::unique_irqs<Is...>(), "Two interrupt modules use the same IRQNum");
#ifdef FA_VECTOR_TABLE
            static_assert(detail::has_irq_count<Hw>::value,
                "The board must define static constexpr size_t irq_count (number of device interrupts): "
                "it sizes the vector table");
            static_assert(((static_cast<size_t>(Is::IRQNum) < Hw::irq_count) && ...),
                "An interrupt module's IRQNum is not below the board's irq_count");
            static_assert(detail::has_initial_stack<Hw>::value,
                "The board must define static constexpr void const* initial_stack: the initial stack pointer from "
                "the linker script (e.g. &_estack), which FreeRTOS reads through the vector table at start-up");
            detail::install_vector_table(detail::VectorTable<Hw, Application, 16 + Hw::irq_count, Is...>::table.data());
#elif defined(FA_CORTEX_M_NVIC)
            // FA_NO_VECTOR_TABLE: every module must be bound with FA_BIND_ISR (else: undefined reference)
            (detail::require_binding<Is>(), ...);
#endif
        }
    }

    template <typename... Is>
    static void enable_interrupts(TypeList<Is...>) {
        (Is::init(), ...);
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
