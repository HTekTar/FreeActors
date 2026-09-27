#ifndef FA_OPERATIONS
#define FA_OPERATIONS

#include "fa_util.hpp"
#include "fa_trace.hpp"
#include "fa_common.hpp"

namespace Fa{

    template <typename P>
    struct Action;

    // Marker for a transition without an action.
    struct NoAction {};

    // External transition S -> D with an optional transition action Act.
    // Sig is the triggering signal whose payload Act receives, or void for a parameterless action.
    // UML order: exit actions (innermost first), then the transition action, then entry actions (outermost first).
    template<typename S, typename D, typename Act = NoAction, typename Sig = void>
    struct Transition {
        template <typename M, typename E>
        static void execute(M &machine, [[maybe_unused]] E const &event) {
            using SrcPath  = typename BuildPath<S>::Type; 
            using DestPath = typename BuildPath<D>::Type; 
            using MachineStates = typename HsmTraits<M>::StateCatalog;

            using LCA = typename FindLCA<SrcPath, DestPath>::Type;

            using ExitPath = typename SliceToLCA<SrcPath, LCA>::Type;
            using EnterPathRev = typename SliceToLCA<DestPath, LCA>::Type;
            using EnterPath    = typename ReverseList<EnterPathRev>::Type;

            trace_transition<M,S,D>();
            
            machine.unwindToState(&S::template Dispatch<M>);

            RouteExecutor<M, E, ExitPath>::run(machine, E{Exit_sig{}});

            if constexpr (!std::is_same_v<Act, NoAction>) {
                if constexpr (std::is_void_v<Sig>) {
                    Action<Act>::execute(machine);
                } else {
                    // The handler that requested this transition matched Sig, so the alternative is guaranteed.
                    Action<Act>::execute(machine, *std::get_if<Sig>(&event));
                }
            }

            RouteExecutor<M, E, EnterPath>::run(machine, E{Enter_sig{}});

            machine.handler = &D::template Dispatch<M>;
            machine.state_id = type_id_v<D, MachineStates>;
        }
    };


    template <typename P>
    struct Action {
        template<typename M>
        static void execute(M &m) {
            trace_action<M,P>();
#ifndef FA_SIM
            P::execute(m);
#else
            m.template execute_action<P>();
#endif
        }
        template <typename M, typename E>
        static void execute(M &m, E const &e){
            trace_action<M,P>();
#ifndef FA_SIM
            P::execute(m, e);
#else
            (void)e;
            m.template execute_action<P>();
#endif
        }
    };

    template <typename P>
    struct Guard {
        template<typename M>
        static bool eval(M const &m) {
            bool passed = false;

#ifndef FA_SIM
        passed = P::eval(m);
#else
        passed = m.template eval_guard<P>();
#endif
            trace_guard<M,P>(passed);
            return passed;
        }
        template <typename M, typename E>
        static bool eval(M const &m, E const &e){
            bool passed = false;
#ifndef FA_SIM
        passed = P::eval(m, e);
#else
        (void)e;
        passed = m.template eval_guard<P>();
#endif
            trace_guard<M,P>(passed);
            return passed;
        }
    };
}


#endif