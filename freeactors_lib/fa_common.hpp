#pragma once
#ifndef FA_COMMON_HPP
#define FA_COMMON_HPP

#include <cstddef>
#include <cstdint>

namespace Fa{
    enum class Status {
        Handled,
        Ignored,
        Transitioned
    };
    // Base marker for the top-level absolute root state
    struct None {
        template <typename M, typename E>
        static Status Dispatch(M&, E const&) { return Status::Ignored; }
    };



    // Standard uniform function pointer type for the runtime execution engine
    template<typename M, typename E>
    using HandlerRef = Status (*) (M &, E const &);


    struct Enter_sig {};
    struct Exit_sig  {};
    struct Init_sig  {};
    struct ExitToParent_sig {};

    template <typename E>
    struct EventDescriptor;

    template <> struct EventDescriptor<Enter_sig> { static constexpr const char* name = "Enter_sig"; };
    template <> struct EventDescriptor<Exit_sig> { static constexpr const char* name = "Exit_sig"; };
    template <> struct EventDescriptor<Init_sig> { static constexpr const char* name = "Init_sig"; };
    template <> struct EventDescriptor<ExitToParent_sig> { static constexpr const char* name = "ExitToParent_sig"; };

    template<typename M>
    struct HsmTraits;

    template <typename E>
    struct StateDescriptor;

    template <typename E>
    struct GuardDescriptor;

    template <typename E>
    struct ActionDescriptor;

    template <typename A>
    struct ActorTraits;

    // Default actor context: routes nothing. Used standalone and as the target default for Ctx.
    //
    // Context interface (what Hsm::post/schedule/cancel forward to):
    //   post(evt)                                     deliver evt to its receiving actor
    //   schedule<Owner>(evt, ms, periodic) -> bool    (re)start Owner's timer for evt's type; false if it can't
    //   cancel<Owner, Evt>()                          stop Owner's pending timer for Evt, if any
    struct NullContext {
        template <typename Owner, typename Evt>
        static bool schedule(Evt const& /*evt*/, uint16_t /*ms*/, bool /*periodic*/) {
            return false;
        }

        template <typename Owner, typename Evt>
        static void cancel() {}

        template <typename Evt>
        static void post(Evt const& /*evt*/) {}
    };
}

#endif