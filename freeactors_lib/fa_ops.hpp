#ifndef FA_OPERATIONS
#define FA_OPERATIONS

#include "fa_util.hpp"
#include "fa_trace.hpp"

namespace Fa{
    struct Enter_sig {};
    struct Exit_sig  {};
    struct Init_sig  {};
    struct ExitToParent_sig {};

    template <> struct EventDescriptor<Enter_sig> { static constexpr const char* name = "Enter_sig"; };
    template <> struct EventDescriptor<Exit_sig> { static constexpr const char* name = "Exit_sig"; };
    template <> struct EventDescriptor<Init_sig> { static constexpr const char* name = "Init_sig"; };
    template <> struct EventDescriptor<ExitToParent_sig> { static constexpr const char* name = "ExitToParent_sig"; };

    template<typename M>
    struct HsmTraits;

    template<typename S, typename D>
    struct Transition {
        template <typename M, typename E>
        static void execute(M &machine) {
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