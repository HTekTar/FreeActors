#ifndef FA_TRACE_H
#define FA_TRACE_H

#include "fa_common.hpp"
#include "fa_util.hpp"

#ifdef FA_SIM
#include <iostream>

namespace Fa {
    template <typename T>
    inline const char* clean_name() {
        return T::name; 
    }

    template <typename M, typename P>
    inline void trace_guard(bool passed) {
        std::cout << "  \033[1;35m[GUARD]\033[0m " << GuardDescriptor<P>::name 
                  << " -> " << (passed ? "\033[1;32mPASSED\033[0m" : "\033[1;31mFAILED\033[0m") 
                  << "\n";
    }

    template <typename M, typename P>
    inline void trace_action() {
        std::cout << "  \033[1;36m[ACTION]\033[0m " << ActionDescriptor<P>::name << "\n";
    }

    template <typename M, typename Src, typename Dest>
    inline void trace_transition() {
        std::cout << "  \033[1;33m[TRANSITION]\033[0m " << StateDescriptor<Src>::name 
                  << " ===> " << StateDescriptor<Dest>::name << "\n";
    }

    template <typename M, typename EventVariant>
    inline void trace_event(EventVariant const& e) {
        const auto id = e.index();
        const auto& name = MetaTable<EventDescriptor, EventVariant>::names[id];
        std::cout << "\n\033[1;32m[EVENT]\033[0m " << name 
                << " (id: " << id << ")\n";
    }
}

#else

// Target builds: tracing is compiled out unless FA_TRACE is defined. With FA_TRACE, every dispatched event,
// guard evaluation, action and transition becomes a TraceRecord handed to the machine's context
// (M::Context::trace<M>), which the application routes to its trace service (Fa::TraceService).
// Standalone machines (NullContext) and actor tests (RecordingContext) ignore it.
namespace Fa {

#ifdef FA_TRACE
    template <typename M, typename P>
    inline void trace_guard(bool passed) {
        M::Context::template trace<M>(passed ? TraceKind::GuardTrue : TraceKind::GuardFalse,
                                      static_cast<uint16_t>(GuardDescriptor<P>::id));
    }

    template <typename M, typename P>
    inline void trace_action() {
        M::Context::template trace<M>(TraceKind::Action, static_cast<uint16_t>(ActionDescriptor<P>::id));
    }

    template <typename M, typename Src, typename Dest>
    inline void trace_transition() {
        using Catalog = typename HsmTraits<M>::StateCatalog;
        M::Context::template trace<M>(TraceKind::Transition,
                                      static_cast<uint16_t>((type_id_v<Src, Catalog> << 8) | type_id_v<Dest, Catalog>));
    }

    template <typename M, typename EventVariant>
    inline void trace_event(EventVariant const& e) {
        M::Context::template trace<M>(TraceKind::Event, static_cast<uint16_t>(e.index()));
    }
#else
    template <typename M, typename P>
    inline void trace_guard(bool) {}

    template <typename M, typename P>
    inline void trace_action() {}

    template <typename M, typename Src, typename Dest>
    inline void trace_transition() {}

    template <typename M, typename EventVariant>
    inline void trace_event(EventVariant const&) {}
#endif // FA_TRACE
}

#endif //FA_SIM

#endif //FA_TRACE_H