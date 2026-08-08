#ifndef FA_TRACE_H
#define FA_TRACE_H

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
        std::cout << "\n\033[1;32m[EVENT]\033[0m ID: " << e.index() << "\n";
    }
}

#else

namespace Fa {

    struct [[gnu::packed]] trace_token {
        uint32_t machine_id  : 5;  // Up to 32 distinct state machine blueprints
        uint32_t instance_id : 3;  // Up to 8 active runtime task instances per machine type
        uint32_t trace_cat   : 2;  // Category: 0=Event, 1=Guard, 2=Action, 3=Transition
        uint32_t guard_state : 1;  // Pass/Fail execution result bit for Guards
        uint32_t reserved    : 5;  // Available field space for future scaling flags
        uint32_t token_id    : 16; // Concrete canvas entity identifier index
    };

    // Statically guarantee at compile-time that no alignment padding was injected
    static_assert(sizeof(trace_token) == 4, "Error: trace_token struct padding layout must be exactly 4 bytes!");

    // user-space bytes to JTAG/UART/RTT.
    extern void emit_trace_token(trace_token token);

    // Token Map Layout (16-bit):
    // [ Bits 15:14 -> Type Category ] [ Bits 13:0 -> Specific Generated Element ID ]
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