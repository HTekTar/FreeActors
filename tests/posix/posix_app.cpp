// ==========================================================================
// FreeActors runtime integration test on the FreeRTOS POSIX port (tests/run.sh)
// A real Fa::Application with two actors, real tasks, queues, tick and timers, running on Linux:
//   - Timebomb (tests/fixtures/timebomb_app_actor.hpp): blinks with a one-shot Tick timer, cancels it on exit
//   - InitAction counter (below): a periodic Go timer, counted by an internal transition
//   - TimebombButton (tests/fixtures/timebomb_button.hpp): a periodic process module debouncing the button
//   - with FA_TRACE: the built-in trace service writes the trace to the file named by $FA_TRACE_OUT
//     (AppTraits::TraceOut), which run.sh decodes with tools/fa-trace.js and checks
//   - with FA_TRACE_COMMANDS: the built-in command service receives PC command frames through a simulated
//     UART receive DMA (the tick hook); replies (ACK, STATES) appear in the decoded trace
//   - with FA_HEALTH: the built-in health monitor watches every task and feeds HostBoard's simulated
//     watchdog. The whole run must cause no fault; then a hang, a starved actor and an idle service are
//     injected (drop-and-count build only, which gets past the full-queue check)
// A test task (lowest priority) posts events and watches the actors' states and counters.
// Actors have higher priority, so a post() is fully handled before post() returns.
// Prints PASS/FAIL per check and exits non-zero on any failure.
// Built twice by run.sh: with FreeActors assertions (a full queue must stop at the queue-full assertion,
// exit code 3) and with -DFA_NO_ASSERT (a full queue drops and counts events, exit code 0).
// ==========================================================================

#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"

#include "timebomb_app_actor.hpp"
#include "timebomb_button.hpp"
#include "initaction_hsm.hpp"
#include "fa_app.hpp"
#include "fa_spsc.hpp"
#include "fa_test.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <variant>

#ifdef FA_TRACE
// Trace output for the host: frames go to a file, timestamps are microseconds of a monotonic clock.
struct PosixTraceOut {
    static inline FILE *file = nullptr;
    static void trace_write(uint8_t const *data, size_t n) noexcept {
        if (file != nullptr) {
            std::fwrite(data, 1, n, file);
            std::fflush(file);
        }
    }
    static uint32_t trace_timestamp() noexcept {
        using namespace std::chrono;
        return static_cast<uint32_t>(duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count());
    }
    static uint32_t trace_timestamp_hz() noexcept { return 1000000; }
};
#endif

// InitAction actor: once in INNER it schedules Go every GoPeriodMs; each Go runs count() (internal event).
namespace InitAction {
    template <typename HwPolicy, typename Ctx>
    class Actor : public Fa::Hsm<Actor<HwPolicy, Ctx>, Event> {
    public:
        using Context = Ctx;
        using EventType = Event;
        static constexpr uint16_t GoPeriodMs = 20;

        std::atomic<int> go_count{0};

        void entry_ROOT() {}
        void exit_ROOT() {}
        void entry_OUTER() {}
        void exit_OUTER() {}
        void entry_INNER() { this->schedule(Go{}, GoPeriodMs, true); }
        void exit_INNER() {}
        void rootSetup() {}
        void setup() {}
        void count() { ++go_count; }
    };
}

namespace Fa {
    template <typename HwPolicy, typename Ctx>
    struct ActorTraits<InitAction::Actor<HwPolicy, Ctx>> {
        static constexpr size_t QueueLength     = 8;
        static constexpr size_t StackDepthWords = 128;
        static constexpr unsigned Priority      = 3;
        static constexpr const char* Name       = "Counter";
    };
}

// SPSC service fed from the tick hook (interrupt context) with a running sequence number; the consumer
// checks that every number arrives exactly once, in order.
template <typename Hw, typename Ctx>
struct SeqSink;

namespace Fa {
    template <typename Hw, typename Ctx>
    struct TimeServiceTraits<SeqSink<Hw, Ctx>> {
        static constexpr const char* name     = "SeqSink";
        static constexpr size_t stack_size    = 128;
        static constexpr UBaseType_t priority = 2;
        static constexpr uint32_t MaxIdleMs   = 200;   // health: items arrive every tick; silence is a fault
    };
}

template <typename Hw, typename Ctx>
struct SeqSink : Fa::SpscServiceInterface<SeqSink<Hw, Ctx>, uint32_t, 64> {
    static inline std::atomic<uint32_t> received{0};
    static inline std::atomic<uint32_t> gaps{0};
    static inline uint32_t next = 0;

