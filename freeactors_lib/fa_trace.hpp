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

    template <typename EventVariant>
    inline void trace_event(EventVariant const& e) {
        const auto id = e.index();
        const auto& name = MetaTable<EventDescriptor, EventVariant>::names[id];
        std::cout << "\n\033[1;32m[EVENT]\033[0m " << name 
                << " (id: " << id << ")\n";
    }
}

#else

// Target builds: tracing is compiled out unless FA_TRACE is defined. With FA_TRACE, every guard evaluation,
// action, transition and dispatched event emits one 32-bit trace_token through emit_trace_token(), which the
// application provides (e.g. an ITM/SWO channel or a RAM ring buffer).
namespace Fa {

    struct [[gnu::packed]] trace_token {
        uint32_t machine_id  : 5;   // not yet populated (0)
        uint32_t instance_id : 3;   // not yet populated (0); reserved for multi-instance support
        uint32_t trace_cat   : 2;   // TraceCategory
        uint32_t guard_state : 1;   // guard result, for TRACE_CAT_GUARD
        uint32_t reserved    : 5;
        uint32_t token_id    : 16;  // descriptor id, event index, or (src_state << 8 | dst_state)
    };

    static_assert(sizeof(trace_token) == 4, "Error: trace_token struct padding layout must be exactly 4 bytes!");

    enum TraceCategory : uint32_t {
        TRACE_CAT_EVENT      = 0,
        TRACE_CAT_GUARD      = 1,
        TRACE_CAT_ACTION     = 2,
        TRACE_CAT_TRANSITION = 3
    };

#ifdef FA_TRACE
    extern void emit_trace_token(trace_token token);

    namespace detail {
        inline void emit_trace(uint32_t category, uint32_t id, bool guard_state = false) {
            trace_token token{};
            token.trace_cat = category;
            token.guard_state = guard_state ? 1u : 0u;
            token.token_id = id & 0xFFFFu;
            emit_trace_token(token);
        }
    }

    template <typename M, typename P>
    inline void trace_guard(bool passed) {
        detail::emit_trace(TRACE_CAT_GUARD, GuardDescriptor<P>::id, passed);
    }

    template <typename M, typename P>
    inline void trace_action() {
        detail::emit_trace(TRACE_CAT_ACTION, ActionDescriptor<P>::id);
    }

    template <typename M, typename Src, typename Dest>
    inline void trace_transition() {
        using Catalog = typename HsmTraits<M>::StateCatalog;
        detail::emit_trace(TRACE_CAT_TRANSITION, (type_id_v<Src, Catalog> << 8) | type_id_v<Dest, Catalog>);
    }

    template <typename EventVariant>
    inline void trace_event(EventVariant const& e) {
        detail::emit_trace(TRACE_CAT_EVENT, static_cast<uint32_t>(e.index()));
    }
#else
    template <typename M, typename P>
    inline void trace_guard(bool) {}

    template <typename M, typename P>
    inline void trace_action() {}

    template <typename M, typename Src, typename Dest>
    inline void trace_transition() {}

    template <typename EventVariant>
    inline void trace_event(EventVariant const&) {}
#endif // FA_TRACE
}

#endif //FA_SIM

#endif //FA_TRACE_H