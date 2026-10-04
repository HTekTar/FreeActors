// The values of the Minimal application's diagram (tests/fixtures/app/minimal.app.json) arrive in the generated
// code: features, task settings, the module order. Compiled only (static_asserts), for Cortex-M4 (run.sh).
#include "minimal_app.hpp"
#include <type_traits>

using Ctx = App::Application::AppContext;
using Bomb = Timebomb::Actor<TestBoard, Ctx>;

#ifndef FA_TRACE
#error "the diagram's trace feature did not reach the code"
#endif
#ifdef FA_TRACE_COMMANDS
#error "commands are off in the diagram"
#endif
static_assert(Fa::ActorTraits<Bomb>::QueueLength == 6 && Fa::ActorTraits<Bomb>::StackDepthWords == 160 &&
              Fa::ActorTraits<Bomb>::Priority == 3, "actor task settings from the diagram");
static_assert(Fa::TimeServiceTraits<App::ButtonPoller<TestBoard, Ctx>>::stack_size == 96 &&
              Fa::TimeServiceTraits<App::ButtonPoller<TestBoard, Ctx>>::priority == 2, "periodic module task settings");
static_assert(App::ButtonPoller<TestBoard, Ctx>::period_ms == 5, "the period from the diagram");
static_assert(App::Application::module_t<App::Tap>::PRI == 7, "the interrupt priority from the diagram");
static_assert(App::Traits::HealthCheckMs == 50 && App::Traits::MaxTimers == 8, "application settings");
static_assert(App::Application::actor_count == 1 && App::Application::interrupt_count == 3, "the modules of the diagram");
static_assert(std::is_same_v<App::Application::spsc_services_for<uint16_t>::FirstType, App::Samples<TestBoard, Ctx>>,
              "the SPSC service owns the diagram's item type");
static_assert(std::is_same_v<App::Application::services_for<App::LogLine>::FirstType, App::Log<TestBoard, Ctx>>,
              "the MPSC service owns its own item type, declared in its module file (log_module.hpp)");
