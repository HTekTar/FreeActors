// ==========================================================================
// AUTO-GENERATED FREEACTORS EVENT DEFINITIONS - DO NOT HAND-EDIT
// Machine: Timebomb
// (Test fixture: an events header as written before 0.0.8, with a field added by hand)
// ==========================================================================

#pragma once
#ifndef TIMEBOMB_EVENTS_HPP
#define TIMEBOMB_EVENTS_HPP

#include <cstdint>
#include <variant>
#include "fa_core.hpp"

namespace Timebomb {

// ==========================================================================
// Signal & Event Payload Definitions
// In FA_SIM, all events are zero-payload stubs for CLI/REPL simulation.
// ==========================================================================
#ifdef FA_SIM

struct Tick {};
struct ButtonPressed {};

#else

struct Tick {};
struct ButtonPressed { uint8_t presses = 1; };   // a field added by hand

#endif // FA_SIM

// --- Actor Event Variant ---
using Event = std::variant<
    Fa::Enter_sig,
    Fa::Exit_sig,
    Fa::Init_sig,
    Fa::ExitToParent_sig,
    Tick,
    ButtonPressed
>;

} // namespace Timebomb

// --- Event Descriptor Specializations for Reflection ---
namespace Fa {
    template <> struct EventDescriptor<Timebomb::Tick> { static constexpr const char* name = "Tick"; };
    template <> struct EventDescriptor<Timebomb::ButtonPressed> { static constexpr const char* name = "ButtonPressed"; };
} // namespace Fa

#endif // TIMEBOMB_EVENTS_HPP
