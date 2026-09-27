#pragma once
#ifndef FA_APP_HPP
#define FA_APP_HPP

#include "fa_util.hpp"
#include "fa_freertos.hpp"
#include "fa_timeEvent.hpp"

namespace Fa {

struct DefaultAppTraits {
    static constexpr size_t MaxTimerPayloadSize = 16;   // bytes per pending timer (largest actor event variant)
    static constexpr size_t MaxTimers           = 16;   // pending timers across all actors
};

// The Ctx each actor gets inside an Application: routes post/schedule/cancel to the application.
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

    template <typename E>
    static void post(E const& evt) {
        App::post(evt);
    }
};

template <typename AppTraits, template<typename, typename> class... Modules>
class Application {
public:
    struct AppContext: Context<Application>{};

    // The board, passed to every module as its HwPolicy
    using Hw = typename AppTraits::Platform;
    using AllModules = TypeList<Modules<Hw, AppContext>...>;
    using ActorList = typename filter_types<is_hsm_actor, AllModules>::type;
    using TimerService = TimeEventService<ActorList, AppTraits::MaxTimerPayloadSize, AppTraits::MaxTimers>;

    // Number of registered modules that accept event type Evt (routing requires exactly one)
    template <typename Evt>
    static constexpr size_t receivers_of = (static_cast<size_t>(actor_accepts_event_v<Modules<Hw, AppContext>, Evt>) + ... + 0);


    static void init() {
        AppTraits::Platform::init();
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

    template <typename Evt>
    static void post(Evt const& evt) {
        constexpr size_t matches = receivers_of<Evt>;

        static_assert(matches > 0, 
            "Routing Error: No registered actor accepts this event type!");
        static_assert(matches == 1, 
            "Routing Error: Ambiguous event recipient! Multiple actors accept this type.");

        (route_event<Modules<Hw, AppContext>>(evt), ...);
    }

    template <typename Evt>
    static void postFromISR(Evt const& evt, BaseType_t* pxHigherPriorityTaskWoken) {
        constexpr size_t matches = receivers_of<Evt>;

        static_assert(matches > 0, "Routing Error: No registered actor accepts this event type!");
        static_assert(matches == 1, "Routing Error: Ambiguous event recipient!");

        (route_event_isr<Modules<Hw, AppContext>>(evt, pxHigherPriorityTaskWoken), ...);
    }

    // Timer for Evt owned by actor Owner (normally called via Hsm::schedule in an action).
    template <typename Owner, typename Evt>
    static bool schedule_from(Evt const& evt, uint16_t ms, bool periodic = false) {
        constexpr size_t matches = receivers_of<Evt>;
        static_assert(matches > 0, "Routing Error: No registered actor accepts this timer event!");
        static_assert(matches == 1, "Routing Error: Ambiguous event recipient! Multiple actors accept this event type.");

        using Target = find_actor_for_event_t<Evt, Modules<Hw, AppContext>...>;
        const bool armed = TimerService::template schedule<Owner, Target>(evt, ms, periodic);
        configASSERT(armed);   // timer pool full: increase MaxTimers in your AppTraits
        return armed;
    }

    template <typename Owner, typename Evt>
    static void cancel_from() {
        using Target = find_actor_for_event_t<Evt, Modules<Hw, AppContext>...>;
        TimerService::template cancel<Owner, Target, Evt>();
    }

    // From outside any actor (e.g. application start-up): the receiving actor owns the timer.
    template <typename Evt>
    static bool schedule(Evt const& evt, uint16_t ms, bool periodic = false) {
        return schedule_from<find_actor_for_event_t<Evt, Modules<Hw, AppContext>...>>(evt, ms, periodic);
    }

    template <typename Evt>
    static void cancel() {
        cancel_from<find_actor_for_event_t<Evt, Modules<Hw, AppContext>...>, Evt>();
    }

private:
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
            M::create_task();   // periodic process module (TimeServiceInterface)
        }
    }

    template <typename M, typename Evt>
    static void route_event(Evt const& evt) {
        if constexpr (actor_accepts_event_v<M, Evt>) {
            using Storage = StaticActorStorage<M>;
            typename M::EventType variantMsg = evt;
            if (xQueueSend(Storage::queueHandle, &variantMsg, 0) != pdPASS) {   // never block the sender
                Storage::on_queue_full();
            }
        }
    }

    

    template <typename M, typename Evt>
    static void route_event_isr(Evt const& evt, BaseType_t* pxHigherPriorityTaskWoken) {
        if constexpr (actor_accepts_event_v<M, Evt>) {
            using Storage = StaticActorStorage<M>;
            typename M::EventType variantMsg = evt;
            if (xQueueSendFromISR(Storage::queueHandle, &variantMsg, pxHigherPriorityTaskWoken) != pdPASS) {
                Storage::on_queue_full();
            }
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