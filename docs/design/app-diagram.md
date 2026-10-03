# Application diagram — design

Status: **agreed in discussion (2026-10-03), not implemented**: decisions in section 9; event payloads (phase 1) done in 0.0.8.
Scope: FreeActors v1.x — a component-level model of the whole application, drawn in VS Code, from which the framework wiring is generated and checked; later the place where the running system is shown live.

## Goals

- A designer starts from the application: which components exist and how they talk; then drills into each one (an actor's state machine, a module's `task()`).
- **No hand-written wiring**: `Fa::Application<...>`, `AppTraits`, `ActorTraits`/`TimeServiceTraits`, the FreeRTOS hooks and the interrupt glue are generated and tool-owned.
- **Check what the compiler cannot** (or only checks with unreadable template errors), on the diagram, before compiling.
- **Friendly to C developers**: the user writes function bodies and board functions; every template and trait lives in generated files ([decision: keep templates for now], user files stay templates but carry no wiring).
- Vendor-neutral, like the rest of the framework: the diagram names board functions and interrupt sources, never vendor registers.

Non-goals (v1): several instances of a machine, publish/subscribe, more than one board per build, generating board drivers.

## 1. The model: `<app>.app.json`

A new file type next to the `*.hsm.json` models, with its own custom editor (same canvas code as the HSM editor).

```json
{
  "name": "Timebomb",
  "board": { "type": "Board::NucleoF446ZE", "header": "bsp_nucleo_f446ze.hpp" },
  "features": { "trace": true, "commands": true, "health": true, "debug_commands": false },
  "settings": { "MaxTimers": 16, "HealthCheckMs": 100, "MaxStepMs": 500, "WatchdogTimeoutMs": 1000 },
  "components": [
    { "id": "c1", "kind": "actor", "name": "Timebomb", "model": "Timebomb.hsm.json",
      "priority": 2, "queue": 8, "stack": 128, "x": 400, "y": 120 },
    { "id": "c2", "kind": "periodic", "name": "ButtonPoller", "period_ms": 5,
      "priority": 3, "stack": 128, "x": 120, "y": 120 },
    { "id": "c3", "kind": "source", "name": "UserButton", "source": "pin", "x": 0, "y": 120 }
  ],
  "connections": [
    { "id": "l1", "from": "c3", "to": "c2", "kind": "signal", "label": "Hw::read_button()" },
    { "id": "l2", "from": "c2", "to": "c1", "kind": "event", "events": ["ButtonPressed"] }
  ]
}
```

Actors keep their own `*.hsm.json` (reusable, editable on their own); the application model only references them.

### 1.1 Components (boxes)

| Kind | Framework building block | Properties | Drill down (double-click) |
|---|---|---|---|
| `actor` | `Fa::Hsm` + task + queue | model file, priority, queue length, stack, `MaxStepMs`, `MaxIdleMs` | its `*.hsm.json` in the HSM editor |
| `periodic` | `TimeServiceInterface` | period, priority, stack, budgets | its `task()` in the module file |
| `mpsc` | `MpscServiceInterface` | item type, buffer size, priority, stack | its `consume`/`consume_batch` |
| `spsc` | `SpscServiceInterface` | item type, buffer size, priority, stack | as above |
| `dma` | `DmaRingInterface` | element type, buffer size, priority, stack | as above, plus the board's `rx_stream_start` |
| `interrupt` | an interrupt module (`InterruptInterface`, section 4.1) | priority, expected rate; its `IRQNum` comes from the board | its `handler()` in the module file |
| `subsystem` | none at run time: groups components | default priority band, stack, queue and health budgets for its components | its contents |
| `source` | existing C code or an SDK callback delivering events (task context) | what it delivers | the generated C entry point it calls |

The board is the frame around the diagram; its required functions are the union of the components' hardware requirements.

### 1.3 Hierarchy: the application is the root component

As states nest in the HSM editor, components nest: the **application** is the root (its border is the board), **subsystems** contain components and other subsystems (e.g. `Comms`: the UART DMA ring and the command actor), leaves are actors, modules, services and interrupt modules. The model uses the same `parent` field as `*.hsm.json`, and the editor shares the HSM canvas code (nested boxes, reparenting by dragging, arrows across levels).

- An arrow crossing a subsystem's border is part of its interface; the editor shows it as a **port** on the border, labelled with what passes through. Arrows that stay inside are internal.
- In v1 a subsystem is **structure, not machinery**: generation flattens the hierarchy into the same `Fa::Application` module list as today. It carries defaults for its components and names (`Comms/CmdParser` in trace and health output, `filter Comms` in `fa-trace`).
- Ports are not enforced at run time in v1 (routing stays by type); that belongs with multi-instance in v2, where subsystems become reusable, instantiable units.
- One application per `*.app.json` (one root).

### 1.2 Connections (arrows)

