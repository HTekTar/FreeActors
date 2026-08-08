#ifndef FA_OPERATIONS
#define FA_OPERATIONS

#include "fa_util.hpp"
#include "fa_trace.hpp"

namespace Fa{
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

            //transition tracing here
            fa_trace_trans<M,S,D>();
            machine.handler = &D::template Dispatch<M>;
        }
    };


    template <typename P>
    struct Action {
        template<typename M>
        static bool execute(M const &m) {
            fa_trace_action<M,P>();
            P::execute(m);
        }
        template <typename M, typename E>
        static bool execute(M const &m, E const &e){
            fa_trace_action<M,P>();
            P::execute(m);
        }
    };

    template <typename P>
    struct Guard {
        template<typename M>
        static bool eval(M const &m) {
            bool passed = false;

            passed = P::eval(m);
            fa_trace_guard<M,P>(passed);
            return passed;
        }
        template <typename M, typename E>
        static bool eval(M const &m, E const &e){
            bool passed = false;
            passed = P::eval(m, e);
            fa_trace_guard<M,P>(passed);
            return passed;
        }
    };
}

#endif