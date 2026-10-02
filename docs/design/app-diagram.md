# Application diagram — design

Status: **proposal for review**. Nothing here is implemented yet.
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
| `source` | an interrupt, a DMA stream, a pin, or existing C code | what it is (`isr`, `dma`, `pin`, `external`) | the generated C entry point it calls |

The board is the frame around the diagram; its required functions are the union of the components' hardware requirements.

### 1.2 Connections (arrows)

| Kind | Means | Generated or checked against |
|---|---|---|
| `event` | posts these events to an actor | the receiver's signals; `post` / `post_from_isr` |
| `item` | pushes items into a service | the service's item type; `mpsc_push` / `spsc_push(_from_isr)` |
| `stream` | DMA hardware fills a ring | `dma_progress_from_isr` |
| `signal` | a component reads hardware (documentation only) | — |

Timers are not drawn (an actor's own `schedule`); the box shows a clock badge if its model schedules events.

## 2. Events and their data

**Today events cannot carry data**: signals in `*.hsm.json` are bare names, and the tool-owned `<name>_events.hpp` always writes `struct Tick {};` — fields added by hand are lost at the next export. The application diagram makes data between components visible, so this has to be fixed first.

Proposal: signals in the HSM model may declare fields:

```json
"signals": [ "Tick", { "name": "Temperature", "fields": [ { "name": "celsius", "type": "int16_t" } ] } ]
```

generating

```cpp
struct Temperature {
    int16_t celsius;
    Temperature() = default;
    explicit Temperature(int16_t celsius) : celsius(celsius) {}   // named parameter: shown by completion
};
```

- Field types limited to fixed-width integers, `bool`, `float`, and fixed-size arrays of them: trivially copyable, so events stay safe to queue, to post from interrupts and to rebuild from bytes (`post_by_index`, commands from the PC).
- The trace dictionary records each event's fields, so `fa-trace` can show payloads and `post Sensor Temperature 21` can encode them by name.
- Plain strings remain valid in `signals` (no fields): existing models keep working.

**Who owns an event**: the receiving machine, as today. Routing is by type and every event type has exactly one receiving actor, so the receiver's model is the natural home; the diagram offers the receiver's signals when an arrow is drawn. (A shared, application-owned interface header was considered; it would need a second event-ownership rule in the generator and gains little while one event type has one receiver.)

## 3. Checks on the diagram

Shown on the box or arrow concerned, as errors (export refused) or warnings:

| Check | Severity |
|---|---|
| An event drawn into an actor that its model does not accept | error |
| An event type accepted by two actors (single-receiver rule) | error |
| An SPSC service with more than one producer, or with producers of both kinds (task and ISR) | error (today it corrupts silently) |
| An item type owned by two services of the same kind | error |
| A source of kind `isr`/`dma` posting to an actor: must use the ISR path | generated correctly; error if drawn from a task-only component |
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
| `app_api.h` | tool | **C API** for every source arrow: `void app_post_button_pressed(void);`, `void app_post_temperature_from_isr(int16_t celsius, BaseType_t *woken);`, `void app_uart_rx_progress_from_isr(size_t position, BaseType_t *woken);` — callable from C files, vendor callbacks and existing firmware |
| `<module>_module.hpp` | user, created once | a periodic module or service: the generated shell (template header, `post`, `Hw`, `FA_IDE` block as for actors) with an empty `task()` / `consume_batch()` to fill in |
| `main.cpp` (firmware) | user, created once | `int main() { board_early_init(); app_start(); }` |

**Traits move out of the actor header.** Today `ActorTraits` sits at the end of the user-owned actor header. With an application model it is generated in `<app>_app.hpp`; the actor header's block is wrapped in `#ifndef FA_APP_MANAGED` (the patcher does this once), and `<app>_app.hpp` defines `FA_APP_MANAGED` before including the actors. Actors used without an application model keep their defaults.

Interrupt handlers stay in board code (their names are vendor-specific: `USART3_IRQHandler`, `UARTE0_UART0_IRQHandler`, ...); they call the generated C entry points. The diagram lists which entry points each source needs.

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

1. **Event payload fields** (section 2): model, generator, trace dictionary, `fa-trace` encoding. Useful on its own, needed by everything after it.
2. **Model and editor**: `*.app.json`, components, connections, drill-down; no generation yet.
3. **Checks** (section 3).
4. **Generation** (section 4), with the Timebomb project migrated to it and verified on the board; the POSIX test application generated from a model as well.
5. **Live view** (section 6).

Each phase ships as a release of the extension.

## 8. Testing

| What | How |
|---|---|
| Payload fields | generator fixtures with fields; actor tests posting events with data; `post_by_index` with payloads in the POSIX test; `fa-trace` encoding round trip |
| Checks | fixture `*.app.json` files, one per rule, run through the checker from `tests/gen.js` (like the conflicting HSM model today) |
| Generation | the POSIX application and the target-compile application generated from fixture models instead of hand-written, so the existing runtime and size checks cover the generated wiring |
| Editor | the webview rendered headless (as for the README screenshot) for a smoke test of loading and drawing a model |
| Board | Timebomb from its application model: trace, commands, health, as verified today |

## 9. Open decisions

1. **Payload field types**: the list in section 2, or also user-defined structs (harder to show and encode on the PC)?
2. **Where `main` lives**: generated `<app>_app.cpp` plus a tiny user `main.cpp` (proposed), or a fully generated `main`?
3. **Interrupt glue**: generated C entry points called from the board's handlers (proposed), or generated handlers by vendor name (convenient, but vendor-specific)?
4. **One application per folder**, or several `*.app.json` (e.g. variants of a product) sharing models?