| Kind | Means | Generated or checked against |
|---|---|---|
| `event` | posts these events to an actor | the receiver's signals; `post` (from interrupt modules `IsrCtx::post`) |
| `item` | pushes items into a service | the service's item type; `mpsc_push` / `spsc_push` (`IsrCtx::push`) |
| `stream` | an interrupt module reports DMA progress to a ring | `IsrCtx::stream<Ring>` |
| `signal` | a component reads hardware (documentation only) | — |

Timers are not drawn (an actor's own `schedule`); the box shows a clock badge if its model schedules events.

## 2. Events and their data

Event structs belong to the user, not the tool (since 0.0.8): `<name>_events.hpp` is created once with an empty struct per signal, new signals are appended, and the user adds fields with default values (`struct Temperature { int16_t celsius = 0; };`). The generated `<name>_event_list.hpp` holds the `Event` variant and the names. The diagram therefore never defines payloads: arrows name events, taken from the receiver's model.

The PC side (trace dictionary, `fa-trace post` with field values) learns field layouts by reading the user's header on export (best effort, like the hardware requirements parser), with a `static_assert` on each parsed event's size so a struct changed without re-exporting fails the build instead of garbling commands. Events it cannot read fall back to raw bytes. The simulator needs no payloads: it runs the model, where guards are set by hand and actions are only recorded.

**Who owns an event**: the receiving machine, as today. Routing is by type and every event type has exactly one receiving actor, so the receiver's model and events header are the natural home; the diagram offers the receiver's signals when an arrow is drawn.

## 3. Checks on the diagram

Shown on the box or arrow concerned, as errors (export refused) or warnings:

| Check | Severity |
|---|---|
| An event drawn into an actor that its model does not accept | error |
| An event type accepted by two actors (single-receiver rule) | error |
| An SPSC service with more than one producer, or with producers of both kinds (task and ISR) | error (today it corrupts silently) |
| An item type owned by two services of the same kind | error |
| An interrupt module's priority not allowed for FreeRTOS, or two interrupt modules on one interrupt | error (also a `static_assert`) |
| A model file missing or invalid | error |
| An actor that nothing posts to and that schedules nothing | warning |
| An event an actor accepts that no arrow delivers (other than timers) | warning (often posted by the PC in tests) |
| Priorities: a service fed by an interrupt at the lowest priority; equal priorities on a producer and consumer of a full-rate stream | warning |
| `WatchdogTimeoutMs` below 3 × `HealthCheckMs` | error (also a `static_assert`) |

## 4. What is generated

| File | Owner | Content |
|---|---|---|
| `<app>_app.hpp` | tool | includes; `AppTraits` from features and settings; `ActorTraits` / `TimeServiceTraits` specialisations from the box properties; `using Application = Fa::Application<AppTraits, ...>` in diagram order |
| `<app>_app.cpp` | tool | `vApplicationTickHook`, `vApplicationGetIdleTaskMemory`, `vApplicationStackOverflowHook` (calls an optional board hook), `app_start()` |
| `app_api.h` | tool | **C API** for code outside FreeActors running in tasks (existing C code, SDK callbacks): `void app_post_button_pressed(void);`, `void app_post_temperature(int16_t celsius);` |
| `<module>_module.hpp` | user, created once | a periodic module, service or interrupt module: the generated shell (template header, `post`/`IsrCtx`, `Hw`, `FA_IDE` block as for actors) with an empty `task()` / `consume_batch()` / `handler()` to fill in |
| `<app>_on_init.cpp` | user, created once (optional) | `void app_on_init()`: code outside FreeActors started before the scheduler (legacy C tasks, an SDK's stack) |
| `main.cpp` (firmware) | tool | `int main() { app_start(); }` |

**Vendor start-up is the board's**: `Hw::init()` (already called first by `Application::init`) does the vendor's HAL/SDK initialisation and the clock tree; vendor glue such as `HAL_InitTick`/`HAL_GetTick` lives in the board's source. `app_start()` runs `Hw::init()`, the optional `app_on_init()`, installs the vector table, creates the tasks and starts the scheduler.

**Traits move out of the actor header.** Today `ActorTraits` sits at the end of the user-owned actor header. With an application model it is generated in `<app>_app.hpp`; the actor header's block is wrapped in `#ifndef FA_APP_MANAGED` (the patcher does this once), and `<app>_app.hpp` defines `FA_APP_MANAGED` before including the actors. Actors used without an application model keep their defaults.

### 4.1 Interrupts

Whether a source is an interrupt is **architecture** (the designer's: rates, latency, queue sizes, priorities); how it is wired on a chip is **vendor detail** (the board engineer's: vector, flags, registers). Interrupts are therefore a module kind of their own, written by the designer, vendor-neutral, with the vendor parts taken from the board:

```cpp
template <typename Hw, typename IsrCtx>
struct ButtonIsr : Fa::InterruptInterface<ButtonIsr<Hw, IsrCtx>> {
    static constexpr IRQn_Type IRQNum = Hw::button_irq;   // which interrupt: the board's (CMSIS number)
    static constexpr uint32_t PRI = 10;                   // the designer's priority
    static void handler() {
        if (Hw::button_ack()) {                            // acknowledge: the board's
            IsrCtx::post(Timebomb::ButtonPressed{});       // what it means: the application's
        }
    }
};
```

- **`IsrCtx`** replaces `Ctx` for interrupt modules and offers only what is allowed in an interrupt: `post(evt)`, `push(item)`, `stream<DmaRing>(position)`, `trace(...)`. No blocking calls, no timers, no task context: the post/postFromISR mix-up cannot be written. Each call yields itself when a task was woken (`portYIELD_FROM_ISR` only pends PendSV on Cortex-M, so several calls in one handler are harmless); no `woken` plumbing.
- **Compile-time checks**: routing (one receiver per event, one owner per item type, a registered DMA ring); **one producer per SPSC service** (the application sees every interrupt module's pushes); `PRI` allowed for FreeRTOS (`>= configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY`); no two modules on one `IRQNum`.
- **The vector table is built by `Fa::Application`** from the interrupt modules: a `constexpr` table in flash (core entries by their CMSIS names and FreeRTOS's port handlers, `vPortSVCHandler`, `xPortPendSVHandler`, `xPortSysTickHandler`; each module's `handle()`; every other slot a default handler that reports *"interrupt N fired but is not in the application's vector table"*). `Application::init` points VTOR at it, sets each priority and enables each interrupt. No vector names, no `extern "C"`, no RAM copy; the startup file and linker script stay as they are. Needs VTOR (Cortex-M3/M4/M7/M33, most M0+). Systems whose vector table is owned by something else (a bootloader forwarding interrupts, Nordic's SoftDevice) keep the vendor table and bind by hand (`FA_BIND_ISR`, fallback).
- **`handle()`** (the address in the table) wraps `handler()` with the health probe, an interrupt-storm counter (a flag never cleared is reported as a health fault, not a silent watchdog reset) and the trace source id (`[POST] from Button` instead of `ISR`).
- **The board** provides `button_irq` and `button_ack()` like any requirement, checked by the existing hardware contract; the device's interrupt count (`irq_count`) sizes the table.
- **Tests**: `ButtonIsr<TestBsp, TestIsrCtx>::handler()` called from an actor test fires the interrupt through the real code; `TestIsrCtx` records posts and pushes.

## 5. The editor

- A custom editor for `*.app.json`, sharing the canvas, pan/zoom and dialog code with the HSM editor (`media/`), with new box and arrow kinds.
- Properties panel per box and arrow; event pickers filled from the receiver's model.
- Double-click: an actor opens its `*.hsm.json`; a module or service opens its source file at `task()` / `consume_batch()`.
- Errors and warnings from section 3 shown on the diagram and in VS Code's Problems panel.
- **Export Application**: regenerates the tool-owned files and creates the missing user-owned ones; it also exports every referenced HSM model, so one click updates the whole project.

## 6. Live view (trace phase 3)

With `fa-trace` connected (the extension runs the decoder and owns the serial port), the same diagram shows the running system:

- each arrow counts and briefly highlights the events it carries (POST records already name sender and receiver);
- each actor shows its current state (STATES), each box its queue high-water mark, health status and free stack (HEALTH); faults turn the box red, paused tasks grey;
- double-clicking an actor opens its HSM with the current state highlighted.

## 7. Phases

1. **Event payloads** (section 2): user-owned event structs (done in 0.0.8); field layouts read for the trace dictionary and `fa-trace` (done in 0.0.8).
2. **Model and editor**: `*.app.json`, components, connections, drill-down; no generation yet.
3. **Checks** (section 3).
4. **Generation** (section 4), with the Timebomb project migrated to it and verified on the board; the POSIX test application generated from a model as well.
5. **Live view** (section 6).

Each phase ships as a release of the extension.

## 8. Testing

| What | How |
|---|---|
| Payloads | events headers with fields parsed into the dictionary; actor tests posting events with data; `post_by_index` with payloads in the POSIX test; `fa-trace` encoding round trip |
| Checks | fixture `*.app.json` files, one per rule, run through the checker from `tests/gen.js` (like the conflicting HSM model today) |
| Generation | the POSIX application and the target-compile application generated from fixture models instead of hand-written, so the existing runtime and size checks cover the generated wiring |
| Editor | the webview rendered headless (as for the README screenshot) for a smoke test of loading and drawing a model |
| Board | Timebomb from its application model: trace, commands, health, as verified today |

## 9. Decisions

1. **`main` is generated**; vendor start-up belongs to the board (`Hw::init()`); an optional user hook `app_on_init()` starts code outside FreeActors.
2. **Interrupts are C++ template modules** (`InterruptInterface<I>`, `template <typename Hw, typename IsrCtx>`) with an interrupt-only context; the interrupt number comes from the board inside the module, so the `Fa::Application` list only names modules; the vector table is built at compile time and installed through VTOR (section 4.1). Plain-C interrupt functions with a generated `app_isr.h` were considered and set aside for now (they would need interrupt numbers in the application's definition).
3. **One application per `*.app.json`**, the root of a component hierarchy; subsystems are structural in v1 (section 1.3).
