# Health monitoring and watchdog management — design

Status: **implemented** (library, tests, reference board). Scope: FreeActors v1.0.

## Goals

- Detect a task that stopped doing its work: stuck in one step, starved of CPU, or no longer iterating.
- Reset the chip through the hardware watchdog when that happens, and say why at the next start-up.
- Need no code in the modules: no heartbeats to send, nothing to forget.
- Stay vendor-neutral: the board starts and feeds its watchdog; the framework decides when.

## 1. What the framework measures

The framework runs every task's loop: actors, periodic modules (`TimeServiceInterface`), MPSC/SPSC/DMA services, and the built-in trace and command services. Each loop brackets every **unit of work** with a probe:

| Task kind | Unit of work | Work pending |
|---|---|---|
| Actor | one run-to-completion step (`dispatch`), and the start-up step | events in its queue |
| Periodic module | one `task()` call | always (an iteration is due every period) |
| MPSC / SPSC / DMA service | one consumed span (`consume` / `consume_batch`) | items or data not yet consumed |

The probe (`Fa::ProgressProbe`, `fa_health.hpp`) is three words written only by the task itself:

```cpp
progress     // units of work completed
busy_since   // tick when the current unit started | 1, or 0 when not busy
max_step     // longest unit so far (reported by the health command)
```

Cost per unit of work: two tick reads and a few stores. Without `FA_HEALTH` the probes are empty and compile to nothing.

## 2. Faults

Every `HealthCheckMs` the monitor compares each probe with the clock (`Fa::ProgressWatch`):

| Fault | Condition | Typical causes |
|---|---|---|
| **Stuck** | busy in one unit of work longer than `MaxStepMs` | endless loop, deadlock on a mutex, a driver blocking forever, priority inversion |
| **NoProgress** | work pending, not busy, and no progress for longer than `MaxStepMs` (periodic modules: 3 × period + `MaxStepMs`) | starved by higher priorities, task suspended or deleted, periodic module stopped |
| **Idle** (opt-in) | no progress at all for longer than `MaxIdleMs` | input that should arrive regularly (a sensor interrupt, a DMA stream) stopped |

Waiting for work is never a fault: an actor blocked on an empty queue is healthy however long it waits. The NoProgress clock starts when work is first seen pending, not at the last completed step, so a long idle period followed by an event is not mistaken for a stall. The monitor sees progress at its next check, so measured times can be up to one check period late.

Faults the per-task checks cannot see are still caught, because the monitor itself runs at the lowest application priority:

- livelock (actors bouncing events forever: their `progress` advances) and CPU overload: the monitor never runs, so the watchdog is never fed;
- interrupts stuck off: the tick stops, nothing runs.

These resets arrive without a recorded fault ("started after: watchdog" alone). Not detected: logic errors (a task running normally in the wrong state) and steps that are slow but within budget.

## 3. Policy

- The monitor feeds the hardware watchdog only while every task is healthy. After the first fault it **never feeds it again**: the watchdog resets the chip. There is no recovery path in v1; `on_health_fault` can put outputs into a safe state first.
- The first fault is kept in **no-init RAM** (`Fa::health_record`, magic number and checksum). At the next start-up the monitor reports the reset cause and that fault in the trace, then clears it.
- Each fault is reported once (trace record and hook), not at every check.
- Without a hardware watchdog the monitor still detects, traces and calls the hook. Useful on the host and in tests.

## 4. Configuration

`FA_HEALTH` builds `Fa::HealthMonitor` into `Fa::Application`, like the trace service. All settings are optional:

```cpp
struct AppTraits : Fa::DefaultAppTraits {
    static constexpr size_t   HealthCheckMs     = 100;    // how often every task is checked
    static constexpr uint32_t MaxStepMs         = 500;    // default budget for every task
    static constexpr uint32_t WatchdogTimeoutMs = 1000;   // at least 3 x HealthCheckMs (checked at compile time)
    using Watchdog = MyWatchdog;                          // default: the board (Platform)
    static void on_health_fault(uint8_t task, Fa::HealthFault fault, uint32_t elapsed_ms) noexcept;
};
// Per task, in ActorTraits<A> or TimeServiceTraits<S>:
static constexpr uint32_t MaxStepMs = 2000;   // this task's budget
static constexpr uint32_t MaxIdleMs = 200;    // opt in to the Idle check
```

The built-in trace service has `MaxStepMs = 2000`: a full trace buffer over a 115 200-baud UART takes a while to send. A task that legitimately blocks for long inside one step (e.g. a flash erase) raises its own budget; such waits usually belong in a service.

Task indices: actors first (the same indices as in the trace), then periodic modules and services in module order, then the built-in trace and command services. At most 32 tasks.

## 5. Board contract (vendor-neutral, all optional)

```cpp
static void watchdog_start(uint32_t timeout_ms) noexcept;   // start the hardware watchdog; called once by the monitor
static void watchdog_kick() noexcept;                        // feed it
static Fa::ResetCause reset_cause() noexcept;               // why the chip last started
```

The contract assumes the watchdog **cannot be stopped or reconfigured** once started, which is true of most parts:

| Family | Watchdog | Notes |
|---|---|---|
| STM32 | IWDG (LSI clock) | LSI frequency varies widely (on the F4: 17–47 kHz): timeouts are approximate. Freeze it in debug (DBGMCU) so breakpoints do not reset. Reset cause from `RCC_CSR`. |
| NXP Kinetis | WDOG | Unlock sequence and a short configuration window after reset; often disabled in start-up code, which must instead leave it to `watchdog_start`. |
| NXP LPC, i.MX RT | WWDT / RTWDOG | Feed sequence of two writes. |
| TI TM4C | WDT | Interrupt on first timeout, reset on the second: `watchdog_start` sets the load to half the timeout. |
| Microchip SAM4 | WDT | **Enabled at reset**, mode register **write-once**: the board must configure it in `init()` (before the scheduler) and make `watchdog_start` a no-op. |
| Nordic nRF52 | WDT | Cannot be stopped or reconfigured until reset; feed through a reload-request register. |