    static void consume_batch(uint32_t const *items, size_t n) noexcept {
        for (size_t i = 0; i < n; ++i) {
            if (items[i] != next) ++gaps;
            next = items[i] + 1;
            ++received;
        }
    }
};

// DMA ring service: the tick hook plays a UART with circular DMA and idle-line detection (bursts of 1..5
// bytes of a running counter, each followed by a position report). The consumer checks every byte.
template <typename Hw, typename Ctx>
struct UartRx;

namespace Fa {
    template <typename Hw, typename Ctx>
    struct TimeServiceTraits<UartRx<Hw, Ctx>> {
        static constexpr const char* name     = "UartRx";
        static constexpr size_t stack_size    = 128;
        static constexpr UBaseType_t priority = 2;
    };
}

template <typename Hw, typename Ctx>
struct UartRx : Fa::DmaRingInterface<UartRx<Hw, Ctx>, uint8_t, 64> {
    using Base = Fa::DmaRingInterface<UartRx<Hw, Ctx>, uint8_t, 64>;
    static inline std::atomic<bool> streaming{false};
    static inline std::atomic<uint32_t> received{0};
    static inline std::atomic<uint32_t> wrong{0};
    static inline std::atomic<uint32_t> not_intact{0};
    static inline uint8_t expected = 0;

    static void on_start() noexcept { streaming = true; }   // a board would start its DMA here

    static void consume_batch(uint8_t const *data, size_t n) noexcept {
        for (size_t i = 0; i < n; ++i) {
            if (data[i] != expected) ++wrong;
            expected = static_cast<uint8_t>(data[i] + 1);
            ++received;
        }
        if (!Base::span_intact()) ++not_intact;
    }
};

// Periodic module that can be told to hang inside one iteration (health monitor test)
template <typename Hw, typename Ctx>
struct Worker;

namespace Fa {
    template <typename Hw, typename Ctx>
    struct TimeServiceTraits<Worker<Hw, Ctx>> {
        static constexpr const char* name     = "Worker";
        static constexpr size_t stack_size    = 128;
        static constexpr UBaseType_t priority = 2;
    };
}

template <typename Hw, typename Ctx>
struct Worker : Fa::TimeServiceInterface<Worker<Hw, Ctx>, 10> {
    static inline std::atomic<uint32_t> hang_ms{0};
    static inline std::atomic<uint32_t> iterations{0};
    static void task() noexcept {
        ++iterations;
        if (const uint32_t ms = hang_ms.exchange(0)) {
            vTaskDelay(pdMS_TO_TICKS(ms));          // stuck inside one iteration
        }
    }
};

// Interrupt modules (fa_interrupt.hpp). On the host the tick hook plays the hardware and calls handle(),
// as the vector table would on the target: the DMA "interrupt" reports the simulated write position, the
// sequence "interrupt" pushes the next number to SeqSink (its only producer).
static std::atomic<size_t> sim_dma_position{0};
static uint32_t sim_sequence = 0;

template <typename Hw, typename IsrCtx>
struct UartRxIsr : Fa::InterruptInterface<UartRxIsr<Hw, IsrCtx>> {
    static constexpr const char* Name = "UartRxIrq";
    static constexpr int IRQNum = Hw::Irq::uart_rx;
    static constexpr uint32_t PRI = 6;
    static void handler() { IsrCtx::template stream<UartRx>(sim_dma_position); }
};

template <typename Hw, typename IsrCtx>
struct SequenceIsr : Fa::InterruptInterface<SequenceIsr<Hw, IsrCtx>> {
    static constexpr const char* Name = "SeqIrq";
    static constexpr int IRQNum = Hw::Irq::sequence;
    static constexpr uint32_t PRI = 7;
    static void handler() { IsrCtx::push(sim_sequence++); }
};

// "Tap" interrupt: posts Go to the counter (the trace names it as the sender); fired once by the test
static std::atomic<bool> tap_pending{false};
template <typename Hw, typename IsrCtx>
struct TapIsr : Fa::InterruptInterface<TapIsr<Hw, IsrCtx>> {
    static constexpr const char* Name = "TapIrq";
    static constexpr int IRQNum = Hw::Irq::tap;
    static constexpr uint32_t PRI = 8;
    static void handler() { IsrCtx::post(InitAction::Go{}); }
};

