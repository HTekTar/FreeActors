#ifndef FA_TEST_HPP
#define FA_TEST_HPP

// ==========================================================================
// FreeActors host test helpers (framework-agnostic; used with doctest in generated tests)
//
// Driving a machine (model tests: <Machine>::SimMachine, actor tests: <Machine>::Actor<TestBsp, ...>)
//   Fa::test::start(m)              start machine m (enter ROOT, follow initial transitions)
//   Fa::test::send(m, Sig{})        dispatch one event to machine m (run-to-completion)
//   Fa::test::in_state<S>(m)        true if m's active (leaf) state is S
//
// Model tests (FA_SIM): the engine's own trace
//   Fa::test::trace(m, Sig{})       dispatch and return the steps it caused
//   Fa::test::trace([&]{ ... })     steps caused by any code block
//   A step is an action name ("Entry_LEDON") or a transition ("ARMED->DISARMED"), in execution order.
//
// Actor tests: what the actor did to the outside world, as one ordered timeline
//   Fa::test::reset<TestBsp>()      clear the log and restore TestBsp's default input values;
//                                   call it first in every test case
//   Fa::test::log()                 recorded entries, e.g. "set_red_led(true)", "post StartSiren",
//                                   "schedule Tick 500ms"
//   Fa::test::record(name, args...) append an entry (used by the generated TestBsp)
//   Fa::test::RecordingContext      actor Ctx that records post/schedule/cancel instead of routing them:
//                                   "post Done", "schedule Tick 500ms", "schedule Tick every 500ms", "cancel Tick"
//
// start/send are quiet: in FA_SIM they swallow the console trace, unless called inside trace(...).
// ==========================================================================

#include <cstdint>
#include <sstream>
#include <string>
#include <type_traits>
#include <vector>

#include "fa_util.hpp"
#include "fa_core.hpp"

#ifdef FA_SIM
#include <iostream>
#endif

namespace Fa::test {

    using steps = std::vector<std::string>;

    template <typename S, typename M>
    bool in_state(M const &machine) {
        return machine.state_id == type_id_v<S, typename HsmTraits<M>::StateCatalog>;
    }

    // ----------------------------------------------------------------------
    // Timeline log (actor tests)
    // ----------------------------------------------------------------------
    namespace detail {
        inline steps &timeline() {
            static steps entries;
            return entries;
        }

        template <typename T>
        std::string format_arg(T const &value) {
            if constexpr (std::is_same_v<T, bool>) {
                return value ? "true" : "false";
            } else if constexpr (std::is_enum_v<T>) {
                return std::to_string(static_cast<long long>(value));
            } else if constexpr (std::is_integral_v<T>) {
                return std::to_string(+value);   // unary + prints (u)int8_t as a number, not a character
            } else if constexpr (std::is_floating_point_v<T>) {
                std::ostringstream out;
                out << value;
                return out.str();
            } else if constexpr (std::is_convertible_v<T const &, std::string>) {
                return std::string(value);
            } else {
                return "?";
            }
        }

        template <typename T, typename = void>
        struct has_reset : std::false_type {};

        template <typename T>
        struct has_reset<T, std::void_t<decltype(T::reset())>> : std::true_type {};
    }

    inline steps const &log() {
        return detail::timeline();
    }

    // Appends "name(arg1, arg2, ...)"; with no arguments just "name".
    template <typename... Args>
    void record(std::string const &name, Args const &...args) {
        std::string entry = name;
        if constexpr (sizeof...(Args) > 0) {
            std::string joined;
            ((joined += (joined.empty() ? "" : ", ") + detail::format_arg(args)), ...);
            entry += "(" + joined + ")";
        }
        detail::timeline().push_back(entry);
    }

    template <typename Policy>
    void reset() {
        detail::timeline().clear();
        if constexpr (detail::has_reset<Policy>::value) {
            Policy::reset();
        }
    }

    // Actor context for tests: records what the actor sends instead of routing it.
    struct RecordingContext {
        template <typename Owner, typename Evt>
        static bool schedule(Evt const & /*evt*/, uint16_t ms, bool periodic) {
            detail::timeline().push_back(std::string("schedule ") + EventDescriptor<Evt>::name +
                                         (periodic ? " every " : " ") + std::to_string(ms) + "ms");
            return true;
        }

        template <typename Owner, typename Evt>
        static void cancel() {
            detail::timeline().push_back(std::string("cancel ") + EventDescriptor<Evt>::name);
        }

        template <typename Evt>
        static void post(Evt const & /*evt*/) {
            detail::timeline().push_back(std::string("post ") + EventDescriptor<Evt>::name);
        }
    };

    // ----------------------------------------------------------------------
    // Model-test trace capture (FA_SIM)
    // ----------------------------------------------------------------------
    namespace detail {
#ifdef FA_SIM
        // Nesting depth of active trace(...) captures.
        inline int capture_depth = 0;

        // Runs fn with the console trace redirected; returns what fn printed.
        template <typename Fn>
        std::string capture(Fn &&fn) {
            std::ostringstream captured;
            std::streambuf *original = std::cout.rdbuf(captured.rdbuf());
            ++capture_depth;
            fn();
            --capture_depth;
            std::cout.rdbuf(original);
            return captured.str();
        }

        // Runs fn without printing its trace, except into an enclosing trace(...) capture.
        template <typename Fn>
        void quietly(Fn &&fn) {
            const bool inside_trace = capture_depth > 0;
            std::string printed = capture(fn);
            if (inside_trace) {
                std::cout << printed;
            }
        }

        inline std::string strip_ansi(std::string const &s) {
            std::string out;
            for (size_t i = 0; i < s.size(); ++i) {
                if (s[i] == '\033') {
                    while (i < s.size() && s[i] != 'm') ++i;
                } else {
                    out += s[i];
                }
            }
            return out;
        }

        // Extracts [ACTION] / [TRANSITION] lines from the FA_SIM console trace (fa_trace.hpp).
        inline steps parse_trace(std::string const &console) {
            steps out;
            std::istringstream lines(strip_ansi(console));
            std::string line;
            const std::string action_tag = "[ACTION] ";
            const std::string transition_tag = "[TRANSITION] ";
            const std::string arrow = " ===> ";
            while (std::getline(lines, line)) {
                if (auto p = line.find(action_tag); p != std::string::npos) {
                    out.push_back(line.substr(p + action_tag.size()));
                } else if (auto q = line.find(transition_tag); q != std::string::npos) {
                    std::string t = line.substr(q + transition_tag.size());
                    if (auto a = t.find(arrow); a != std::string::npos) {
                        t.replace(a, arrow.size(), "->");
                    }
                    out.push_back(t);
                }
            }
            return out;
        }
#else
        // Firmware code path: the engine prints nothing, so there is nothing to silence.
        template <typename Fn>
        void quietly(Fn &&fn) {
            fn();
        }
#endif
    }

#ifdef FA_SIM
    template <typename Fn>
    steps trace(Fn &&fn) {
        return detail::parse_trace(detail::capture(fn));
    }

    template <typename M, typename Evt>
    steps trace(M &machine, Evt const &evt) {
        return trace([&] { M::dispatch(machine, evt); });
    }
#endif // FA_SIM

    template <typename M>
    void start(M &machine) {
        detail::quietly([&] { M::start(machine); });
    }

    template <typename M, typename Evt>
    void send(M &machine, Evt const &evt) {
        detail::quietly([&] { M::dispatch(machine, evt); });
    }

} // namespace Fa::test

#endif // FA_TEST_HPP
