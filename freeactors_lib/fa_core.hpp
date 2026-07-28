#ifndef FA_CORE_HPP
#define FA_CORE_HPP

#include "FreeRTOS.h"
#include "queue.h"
#include "task.h"
#include "fa_util.hpp"

enum class Status {
    Handled,
    Ignored,
    Transitioned
};

struct Enter_sig {};
struct Exit_sig  {};
struct Init_sig  {};
struct ExitToParent_sig {};

template <typename M, typename E>
using HandlerRef = Status(*)(M&, E const&);

template<typename S, typename D>
struct Transition {
    template <typename M, typename E>
    static void execute(M &machine) {
        using SrcPath  = typename BuildPath<S>::Type; 
        using DestPath = typename BuildPath<D>::Type; 

        using LCA = typename FindLCA<SrcPath, DestPath>::Type;

        using ExitPath = typename SliceToLCA<SrcPath, LCA>::Type;
        using EnterPathRev = typename SliceToLCA<DestPath, LCA>::Type;
        using EnterPath    = typename ReverseList<EnterPathRev>::Type;

        machine.unwindToState(&S::template Dispatch<M>);

        RouteExecutor<M, E, ExitPath>::run(machine, E{Exit_sig{}});
        RouteExecutor<M, E, EnterPath>::run(machine, E{Enter_sig{}});

        machine.handler = &D::template Dispatch<M>;
    }
};

template <typename Derived, typename E, typename ParentState = None>
struct StateInterface {
    using Parent = ParentState;
    using Self = Derived;

    template <typename DestState, typename M>
    static Status TransitionTo(M &machine) {
        machine.pending_transition = &Transition<Self, DestState>::template execute<M, E>;
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
        return Derived::handle(machine, event);
    }
};

template<typename M, typename E>
struct Hsm {
    Hsm() : handler(HsmTraits<M>::InitialState), queue(nullptr), pending_transition(nullptr) {}

    void start(uint8_t prio, uint32_t queueLen, uint32_t stackSize){
        queue = xQueueCreate(queueLen, sizeof(E));
        xTaskCreate(eventLoop, "Active_object", stackSize, this, prio, NULL);
    }

    void postFromTask(E const &e) {
        xQueueSendToBack(queue, (void *)&e, portMAX_DELAY);
    }

    void postFromISR(E const &e) {
        BaseType_t xHigherPriorityTaskWoken = pdFALSE;
        xQueueSendToBackFromISR(queue, (void *)&e, &xHigherPriorityTaskWoken);
        portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
    }

    void unwindToState(HandlerRef<M, E> target_source) {
        while (handler != target_source) {
            handler(static_cast<M&>(*this), E{ExitToParent_sig{}});
        }
    }
    
    static void dispatch(M &machine, E const &e) {
        Status s = machine.handler(machine, e);
        while(s == Status::Transitioned && machine.pending_transition != nullptr){
            auto transition_to_run = machine.pending_transition;
            machine.pending_transition = nullptr;
            
            transition_to_run(machine);
            s = machine.handler(machine, E{Init_sig{}});
        }
    }

    HandlerRef<M, E> handler;
    void (*pending_transition)(M &m); 

private:
    static void eventLoop(void *pdata) {
        auto &machine = *static_cast<M*>(pdata);

        dispatch(machine, E{Init_sig{}});

        while (1) {
            E e; 
            if (xQueueReceive(machine.queue, &e, portMAX_DELAY) == pdTRUE) {
                dispatch(machine, e); 
            }
        }
    }

    QueueHandle_t queue;
};

#endif