// A "storm": an interrupt whose flag is never cleared fires back to back. Limited to 10 000/s (10 per tick).
static std::atomic<int> storm_burst{0};
static std::atomic<uint32_t> storm_handled{0};
template <typename Hw, typename IsrCtx>
struct StormIsr : Fa::InterruptInterface<StormIsr<Hw, IsrCtx>> {
    static constexpr const char* Name = "StormIrq";
    static constexpr int IRQNum = Hw::Irq::storm;
    static constexpr uint32_t PRI = 9;
    static constexpr uint32_t MaxRatePerSecond = 10000;
    static void handler() { ++storm_handled; }
};

// Host board for all modules. Like NucleoBsp it declares instance_id = 1, which must not affect routing.
// The button level is set by the test task.
struct HostBoard {
    static constexpr uint8_t instance_id = 1;
    struct Irq {                                 // interrupt numbers of the simulated hardware
        static constexpr int uart_rx  = 3;
        static constexpr int sequence = 4;
        static constexpr int tap      = 5;
        static constexpr int storm    = 6;
    };
    static inline std::atomic<bool> button{false};
    static void init() {}
    static void set_led(bool) {}
    static uint16_t read_adc(uint8_t) { return 0; }
    static bool read_button() { return button; }

    // Simulated hardware watchdog (FA_HEALTH): records start and feeding; "started after a watchdog reset"
    static inline std::atomic<uint32_t> watchdog_timeout{0};
    static inline std::atomic<uint32_t> kicks{0};
    static void watchdog_start(uint32_t timeout_ms) noexcept { watchdog_timeout = timeout_ms; }
    static void watchdog_kick() noexcept { ++kicks; }
    static Fa::ResetCause reset_cause() noexcept { return Fa::ResetCause::Watchdog; }
#ifdef FA_TRACE_COMMANDS
    // Command input with receive DMA (the tick hook plays the DMA); no reset(): RESET is refused
    static inline uint8_t *rx_buffer = nullptr;
    static inline size_t rx_size = 0;
    static inline std::atomic<bool> rx_streaming{false};
    static void rx_stream_start(uint8_t *buffer, size_t n) noexcept {
        rx_buffer = buffer;
        rx_size = n;
        rx_streaming = true;
    }
#endif
};

struct AppTraits : Fa::DefaultAppTraits {
    using Platform = HostBoard;
#ifdef FA_HEALTH
    static constexpr size_t HealthCheckMs = 20;
    static constexpr uint32_t MaxStepMs = 300;
    struct Fault { uint8_t task; Fa::HealthFault fault; uint32_t elapsed_ms; };
    static inline Fault faults[8];
    static inline std::atomic<size_t> fault_count{0};
    static void on_health_fault(uint8_t task, Fa::HealthFault fault, uint32_t elapsed_ms) noexcept {
        const size_t i = fault_count;
        if (i < 8) faults[i] = Fault{task, fault, elapsed_ms};
        ++fault_count;
    }
#endif
#ifdef FA_TRACE
    using TraceOut = PosixTraceOut;                      // trace to a file instead of the board
    static constexpr size_t TraceBufferRecords = 512;
#endif
};

using App = Fa::Application<AppTraits, Timebomb::Actor, InitAction::Actor, TimebombButton, SeqSink, UartRx, Worker,
                           UartRxIsr, SequenceIsr, TapIsr, StormIsr>;
using Work = Worker<HostBoard, App::AppContext>;
using Rx = UartRx<HostBoard, App::AppContext>;
using Sink = SeqSink<HostBoard, App::AppContext>;
using Bomb = Timebomb::Actor<HostBoard, App::AppContext>;
using Counter = InitAction::Actor<HostBoard, App::AppContext>;

#ifdef FA_TRACE_COMMANDS
// The "PC side of the UART": the test task queues command bytes, the tick hook moves them into the DMA buffer
static Fa::SpscRing<uint8_t, 1024> pc_wire;
#endif

static std::atomic<bool> feed_sink{true};   // the health test silences the SPSC producer

template <typename M>
M &instance() {
    return Fa::StaticActorStorage<M>::instance;
}