Reset cause registers: STM32 `RCC_CSR`, Kinetis `RCM_SRS0/1`, nRF52 `POWER->RESETREAS`, SAM4 `RSTC_SR`, TM4C `RESC`. Clear them once read, or the next start reports a stale cause.

No-init RAM needs a `NOLOAD` section in the linker script, outside the region the start-up code zeroes:

```
.noinit (NOLOAD) : { . = ALIGN(4); *(.noinit) *(.noinit*) . = ALIGN(4); } > RAM
```

`FA_NOINIT` (default `__attribute__((section(".noinit")))`) can name a different section.

## 6. Reporting

| Where | What |
|---|---|
| Trace record `HEALTH_FAULT` (kind 9) | `actor` = task index; `id` = bit 15 previous run, bits 12–14 fault, bits 0–11 elapsed ms (capped at 4095) |
| Trace record `HEALTH_RESET` (kind 10) | `actor` = 0xFB (health); `id` = reset cause: 0 unknown, 1 power-on, 2 pin, 3 software, 4 watchdog, 5 brown-out, 6 low-power, 7 other |
| Frame `MODULES` (0x06), after `HELLO` | `u8 count` · per task: `u8 name_length` · name |
| Command `QUERY_HEALTH` (0x86) | `u8 command_sequence`; refused (not supported) without `FA_HEALTH` |
| Frame `HEALTH` (0x07) | `u8 command_sequence` · `u8 reset cause` · `u8 failed` · `u32 uptime ms` · `u8 count` · per task: `u8 status` (fault, 0 ok) · `u16 longest step ms` · `u16 free stack words` (0xFFFF unknown: needs `INCLUDE_uxTaskGetStackHighWaterMark 1`) |

Health records bypass the trace filter's actor mask (their `actor` field is a task index); the kind mask still applies (`filter health`).

In `fa-trace`:

```
    100.990 ms  health     [RESET] started after: watchdog
    100.991 ms  health     [HEALTH] Button no progress for 750 ms with work waiting   (previous run: caused the reset)
fa> health
--- HEALTH #3: started after watchdog, up 6.3 s, watchdog fed
    task            status       longest step  free stack
    Timebomb        ok           0 ms          84 words
    Button          ok           1 ms          100 words
```

## 7. Pausing tasks from the PC (`FA_DEBUG_COMMANDS`)

`FA_DEBUG_COMMANDS` (needs `FA_TRACE_COMMANDS`) unlocks the commands that stop the machine:

| `fa-trace` | Command | Effect |
|---|---|---|
| `pause <task>` | `PAUSE` (0x87) | the task stops at its next unit-of-work boundary; the health monitor shows it as `PAUSED` and does not check it |
| `resume <task>` | `RESUME` (0x88) | it continues: an actor handles everything queued meanwhile, in order; a periodic module restarts its period (no burst of missed iterations) |
| `health test <task>` | `HEALTH_TEST` (0x89) | paused as a fault: after its budget the monitor reports NoProgress and stops feeding the watchdog, which resets the chip. Proves the whole chain on the real hardware. Needs `FA_HEALTH` |
| `reset` | `RESET` (0x83) | now also needs `FA_DEBUG_COMMANDS` |

Tasks are named as in the `MODULES` frame (`health` lists them); body: `u8 command_sequence` · `u8 task`.

- **Between steps, never inside one.** The framework's loop checks a pause gate at each unit-of-work boundary. A paused actor has already taken its next event and holds it, so nothing is handled after the `pause`; a paused task holds no lock it would not hold between steps.
- **The framework's own services are refused** (`not allowed`): a paused command service could never receive the `resume`.
- **No asserts caused by the pause.** Posts and timers keep filling a paused actor's queue, and a service fed by an interrupt or DMA overruns; while paused (and until the first drain after resuming) these are counted without `FA_ASSERT`.
- **Release builds leave `FA_DEBUG_COMMANDS` off.** The command input is not authenticated; without the switch these commands are answered `not supported`. Observing and driving (`post`, `states`, `health`, `filter`, `hello`) need only `FA_TRACE_COMMANDS`.

## 8. Testing

| What | How |
|---|---|
| Fault decisions | `tests/health_test.cpp`: scripted ticks for each fault, idle-then-event, long steps with events waiting, periodic modules, tick wrap-around, tick 0, the no-init record |
| On FreeRTOS | POSIX run with `FA_HEALTH`: the whole existing run must raise no fault while the watchdog is fed every check; then a hung periodic module (Stuck, feeding stops), a suspended actor with an event waiting (NoProgress), a silenced SPSC producer (Idle); the first fault kept in the no-init record; a pre-loaded record reported at start-up; the `HEALTH` reply decoded |
| Target build | Cortex-M4 compile with `FA_HEALTH`, inside the 256-byte stack-frame limit |
| Pause commands | POSIX run: a paused actor handles nothing, its full queue drops without asserting (also in the build with assertions), no health fault; `resume` handles the kept events in order; a paused periodic module skips iterations and resumes at its normal rate; built-in services refused; `health test` gives NoProgress |
| Reference board | Nucleo-F446ZE IWDG: fed for minutes without a spurious reset; `RESET` command reports a software reset; halting the core with the IWDG freeze off makes the watchdog reset the chip, and the next start reports "started after: watchdog"; `pause` / `resume` on an actor and the button module; `health test Button` resets the board through the watchdog and the next start reports the fault |
