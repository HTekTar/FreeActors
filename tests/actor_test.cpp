// ==========================================================================
// FreeActors engine regression tests — actor configuration (no FA_SIM: the firmware code path on the host)
// Real Actor classes: guards and actions are the actor's own member functions, receiving real payloads.
// Built and run by tests/run.sh.
// ==========================================================================

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "timebomb_actor.hpp"            // generated actor stub, as Export writes it for a new project
#include "timebomb_test_bsp.hpp"         // generated TestBsp for tests/fixtures/timebomb.bsp_policy.hpp
#include "transitionaction_hsm.hpp"
#include "fa_test.hpp"

#include <string>
#include <vector>

using Fa::test::in_state;
using Fa::test::send;
using Fa::test::start;

TEST_CASE("generated Timebomb actor stub runs on the firmware path") {
    using namespace Timebomb;
    Actor<TestBsp> bomb;
    start(bomb);
    CHECK(in_state<DISARMED>(bomb));

    send(bomb, ButtonPressed{});
    CHECK(in_state<WAIT>(bomb));

    send(bomb, ButtonPressed{});
    send(bomb, Tick{});
    CHECK(in_state<LEDOFF>(bomb));

    send(bomb, Tick{});   // stub guard TimeUp(Tick) returns true
    CHECK(in_state<BOOM>(bomb));
}

// A hand-written actor for tests/fixtures/transition_action.hsm.json. It records every call it receives in
// `calls`, and its actions also use the hardware policy and context, which land in Fa::test::log().
namespace TransitionAction {
    template <typename HwPolicy, typename Ctx>
    class Actor : public Fa::Hsm<Actor<HwPolicy, Ctx>, Event> {
    public:
        using Context = Ctx;
        using EventType = Event;

        std::vector<std::string> calls;
        bool allowed_flag = false;

        void entry_ROOT() { calls.push_back("entry_ROOT"); }
        void exit_ROOT() { calls.push_back("exit_ROOT"); }
        void entry_OUTER() { calls.push_back("entry_OUTER"); }
        void exit_OUTER() { calls.push_back("exit_OUTER"); }
        void entry_INNER() { calls.push_back("entry_INNER"); }
        void exit_INNER() { calls.push_back("exit_INNER"); }
        void entry_OTHER() { calls.push_back("entry_OTHER"); }
        void exit_OTHER() { calls.push_back("exit_OTHER"); }

        void cleanup() {
            calls.push_back("cleanup()");
            HwPolicy::set_led(false);
            this->post(Back{});
            this->schedule(Leave{}, 500);
        }
        void stash(Back const &) {                                   // payload action: receives the Back event
            calls.push_back("stash(Back)");
            HwPolicy::read_adc(3);
            this->schedule(Back{}, 100, true);
            this->cancel(Leave{});
        }
        bool allowed() const { return allowed_flag || HwPolicy::read_button(); }
    };
}

TEST_CASE("real actor: transition actions run between exits and entries, with the triggering payload") {
    using Recorder = TransitionAction::Actor<Timebomb::TestBsp, Fa::test::RecordingContext>;
    Recorder m;
    start(m);
    CHECK(m.calls == std::vector<std::string>{"entry_ROOT", "entry_OUTER", "entry_INNER"});

    SUBCASE("parameterless transition action") {
        m.calls.clear();
        send(m, TransitionAction::Leave{});
        CHECK(m.calls == std::vector<std::string>{"exit_INNER", "exit_OUTER", "cleanup()", "entry_OTHER"});
        CHECK(in_state<TransitionAction::OTHER>(m));
    }

    SUBCASE("guard false: inherited Back is not taken") {
        m.calls.clear();
        send(m, TransitionAction::Back{});
        CHECK(m.calls.empty());
        CHECK(in_state<TransitionAction::INNER>(m));
    }

    SUBCASE("guard true: inherited Back runs the payload action in UML order") {
        m.allowed_flag = true;
        m.calls.clear();
        send(m, TransitionAction::Back{});
        CHECK(m.calls == std::vector<std::string>{"exit_INNER", "exit_OUTER", "stash(Back)", "entry_OTHER"});
        CHECK(in_state<TransitionAction::OTHER>(m));
    }
}

TEST_CASE("Fa::test::log(): hardware calls and context traffic on one ordered timeline") {
    using Recorder = TransitionAction::Actor<Timebomb::TestBsp, Fa::test::RecordingContext>;
    Fa::test::reset<Timebomb::TestBsp>();
    Recorder m;
    start(m);
    CHECK(Fa::test::log().empty());

    SUBCASE("parameterless action: driver call, post and schedule, in order") {
        send(m, TransitionAction::Leave{});
        CHECK(Fa::test::log() == Fa::test::steps{"set_led(false)", "post Back", "schedule Leave 500ms"});
    }

    SUBCASE("a guard reading a driver input is controlled by TestBsp::<fn>_result") {
        Timebomb::TestBsp::read_button_result = true;
        send(m, TransitionAction::Back{});
        CHECK(Fa::test::log() == Fa::test::steps{"read_button", "read_adc(3)", "schedule Back every 100ms", "cancel Leave"});
        CHECK(in_state<TransitionAction::OTHER>(m));
    }

    SUBCASE("reset clears the log and restores default driver results") {
        Timebomb::TestBsp::read_adc_result = 7;
        send(m, TransitionAction::Leave{});
        Fa::test::reset<Timebomb::TestBsp>();
        CHECK(Fa::test::log().empty());
        CHECK(Timebomb::TestBsp::read_adc_result == 0);
    }
}

#ifdef FA_TRACE
// With FA_TRACE the application provides emit_trace_token(); here it records the tokens.
namespace {
    std::vector<Fa::trace_token> tokens;
}

void Fa::emit_trace_token(Fa::trace_token token) {
    tokens.push_back(token);
}

TEST_CASE("FA_TRACE: one dispatch emits event, transition and action tokens in execution order") {
    using Recorder = TransitionAction::Actor<Timebomb::TestBsp, Fa::test::RecordingContext>;
    Recorder m;
    start(m);
    tokens.clear();

    send(m, TransitionAction::Leave{});

    std::vector<uint32_t> categories;
    for (auto const &t : tokens) categories.push_back(t.trace_cat);
    CHECK(categories == std::vector<uint32_t>{
        Fa::TRACE_CAT_EVENT, Fa::TRACE_CAT_TRANSITION,
        Fa::TRACE_CAT_ACTION, Fa::TRACE_CAT_ACTION, Fa::TRACE_CAT_ACTION, Fa::TRACE_CAT_ACTION});

    REQUIRE(tokens.size() == 6);
    CHECK(tokens[0].token_id == Fa::get_index_v<TransitionAction::Leave, TransitionAction::Event>);
    using Catalog = TransitionAction::StateCatalog;
    CHECK(tokens[1].token_id == ((Fa::type_id_v<TransitionAction::INNER, Catalog> << 8) |
                                  Fa::type_id_v<TransitionAction::OTHER, Catalog>));
    CHECK(tokens[4].token_id == Fa::ActionDescriptor<TransitionAction::Cleanup>::id);
}
#endif // FA_TRACE