// --------------------------------------------------------------------------
// FreeRTOS hooks
// --------------------------------------------------------------------------
extern "C" void vApplicationTickHook(void) {
    App::on_tick_isr();
    if (feed_sink) {
        App::run_interrupt<App::module_t<SequenceIsr>>();   // the "sequence interrupt": SeqSink's only producer
    }
    if (tap_pending.exchange(false)) {
        App::run_interrupt<App::module_t<TapIsr>>();
    }
    for (int n = storm_burst.exchange(0); n > 0; --n) {      // the same interrupt, back to back within one tick
        App::run_interrupt<App::module_t<StormIsr>>();
    }

    // Simulated UART + circular DMA: the "hardware" writes a burst, then the idle-line interrupt reports it
    static size_t dma_position = 0;
    static uint8_t next_byte = 0;
    if (Rx::streaming) {
        const size_t burst = 1 + sim_sequence % 5;
        for (size_t i = 0; i < burst; ++i) {
            Rx::buffer()[dma_position] = next_byte++;
            dma_position = (dma_position + 1) % Rx::size;
        }
        sim_dma_position = dma_position;
        App::run_interrupt<App::module_t<UartRxIsr>>();     // the "DMA interrupt": reports the write position
    }

#ifdef FA_TRACE_COMMANDS
    // Simulated command UART + circular DMA: bytes from the PC land in the buffer, then the idle line reports
    static size_t command_position = 0;
    if (HostBoard::rx_streaming) {
        bool arrived = false;
        pc_wire.consume_available([&](uint8_t const *data, size_t n) {
            for (size_t i = 0; i < n; ++i) {
                HostBoard::rx_buffer[command_position] = data[i];
                command_position = (command_position + 1) % HostBoard::rx_size;
            }
            arrived = true;
        });
        if (arrived) {
            App::command_rx_progress_from_isr(command_position, nullptr);
        }
    }
#endif
}

extern "C" void vApplicationGetIdleTaskMemory(StaticTask_t **tcb, StackType_t **stack, configSTACK_DEPTH_TYPE *size) {
    static StaticTask_t idle_tcb;
    static StackType_t idle_stack[configMINIMAL_STACK_SIZE];
    *tcb = &idle_tcb;
    *stack = idle_stack;
    *size = configMINIMAL_STACK_SIZE;
}

extern "C" void vFaAssertFailed(const char *file, unsigned long line) {
    std::printf("ASSERT  configASSERT failed at %s:%lu\n", file, line);
    std::fflush(stdout);
    std::_Exit(3);
}

// --------------------------------------------------------------------------
// Test task
// --------------------------------------------------------------------------
namespace {
    int failures = 0;

    void expect(char const *name, bool ok, char const *detail = "") {
        std::printf("%s  posix: %s%s%s\n", ok ? "PASS" : "FAIL", name, *detail ? " — " : "", detail);
        if (!ok) ++failures;
    }

    // Polls pred once per tick; returns the ticks since `start` at which it became true, or -1 after timeout.
    template <typename Pred>
    long ticks_until(Pred pred, TickType_t start, TickType_t timeout) {
        while (xTaskGetTickCount() - start <= timeout) {
            if (pred()) return static_cast<long>(xTaskGetTickCount() - start);
            vTaskDelay(1);
        }
        return -1;
    }

#ifdef FA_TRACE_COMMANDS
    // Sends one command frame over the simulated UART and gives the target time to handle it
    void send_command(uint8_t type, std::initializer_list<uint8_t> body, bool corrupt = false) {
        uint8_t wire[Fa::frame::MaxEncoded];
        const size_t n = Fa::frame::encode(type, body.begin(), body.size(), wire);
        if (corrupt) wire[1] ^= 0x40;                     // a damaged byte: the CRC must reject the frame
        bool wake = false;
        for (size_t i = 0; i < n; ++i) pc_wire.push(wire[i], wake);
        vTaskDelay(5);
    }

    template <typename Variant, typename T, size_t I = 0>
    constexpr uint8_t event_index() {
        if constexpr (std::is_same_v<std::variant_alternative_t<I, Variant>, T>) return I;
        else return event_index<Variant, T, I + 1>();
    }
#endif

    // Index of a framework task by name (health monitor and pause commands)
    [[maybe_unused]] uint8_t task_index(char const *name) {
        for (size_t i = 0; i < App::watched_count; ++i) {
            if (std::strcmp(App::watched_name(i), name) == 0) return static_cast<uint8_t>(i);
        }
        return 0xFF;
    }

    template <typename S>
    bool bomb_in() {
        return Fa::test::in_state<S>(instance<Bomb>());
    }

