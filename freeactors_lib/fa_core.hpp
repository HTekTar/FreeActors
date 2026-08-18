#ifndef FA_CORE_HPP
#define FA_CORE_HPP

#include <cstdint>
#include <type_traits>

#ifdef FA_SIM
    #include <cassert>
    #ifndef configASSERT
        #define configASSERT(x) assert(x)
    #endif
#else
    #include "FreeRTOS.h"
    #include "queue.h"
    #include "task.h"

    #ifndef configASSERT
        #define configASSERT(x) ((void)0)
    #endif
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

        template <typename DestState, typename M>
        static Status TransitionTo(M &machine) {
            machine.pending_transition = &Transition<Self, DestState>::template execute<M>;
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
                Derived::template handle<M>(machine, event); 
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
    template<typename M>
    struct HsmTraits;
    
    template<typename M, typename E>
    struct Hsm {
        Hsm() 
            : handler(HsmTraits<M>::InitialState), 
              pending_transition(nullptr)
#ifndef FA_SIM
            , queue(nullptr)
#endif
        {}

        void start(uint8_t prio, uint32_t queueLen, uint32_t stackSize) {
            configASSERT(handler != nullptr);

#ifndef FA_SIM
            configASSERT(queue == nullptr);

            queue = xQueueCreate(queueLen, sizeof(E));
            configASSERT(queue != NULL);

            BaseType_t xResult = xTaskCreate(
                eventLoop, 
                "Active_object", 
                static_cast<configSTACK_DEPTH_TYPE>(stackSize), 
                this, 
                prio, 
                NULL
            );
            configASSERT(xResult == pdPASS);
#else
            (void)prio;
            (void)queueLen;
            (void)stackSize;
#endif
        }

        void postFromTask(E const &e) {
#ifndef FA_SIM
            configASSERT(queue != NULL);
            BaseType_t status = xQueueSendToBack(queue, (void *)&e, portMAX_DELAY);
            configASSERT(status == pdPASS);
#else
            // Direct sync dispatch for simulation tests if no queue runtime is provided
            dispatch(static_cast<M&>(*this), e);
#endif
        }

        void postFromISR(E const &e) {
#ifndef FA_SIM
            configASSERT(queue != NULL);
            BaseType_t xHigherPriorityTaskWoken = pdFALSE;
            BaseType_t status = xQueueSendToBackFromISR(queue, (void *)&e, &xHigherPriorityTaskWoken);
            configASSERT(status == pdPASS);
            portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
#else
            dispatch(static_cast<M&>(*this), e);
#endif
        }

        void unwindToState(HandlerRef<M, E> target_source) {
            while (handler != target_source) {
                configASSERT(handler != nullptr);
                handler(static_cast<M&>(*this), E{ExitToParent_sig{}});
            }
        }
        
        static void dispatch(M &machine, E const &e) {
            configASSERT(machine.handler != nullptr);

            // Event tracing hook
            Fa::trace_event<E>(e);

            Status s = machine.handler(machine, e);
            while (s == Status::Transitioned && machine.pending_transition != nullptr) {
                auto transition_to_run = machine.pending_transition;
                machine.pending_transition = nullptr;
                
                transition_to_run(machine);

                configASSERT(machine.handler != nullptr);
                s = machine.handler(machine, E{Init_sig{}});
            }
        }

        HandlerRef<M, E> handler;
        void (*pending_transition)(M &m); 

    private:
#ifndef FA_SIM
        static void eventLoop(void *pdata) {
            configASSERT(pdata != NULL);
            auto &machine = *static_cast<M*>(pdata);

            dispatch(machine, E{Init_sig{}});

            while (1) {
                E e; 
                BaseType_t rxStatus = xQueueReceive(machine.queue, &e, portMAX_DELAY);
                configASSERT(rxStatus == pdTRUE);

                dispatch(machine, e); 
            }
        }

        QueueHandle_t queue;
#endif
    };

}

#endif // FA_CORE_HPP