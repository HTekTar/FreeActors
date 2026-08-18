#ifndef FA_TRACE_H
#define FA_TRACE_H

namespace Fa{
    template <typename E>
    struct EventDescriptor;
    
    struct EventMeta {
        uint16_t id;
        const char* name;
    };

    template <typename Variant>
    struct EventRegistry;

    template <typename... Events>
    struct EventRegistry<std::variant<Events...>> {
        using VariantType = std::variant<Events...>;
        static constexpr size_t count = sizeof...(Events);

        static constexpr std::array<EventMeta, count> items = {{
            { 
                static_cast<uint16_t>(Fa::get_index_v<Events, VariantType>), 
                Fa::EventDescriptor<Events>::name 
            }...
        }};
    };
}


#ifdef FA_SIM
#include <iostream>

namespace Fa {
    template <typename T>
    inline const char* clean_name() {
        return T::name; 
    }

    template <typename M, typename P>
    inline void trace_guard(bool passed) {
        std::cout << "  \033[1;35m[GUARD]\033[0m " << clean_name<P>() 
                  << " -> " << (passed ? "\033[1;32mPASSED\033[0m" : "\033[1;31mFAILED\033[0m") 
                  << "\n";
    }

    template <typename M, typename P>
    inline void trace_action() {
        std::cout << "  \033[1;36m[ACTION]\033[0m " << clean_name<P>() << "\n";
    }

    template <typename M, typename Src, typename Dest>
    inline void trace_transition() {
        std::cout << "  \033[1;33m[TRANSITION]\033[0m " << clean_name<Src>() 
                  << " ===> " << clean_name<Dest>() << "\n";
    }

    template <typename EventVariant>
    inline void trace_event(EventVariant const& e) {
        const auto& meta = EventRegistry<EventVariant>::items[e.index()];
        std::cout << "\n\033[1;32m[EVENT]\033[0m " << meta.name 
                << " (id: " << meta.id << ")\n";
    }
}

#else

namespace Fa {

    struct [[gnu::packed]] trace_token {
        uint32_t machine_id  : 5;
        uint32_t instance_id : 3;
        uint32_t trace_cat   : 2;
        uint32_t guard_state : 1;
        uint32_t reserved    : 5;
        uint32_t token_id    : 16;
    };

    static_assert(sizeof(trace_token) == 4, "Error: trace_token struct padding layout must be exactly 4 bytes!");

    extern void emit_trace_token(trace_token token);

    constexpr uint16_t TRACE_CAT_EVENT      = 0x0000;
    constexpr uint16_t TRACE_CAT_GUARD      = 0x4000;
    constexpr uint16_t TRACE_CAT_ACTION     = 0x8000;
    constexpr uint16_t TRACE_CAT_TRANSITION = 0xC000;

    template <typename M, typename P>
    inline void trace_guard(bool passed) {
        uint16_t token = TRACE_CAT_GUARD | (P::id & 0x3FFF);
        if (passed) token |= 0x2000;
        emit_trace_token(token);
    }

    template <typename M, typename P>
    inline void trace_action(trace_token token) {
        emit_trace_token(TRACE_CAT_ACTION | (P::id & 0x3FFF));
    }

    template <typename M, typename Src, typename Dest>
    inline void trace_transition(trace_token token) {
        uint16_t token = TRACE_CAT_TRANSITION | ((Src::id & 0x7F) << 7) | (Dest::id & 0x7F);
        emit_trace_token(token);
    }

    inline void trace_event(uint16_t event_index) {
        emit_trace_token(TRACE_CAT_EVENT | (event_index & 0x3FFF));
    }
}

#endif //FA_SIM

#endif //FA_TRACE_H