    void run_tests(void *) {
        using namespace Timebomb;
        char detail[128];
        const long blink = Bomb::BlinkMs;

        expect("both actors started (Timebomb in DISARMED, counter in INNER)",
               bomb_in<DISARMED>() && Fa::test::in_state<InitAction::INNER>(instance<Counter>()));

        // ---- Timebomb: one-shot timers driving the blink sequence
        App::post(ButtonPressed{});
        App::post(ButtonPressed{});
        expect("two ButtonPressed: DISARMED -> WAIT -> LEDON", bomb_in<LEDON>());

        TickType_t start = xTaskGetTickCount();
        long t = ticks_until([] { return bomb_in<LEDOFF>(); }, start, 500);
        std::snprintf(detail, sizeof detail, "after %ld ticks (expected %ld)", t, blink);
        expect("blink: LEDON -> LEDOFF after one BlinkMs", t >= blink && t <= blink + 3, t < 0 ? "never" : detail);

        t = ticks_until([] { return bomb_in<BOOM>(); }, start, 1000);
        const long boom = 2 * Bomb::BlinksToBoom * blink;
        std::snprintf(detail, sizeof detail, "after %ld ticks (expected %ld)", t, boom);
        expect("TimeUp after 3 blinks: LEDOFF -> BOOM on schedule", t >= boom && t <= boom + 6, t < 0 ? "never" : detail);

        // ---- Timebomb: defuse mid-blink, re-arm at once. A leftover Tick would end the new blink early.
        App::post(ButtonPressed{});                      // BOOM -> DISARMED
        App::post(ButtonPressed{});
        App::post(ButtonPressed{});                      // -> WAIT -> LEDON, Tick pending
        vTaskDelay(20);
        App::post(ButtonPressed{});                      // defuse from LEDON (handled by ARMED); exit_ARMED cancels Tick
        expect("defuse while blinking: LEDON -> DISARMED", bomb_in<DISARMED>());
        App::post(ButtonPressed{});
        App::post(ButtonPressed{});                      // re-arm: WAIT -> LEDON, new Tick
        start = xTaskGetTickCount();
        t = ticks_until([] { return bomb_in<LEDOFF>(); }, start, 500);
        std::snprintf(detail, sizeof detail, "LEDOFF after %ld ticks (a leftover Tick would arrive after ~%ld)", t, blink - 20);
        expect("re-arm after defuse: the new blink lasts a full BlinkMs (no second timer chain)", t >= blink, t < 0 ? "never" : detail);

        // ---- Counter: a periodic timer running alongside the Timebomb all along
        const int c0 = instance<Counter>().go_count;
        start = xTaskGetTickCount();
        vTaskDelay(1000);
        const long elapsed = static_cast<long>(xTaskGetTickCount() - start);
        const int got = instance<Counter>().go_count - c0;
        const long want = elapsed / Counter::GoPeriodMs;
        std::snprintf(detail, sizeof detail, "%d periods in %ld ticks (expected %ld +-1)", got, elapsed, want);
        expect("periodic Go every 20 ms keeps its rate over 1 s (no drift)", got >= want - 1 && got <= want + 1, detail);

        App::cancel<InitAction::Go>();
        const int c1 = instance<Counter>().go_count;
        vTaskDelay(100);
        std::snprintf(detail, sizeof detail, "%d more after cancel", instance<Counter>().go_count - c1);
        expect("cancel stops the periodic timer", instance<Counter>().go_count == c1, detail);

        expect("Timebomb exploded while the counter ran (in BOOM)", bomb_in<BOOM>());

        // ---- DMA ring service: bursts from the simulated UART DMA every tick, all run long
        std::snprintf(detail, sizeof detail, "%u bytes, %u wrong, %u not intact, %u overruns, high water %u",
                      static_cast<unsigned>(Rx::received), static_cast<unsigned>(Rx::wrong),
                      static_cast<unsigned>(Rx::not_intact), static_cast<unsigned>(Rx::overruns()),
                      static_cast<unsigned>(Rx::high_water()));
        expect("DMA ring service: every byte of the DMA stream arrives once, in order, intact, no overruns",
               Rx::received > 3000 && Rx::wrong == 0 && Rx::not_intact == 0 && Rx::overruns() == 0, detail);

        // ---- SPSC service: one item per tick from the tick hook, all run long
        std::snprintf(detail, sizeof detail, "%u received, %u gaps, %u dropped, high water %u",
                      static_cast<unsigned>(Sink::received), static_cast<unsigned>(Sink::gaps),
                      static_cast<unsigned>(Sink::dropped()), static_cast<unsigned>(Sink::high_water()));
        expect("SPSC service: every item from the tick hook arrives once, in order, none dropped",
               Sink::received > 1000 && Sink::gaps == 0 && Sink::dropped() == 0, detail);

        // ---- Periodic process module: TimebombButton samples the button every 5 ms and debounces it
        auto bounce = [](int ticks) {
            for (int i = 0; i < ticks; ++i) {
                HostBoard::button = !HostBoard::button;
                vTaskDelay(1);
            }
        };
        bounce(40);                                        // contacts chatter, never settle
        HostBoard::button = false;
        vTaskDelay(30);
        expect("button module: bouncing contacts post nothing (Timebomb still in BOOM)", bomb_in<BOOM>());

        bounce(10);                                        // a real press: chatter, then held down
        HostBoard::button = true;
        vTaskDelay(60);
        HostBoard::button = false;                         // released
        vTaskDelay(30);
        expect("button module: one debounced press posts exactly one ButtonPressed (BOOM -> DISARMED)",
               bomb_in<DISARMED>());

#ifdef FA_TRACE_COMMANDS
        // ---- Commands from the PC: frames through the simulated receive DMA, replies in the trace
        {
            namespace cmd = Fa::command_frame;
            using Bus = Bomb::EventType;
            const uint8_t pressed = event_index<Bus, ButtonPressed>();
            const uint8_t tick = event_index<Bus, Tick>();
            send_command(cmd::Post, {1, 0, pressed});                  // POST ButtonPressed -> Timebomb
            expect("command POST: the PC's ButtonPressed reaches Timebomb (DISARMED -> WAIT)", bomb_in<WAIT>());
            send_command(cmd::Post, {2, 0, tick, 0x55});               // Tick has no payload: refused
            send_command(cmd::Post, {3, 0, 0});                        // Enter_sig: reserved, refused
            send_command(cmd::Post, {4, 9, pressed});                  // no actor 9
            expect("command POST: wrong payload size, reserved signal, unknown actor post nothing", bomb_in<WAIT>());
            send_command(cmd::QueryStates, {5});
            send_command(cmd::Reset, {6});                             // HostBoard has no reset(): refused
            const uint32_t bad_before = App::Commander::bad_frames();
            send_command(cmd::Post, {7, 0, pressed}, true);            // damaged on the wire
            std::snprintf(detail, sizeof detail, "bad frames %u", static_cast<unsigned>(App::Commander::bad_frames() - bad_before));
            expect("command with a damaged byte: rejected by its CRC, counted, not executed",
                   App::Commander::bad_frames() == bad_before + 1 && bomb_in<WAIT>(), detail);
            send_command(cmd::Post, {8, 0, pressed});                  // WAIT -> LEDON
            send_command(cmd::Post, {9, 0, pressed});                  // defuse: LEDON -> DISARMED
            expect("command POSTs: WAIT -> LEDON -> DISARMED", bomb_in<DISARMED>());
            send_command(cmd::Filter, {10, 0, 0, 0, 0, 0, 0});         // trace off
            expect("command FILTER: masks set", App::Tracer::kinds_mask == 0 && App::Tracer::actors_mask == 0);
            send_command(cmd::Filter, {11, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF});   // back on
            send_command(cmd::HelloRequest, {});
        }

        // ---- Commands encoded by the PC tool (fa-trace --encode, run.sh), one frame at a time
        if (char const *path = std::getenv("FA_COMMANDS_IN")) {
            if (FILE *in = std::fopen(path, "rb")) {
                int byte;
                bool wake = false;
                while ((byte = std::fgetc(in)) != EOF) {
                    pc_wire.push(static_cast<uint8_t>(byte), wake);
                    if (byte == 0) vTaskDelay(5);             // end of a frame
                }
                std::fclose(in);
            }
            expect("commands from fa-trace --encode: three ButtonPressed, WAIT -> LEDON -> DISARMED", bomb_in<DISARMED>());
        }

#ifdef FA_DEBUG_COMMANDS
        // ---- pause / resume from the PC: between steps, no asserts on the full queue, no health fault
        {
            namespace cmd = Fa::command_frame;
            using BombStorage = Fa::StaticActorStorage<Bomb>;
            const uint8_t bomb = task_index("Timebomb");
            const uint32_t dropped_before = BombStorage::dropped;
            const uint32_t steps_before = BombStorage::health_probe.progress;
            send_command(cmd::Pause, {20, bomb});
            for (int i = 0; i < 10; ++i) {
                App::post(ButtonPressed{});                  // 1 taken and held, 8 queued, 1 dropped
            }
            vTaskDelay(450);                                 // longer than MaxStepMs: a paused task is no fault
            std::snprintf(detail, sizeof detail, "dropped %u, health faults %u",
                          static_cast<unsigned>(BombStorage::dropped - dropped_before), static_cast<unsigned>(AppTraits::fault_count));
            expect("pause: a paused actor handles nothing; its full queue drops without asserting; no health fault",
                   bomb_in<DISARMED>() && BombStorage::dropped - dropped_before == 1 && AppTraits::fault_count == 0, detail);
            send_command(cmd::Pause, {21, task_index("FaCmd")});   // the framework's own services: refused
            send_command(cmd::Pause, {22, 99});
            send_command(cmd::QueryHealth, {23});
            send_command(cmd::Resume, {24, bomb});
            vTaskDelay(20);
            std::snprintf(detail, sizeof detail, "%u steps after resume", static_cast<unsigned>(BombStorage::health_probe.progress - steps_before));
            expect("resume: the 9 events kept are handled in order (D-W-LEDON x3, back in DISARMED)",
                   bomb_in<DISARMED>() && BombStorage::health_probe.progress - steps_before == 9, detail);

            const uint8_t worker = task_index("Worker");
            send_command(cmd::Pause, {25, worker});
            const uint32_t paused_at = Work::iterations;
            vTaskDelay(100);
            const uint32_t while_paused = Work::iterations - paused_at;
            send_command(cmd::Resume, {26, worker});
            const uint32_t resumed_at = Work::iterations;
            vTaskDelay(100);
            const uint32_t after = Work::iterations - resumed_at;
            std::snprintf(detail, sizeof detail, "%u iterations while paused, %u in 100 ms after resume (period 10 ms)",
                          static_cast<unsigned>(while_paused), static_cast<unsigned>(after));
            expect("pause a periodic module: no iterations while paused, normal rate after resume (no catch-up burst)",
                   while_paused == 0 && after >= 8 && after <= 12, detail);
        }
#endif
#endif

        // ---- Interrupt modules: a post from an interrupt is attributed to it in the trace
        {
            const int before = instance<Counter>().go_count;
            tap_pending = true;
            vTaskDelay(5);
            expect("interrupt module: TapIrq's post reaches the counter", instance<Counter>().go_count == before + 1);
        }

        // ---- Full queue: posts and timer deliveries never block; lost events are counted (and asserted in debug)
        using BombStorage = Fa::StaticActorStorage<Bomb>;
        const uint32_t dropped_before = BombStorage::dropped;
        vTaskSuspend(BombStorage::taskHandle);
        for (size_t i = 0; i < Fa::ActorTraits<Bomb>::QueueLength; ++i) {
            App::post(ButtonPressed{});                   // fills the suspended actor's queue
        }
#ifndef FA_NO_ASSERT
        std::printf("INFO  posix: queue full, expecting the queue-full assertion next\n");
        std::fflush(stdout);
#endif
        App::post(ButtonPressed{});                       // no room: dropped (asserts here unless FA_NO_ASSERT)
        App::schedule(Tick{}, 1);                         // expires into the full queue: dropped in the tick ISR
        vTaskDelay(5);
        std::snprintf(detail, sizeof detail, "dropped = %u", static_cast<unsigned>(BombStorage::dropped - dropped_before));
        expect("full queue: post() and timer delivery drop instead of blocking, and both are counted",
               BombStorage::dropped - dropped_before == 2, detail);
        vTaskResume(BombStorage::taskHandle);
        expect("actor keeps working: its 8 queued ButtonPressed are handled (DISARMED -> ... -> LEDON)", bomb_in<LEDON>());

#ifdef FA_HEALTH
        // ---- Health monitor: silent through everything above, then three injected faults
        {
            auto index_of = [](char const *name) {
                for (size_t i = 0; i < App::watched_count; ++i) {
                    if (std::strcmp(App::watched_name(i), name) == 0) return static_cast<int>(i);
                }
                return -1;
            };
            auto has_fault = [](int task, Fa::HealthFault kind) {
                const size_t n = AppTraits::fault_count < 8 ? AppTraits::fault_count.load() : 8;
                for (size_t i = 0; i < n; ++i) {
                    if (AppTraits::faults[i].task == task && AppTraits::faults[i].fault == kind) return true;
                }
                return false;
            };
            const long uptime = static_cast<long>(xTaskGetTickCount());
            std::snprintf(detail, sizeof detail, "%u faults, %u kicks in %ld ms, watchdog timeout %u ms",
                          static_cast<unsigned>(AppTraits::fault_count), static_cast<unsigned>(HostBoard::kicks),
                          uptime, static_cast<unsigned>(HostBoard::watchdog_timeout));
            expect("health: no fault during the whole run, watchdog started and fed every check",
                   AppTraits::fault_count == 0 && HostBoard::watchdog_timeout == 1000 &&
                   HostBoard::kicks > static_cast<uint32_t>(uptime / AppTraits::HealthCheckMs / 2), detail);

            const uint32_t bomb_steps = BombStorage::health_probe.progress;
            std::snprintf(detail, sizeof detail, "Timebomb: %u steps, Counter: %u steps", static_cast<unsigned>(bomb_steps),
                          static_cast<unsigned>(Fa::StaticActorStorage<Counter>::health_probe.progress));
            expect("health: actor probes count every run-to-completion step (start-up + each event)",
                   bomb_steps > 30 && Fa::StaticActorStorage<Counter>::health_probe.progress > 40, detail);

            Work::hang_ms = 450;                                // one iteration blocks longer than MaxStepMs (300)
            vTaskDelay(600);
            const uint32_t kicks = HostBoard::kicks;
            vTaskDelay(100);
            std::snprintf(detail, sizeof detail, "faults %u, kicks after the fault %u",
                          static_cast<unsigned>(AppTraits::fault_count), static_cast<unsigned>(HostBoard::kicks - kicks));
            expect("health: a hung periodic module is Stuck, and the watchdog is no longer fed",
                   has_fault(index_of("Worker"), Fa::HealthFault::Stuck) && HostBoard::kicks == kicks, detail);

            vTaskSuspend(BombStorage::taskHandle);              // starved: an event waits, the task never runs
            App::post(ButtonPressed{});
            vTaskDelay(500);
            vTaskResume(BombStorage::taskHandle);
            expect("health: an actor with an event waiting and no progress is NoProgress",
                   has_fault(index_of("Timebomb"), Fa::HealthFault::NoProgress));

            feed_sink = false;                                  // the SPSC producer goes silent
            vTaskDelay(400);
            expect("health: a service whose input stops (MaxIdleMs) is Idle", has_fault(index_of("SeqSink"), Fa::HealthFault::Idle));

            // an interrupt storm: disabled after its limit within one tick, reported as a health fault
            storm_burst = 100;
            vTaskDelay(150);
            std::snprintf(detail, sizeof detail, "%u handled of 100", static_cast<unsigned>(storm_handled));
            expect("health: an interrupt storm is cut off at its limit (10 per tick) and reported",
                   storm_handled == 10 && has_fault(Fa::TraceSender::FirstInterrupt + 3, Fa::HealthFault::Storm), detail);

#ifdef FA_DEBUG_COMMANDS
            send_command(Fa::command_frame::HealthTest, {13, task_index("Counter")});   // idle actor, paused as a fault
            vTaskDelay(500);
            expect("health test from the PC: the paused task counts as NoProgress", has_fault(index_of("Counter"), Fa::HealthFault::NoProgress));
#endif

            expect("health: the first fault (Worker, Stuck) is kept in no-init RAM for the next start-up",
                   Fa::health_record.valid() && Fa::health_record.module == index_of("Worker") &&
                   Fa::health_record.fault == static_cast<uint8_t>(Fa::HealthFault::Stuck));
#ifdef FA_TRACE_COMMANDS
            send_command(Fa::command_frame::QueryHealth, {12});
#endif
        }
#endif

        vTaskDelay(100);   // lets the trace task (lowest priority) send what is still buffered
        std::printf("%s\n", failures == 0 ? "PASS  posix: all runtime checks passed" : "FAIL  posix: runtime checks failed");
        std::fflush(stdout);
        std::_Exit(failures == 0 ? 0 : 1);
    }

    StaticTask_t test_tcb;
    StackType_t test_stack[configMINIMAL_STACK_SIZE];
}

int main() {
#ifdef FA_TRACE
    if (char const *path = std::getenv("FA_TRACE_OUT")) {
        PosixTraceOut::file = std::fopen(path, "wb");
    }
#endif
#ifdef FA_HEALTH
    // As if the previous run had ended in a watchdog reset: the button module (task 2, "Button") stopped iterating
    Fa::health_record.store(2, Fa::HealthFault::NoProgress, 750);
#endif
    App::init();
    xTaskCreateStatic(run_tests, "tests", configMINIMAL_STACK_SIZE, nullptr, 1, test_stack, &test_tcb);
    vTaskStartScheduler();
    return 1;   // not reached: run_tests ends the process
}
