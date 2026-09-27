// ==========================================================================
// FreeActors engine regression tests — model configuration (FA_SIM, MockMachine)
// Drives machines generated from tests/fixtures/*.hsm.json and compares the dispatch trace
// (action names and "Src->Dst" transitions, in execution order) to the expected UML sequence.
// Built and run by tests/run.sh.
// ==========================================================================

#define FA_SIM
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "timebomb_hsm.hpp"
#include "initaction_hsm.hpp"
#include "transitionaction_hsm.hpp"
#include "fa_test.hpp"

using Fa::test::in_state;
using Fa::test::send;
using Fa::test::start;
using Fa::test::steps;
using Fa::test::trace;

TEST_CASE("timebomb: startup enters ROOT, then follows initial transitions") {
    using namespace Timebomb;
    SimMachine m;
    CHECK(trace([&] { start(m); }) == steps{"Entry_ROOT", "ROOT->DISARMED", "Entry_DISARMED"});
    CHECK(in_state<DISARMED>(m));
}

TEST_CASE("timebomb: behaviour once armed") {
    using namespace Timebomb;
    SimMachine m;
    start(m);

    CHECK(trace(m, ButtonPressed{}) ==
          steps{"DISARMED->ARMED", "Exit_DISARMED", "Entry_ARMED", "ARMED->WAIT", "Entry_WAIT"});
    CHECK(in_state<WAIT>(m));

    CHECK(trace(m, ButtonPressed{}) == steps{"WAIT->LEDON", "Exit_WAIT", "Entry_LEDON"});

    SUBCASE("transition inherited from ARMED exits the active leaf first") {
        CHECK(trace(m, ButtonPressed{}) ==
              steps{"ARMED->DISARMED", "Exit_LEDON", "Exit_ARMED", "Entry_DISARMED"});
        CHECK(in_state<DISARMED>(m));
    }

    SUBCASE("guard TimeUp false takes the unguarded Tick back to LEDON") {
        send(m, Tick{});
        CHECK(trace(m, Tick{}) == steps{"LEDOFF->LEDON", "Exit_LEDOFF", "Entry_LEDON"});
    }

    SUBCASE("guard TimeUp true takes Tick to BOOM, leaving ARMED") {
        send(m, Tick{});
        m.set_guard<TimeUp>(true);
        CHECK(trace(m, Tick{}) == steps{"LEDOFF->BOOM", "Exit_LEDOFF", "Exit_ARMED", "Entry_BOOM"});
        CHECK(in_state<BOOM>(m));
    }
}

TEST_CASE("init_action: initial-transition actions run before entering the target") {
    using namespace InitAction;
    SimMachine m;
    CHECK(trace([&] { start(m); }) ==
          steps{"Entry_ROOT", "ROOT->OUTER", "RootSetup", "Entry_OUTER", "OUTER->INNER", "Setup", "Entry_INNER"});

    SUBCASE("internal event runs its action without a transition") {
        CHECK(trace(m, Go{}) == steps{"Count"});
        CHECK(in_state<INNER>(m));
    }
}

// Compile-time check: a transition without an action must build for any Sig (Sig is simply unused).
[[maybe_unused]] auto const transition_without_action_ignores_sig =
    &Fa::Transition<TransitionAction::INNER, TransitionAction::OTHER, Fa::NoAction, TransitionAction::Leave>
        ::execute<TransitionAction::SimMachine, TransitionAction::Event>;

// UML order for an external transition: exit actions, then the transition action, then entry actions.
TEST_CASE("transition_action: action runs between exits and entries") {
    using namespace TransitionAction;
    SimMachine m;
    start(m);

    SUBCASE("own transition with parameterless action") {
        CHECK(trace(m, Leave{}) == steps{"INNER->OTHER", "Exit_INNER", "Exit_OUTER", "Cleanup", "Entry_OTHER"});
    }

    SUBCASE("inherited, guarded transition with payload action") {
        m.set_guard<Allowed>(true);
        CHECK(trace(m, Back{}) == steps{"OUTER->OTHER", "Exit_INNER", "Exit_OUTER", "Stash", "Entry_OTHER"});
    }
}
