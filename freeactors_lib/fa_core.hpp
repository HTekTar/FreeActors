#ifndef FA_CORE_HPP
#define FA_CORE_HPP

#include <cstdint>
#include <type_traits>

// FreeActors' own checks: assert() in the simulator, configASSERT on target when the application defines it.
// FA_NO_ASSERT turns them off (e.g. release builds that keep FreeRTOS's own configASSERT).
#if defined(FA_NO_ASSERT)
    #define FA_ASSERT(x) ((void)0)
#elif defined(FA_SIM)
    #include <cassert>
    #define FA_ASSERT(x) assert(x)
#elif defined(configASSERT)
    #define FA_ASSERT(x) configASSERT(x)
#else
    #define FA_ASSERT(x) ((void)0)
#endif

#include "fa_util.hpp"
#include "fa_ops.hpp"

namespace Fa {
    template <typename M, typename E>
    using HandlerRef = Status(*)(M&, E const&);

    template <typename Derived, typename E, typename ParentState = None>
    struct StateInterface {
        using Parent = ParentState;
        using Self = Derived;

        // Requests an external transition; Act (optional) runs between the exit and entry actions.
        // Sig names the triggering signal when Act takes the event payload.
        template <typename DestState, typename Act = NoAction, typename Sig = void, typename M>
        static Status TransitionTo(M &machine) {
            machine.pending_transition = &Transition<Self, DestState, Act, Sig>::template execute<M, E>;
            return Status::Transitioned;
        }

        template <typename M>
        static Status Super(M &machine, E const &event) {
            if constexpr (std::is_same_v<ParentState, None>) {
                return Status::Ignored;
            } else {
                return Parent::template Dispatch<M>(machine, event);
            }
        }

        template<typename M>
        static Status Dispatch(M &machine, E const &event) {
            if (event.index() == get_index_v<ExitToParent_sig, E>) {
                // Unwinding toward a transition's source: run this state's exit action and step up one
                // level. ExitToParent_sig itself must not reach handle(), whose default case would pass it up via Super().
                Derived::template handle<M>(machine, E{Exit_sig{}});
                if constexpr (!std::is_same_v<ParentState, None>) {
                    machine.handler = &ParentState::template Dispatch<M>;
                } else {
                    machine.handler = nullptr;
                }
                
                return Status::Handled;
            }
            return Derived::template handle<M>(machine, event);
        }
    };
    
    template<typename M, typename E>
    struct Hsm {
        Hsm() 
            : handler(HsmTraits<M>::InitialState), 
              pending_transition(nullptr),
              state_id(HsmTraits<M>::InitialStateId)
        {}

        void unwindToState(HandlerRef<M, E> target_source) {
            while (handler != target_source) {
                FA_ASSERT(handler != nullptr);
                handler(static_cast<M&>(*this), E{ExitToParent_sig{}});
            }
        }
        
        // Starts the machine: enters the top state (runs its entry action), then follows initial transitions.
        static void start(M &machine) {
            dispatch(machine, E{Enter_sig{}});
            dispatch(machine, E{Init_sig{}});
        }

        static void dispatch(M &machine, E const &e) {
            FA_ASSERT(machine.handler != nullptr);

            trace_event<M>(e);

            // The transition receives the event that triggered it, so its action can read the payload.
            E const init{Init_sig{}};
            E const *trigger = &e;

            Status s = machine.handler(machine, e);
            while (s == Status::Transitioned && machine.pending_transition != nullptr) {
                auto transition_to_run = machine.pending_transition;
                machine.pending_transition = nullptr;
                
                transition_to_run(machine, *trigger);

                FA_ASSERT(machine.handler != nullptr);
                trigger = &init;
                s = machine.handler(machine, init);
            }
        }

        // M::Context is looked up lazily: M is still incomplete while Hsm<M, E> is being instantiated as its base.
        //
        // Timers are owned by this actor and identified by their event type: at most one pending timer per
        // (this actor, event type). Scheduling a type that is already pending restarts it; cancel<Evt>() stops it.
        // periodic = true re-arms every ms until cancelled (drift-free: counted from the previous expiry).
        // Returns false if the timer could not be armed (e.g. the application's timer pool is full).
        template <typename Evt>
        bool schedule(Evt const &evt, uint16_t ms, bool periodic = false){
            return M::Context::template schedule<M>(evt, ms, periodic);
        }

        template <typename Evt>
        void cancel(){
            M::Context::template cancel<M, Evt>();
        }

        // Same, with the type deduced from a value: this->cancel(Tick{}). Inside an actor (a class template)
        // this form avoids having to write this->template cancel<Tick>().
        template <typename Evt>
        void cancel(Evt const &){
            cancel<Evt>();
        }

        // Sends evt to its receiving actor (routed by type); this actor is recorded as the sender.
        template <typename Evt>
        void post(Evt const &evt){
            M::Context::template post<M>(evt);
        }

        // Hands item to the application service that owns type T (Fa::MpscServiceInterface<S, T, N>).
        template <typename T>
        bool mpsc_push(T const &item){
            return M::Context::mpsc_push(item);
        }

        HandlerRef<M, E> handler;
        void (*pending_transition)(M &m, E const &e);
        uint16_t state_id;
    };
}

#endif // FA_CORE_HPP