# Application diagram — design

Status: **agreed in discussion (2026-10-03, phase 5 on 2026-10-04)**: decisions in section 10. Done in 0.0.8: event payloads (phase 1) and interrupt modules with the generated vector table (section 4.1). Phases 2 to 4 (model, editor on the shared `media/canvas.js`, checks, generation including the board blueprint) implemented for 0.0.9; Timebomb is generated from its application model and verified on the board. Phase 5 (top-down design, one source of truth for events, the target with the STM32F4 + HAL flavour; section 7) implemented; its acceptance test, Timebomb recreated top-down on the board, is next.
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

**Who owns an event**: the receiving machine, as today. Routing is by type and every event type has exactly one receiving actor, so the receiver's model and events header are the natural home; the diagram offers the receiver's signals when an arrow is drawn. Phase 5 makes this the single source of truth in both directions: events typed on a connection are added to the receiver's machine, and renames and deletions keep the two consistent (section 7.2).

## 3. Checks on the diagram

Implemented in `checkAppModel` (extension), shown as badges on components and connections, as a list in the editor's sidebar (click: selects the component), and in VS Code's Problems panel on the line of the component or connection. Tested by `tests/app_check_test.js` (one variation of the Timebomb application per rule) and the editor test.

| Check | Severity |
|---|---|
| An event drawn into an actor whose state machine has no such signal | error |
| Events into something that is not an actor; items into something that is not an SPSC/MPSC service; a DMA stream into something that is not a DMA ring | error |
| An actor without a state machine, or with a `*.hsm.json` not found next to the application (or not valid) | error |
| One state machine used by two actor components (one instance per machine in v1). Event types are per machine (`Timebomb::Tick`), so two machines never share an event type: this is the single-receiver rule as it can actually be violated | error |
| An SPSC service with more than one producer (the type cannot enforce it; two corrupt it silently) | error |
| Two SPSC (or two MPSC) services for the same item type (pushes are routed by type) | error |
| Items pushed with a type the service does not take | error |
| Two interrupt modules on one interrupt; an interrupt priority more urgent than FreeRTOS allows (`settings.MaxSyscallPriority`, default 5 = `configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY`) | error |
| `WatchdogTimeoutMs` below 3 × `HealthCheckMs`; commands without trace; debug commands without commands | error |
| Names: not a C++ identifier, or two components with one name (the application's own name may equal its main actor's) | error |
| No board type; an interrupt module without its interrupt; a stack under 64 words; a DMA stream not from an interrupt module | warning |
| An actor no component sends events to (fine if it runs on its own timers) | warning |

Not yet: rate and queue-size warnings (they need a rate on each connection).

## 4. What is generated

| File | Owner | Content |
|---|---|---|
| `app.hpp` | tool | includes; `AppTraits` from features and settings; `ActorTraits` / `TimeServiceTraits` specialisations from the box properties; `using Application = Fa::Application<AppTraits, ...>` in diagram order |
| `app.cpp` | tool | `vApplicationTickHook`, `vApplicationGetIdleTaskMemory`, `vApplicationStackOverflowHook` (calls an optional board hook), `app_start()` |
| `app_api.h` | tool | **C API** for code outside FreeActors running in tasks (existing C code, SDK callbacks): `void app_post_button_pressed(void);`, `void app_post_temperature(int16_t celsius);` |
| `<module>_module.hpp` | user, created once (rewritten from the diagram while unedited: a fingerprint line marks a starter file) | a periodic module, service or interrupt module: the generated shell (template header, `post`/`IsrCtx`, `Hw`, `FA_IDE` block as for actors) with an empty `task()` / `consume_batch()` / `handler()` to fill in |
| `app_on_init.cpp` | user, created once (optional) | `void app_on_init()`: code outside FreeActors started before the scheduler (legacy C tasks, an SDK's stack) |
| `app_main.cpp` (firmware) | tool | `int main() { app_start(); }` |

**Vendor start-up is the board's**: `Hw::init()` (already called first by `Application::init`) does the vendor's HAL/SDK initialisation and the clock tree; vendor glue such as `HAL_InitTick`/`HAL_GetTick` lives in the board's source. `app_start()` runs `Hw::init()`, the optional `app_on_init()`, installs the vector table, creates the tasks and starts the scheduler.

**Traits move out of the actor header.** Today `ActorTraits` sits at the end of the user-owned actor header. With an application model it is generated in `app.hpp`; the actor header's block is wrapped in `#ifndef FA_APP_MANAGED` (the patcher does this once), and `app.hpp` defines `FA_APP_MANAGED` before including the actors. Actors used without an application model keep their defaults.

### 4.1 Interrupts

Whether a source is an interrupt is **architecture** (the designer's: rates, latency, queue sizes, priorities); how it is wired on a chip is **vendor detail** (the board engineer's: vector, flags, registers). Interrupts are therefore a module kind of their own, written by the designer, vendor-neutral, with the vendor parts taken from the board:

```cpp
template <typename Hw, typename IsrCtx>
struct ButtonIsr : Fa::InterruptInterface<ButtonIsr<Hw, IsrCtx>> {
    static constexpr IRQn_Type IRQNum = Hw::Irq::button;  // which interrupt: the board's (CMSIS number)
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
- **The vector table is built by `Fa::Application`** from the interrupt modules: a `constexpr` table in flash (core entries by their CMSIS names and FreeRTOS's port handlers, `vPortSVCHandler`, `xPortPendSVHandler`, `xPortSysTickHandler`; each module's `handle()`; every other slot a default handler that reports *"interrupt N fired but is not in the application's vector table"*). `Application::init` points VTOR at it, sets each priority and enables each interrupt. No vector names, no `extern "C"`, no RAM copy; the startup file and linker script stay as they are. Needs VTOR (Cortex-M3/M4/M7/M33, most M0+). Systems whose vector table is owned by something else (a bootloader forwarding interrupts, Nordic's SoftDevice) define `FA_NO_VECTOR_TABLE`: no table, VTOR untouched, priorities and enables still set; each module is bound to its vector by name in the board's source, `FA_BIND_ISR(USART3_IRQHandler, App::Application, CommandRxIsr)`, and a module left unbound is a link error naming it. Interrupt modules on cores without the ARMv7-M NVIC and VTOR (Cortex-M0/M0+, Cortex-A) are a compile error.
- **The table's slots hold `Application::run_interrupt<I>`**, which wraps the module's `handle()`: posts are attributed to the module in the trace (sender `0xC0 + n`, names in an INTERRUPTS frame after HELLO: `[POST] from CmdRxUart`), and an interrupt firing more than its limit within one tick (`MaxRatePerSecond`, default 50 000/s; a flag never cleared fires it back to back) is disabled and reported as `HealthFault::Storm`, instead of starving every task into an unexplained watchdog reset. The storm counting must happen in the interrupt: a storm starves the monitor task.
- **Unexpected interrupts** (any slot without a module) are disabled and recorded **without calling FreeRTOS**: such an interrupt may have any priority, typically 0, where FreeRTOS calls are forbidden (verified on the board: a first version traced from there and was stopped by FreeRTOS's priority assertion). The health monitor traces the fault from its task and keeps it across the reset.
- **The board** provides the interrupt numbers in one section, a nested `struct Irq`, and the acknowledge functions (`button_ack()`) with its other drivers, checked by the existing hardware contract; the device's interrupt count (`irq_count`) sizes the table, and `initial_stack` (the linker script's top of stack, e.g. `&_estack`) fills entry 0, which FreeRTOS reads through VTOR to reset the main stack when the scheduler starts:

  ```cpp
  struct NucleoF446ZE {
      // INTERRUPTS: which interrupt delivers each source the application needs (CMSIS IRQn_Type from the
      // device header). Only the number: FreeActors installs the handler, sets the priority (chosen by the
      // interrupt module) and enables it. Configure the peripheral in init(); acknowledge in the *_ack functions.
      struct Irq {
          static constexpr IRQn_Type button          = EXTI15_10_IRQn;
          static constexpr IRQn_Type command_rx_dma  = DMA1_Stream1_IRQn;
          static constexpr IRQn_Type command_rx_uart = USART3_IRQn;
      };
      static constexpr size_t irq_count = 97;
      static constexpr void const* initial_stack = &_estack;
      // ...
  };
  ```
- **Tests**: `ButtonIsr<TestBsp, TestIsrCtx>::handler()` called from an actor test fires the interrupt through the real code; `TestIsrCtx` records posts and pushes.

### 4.2 Board blueprint

Everything a board must provide is known to the tools: the modules' requirements (driver functions), the interrupt modules (`Irq` entries, acknowledge functions), the enabled features (trace output, command input, watchdog, reset) and the framework's fixed parts (`init`, `irq_count`). **Generate Board…** in the application editor writes the board named by the diagram's board setting (type, e.g. `Board::NucleoF446ZE`, and header, relative to the `*.app.json`) from the union of every `<name>_hw_requirements.hpp` present (`generateBoardBlueprint`), and opens it:

- every member stubbed so the file **compiles at once** (safe return values; interrupt numbers as distinct `int` placeholders, so two modules never land on one slot, marked `TODO`); bring-up proceeds one function at a time with the hardware contract as the checklist;
- **sections in a fixed order** with guidance comments: start-up, interrupts, drivers (with the comments from the requirements files and the modules requiring each function, a function required by several listed once), trace, command input, watchdog and reset; a section only for features that are enabled;
- **user-owned, created once**; when the application needs more later (a new driver function, a new interrupt, a feature switched on), Export Application and Generate Board **append** what is missing (`appendMissingBoardMembers`): interrupts into the existing `struct Irq`, functions at the end of their section (or, on a board without the blueprint's section banners, before the struct's closing brace under one `// ---- Added by export` line), each marked `// TODO (added by export)`; existing code is never changed, and a complete board is left untouched. Export only appends to a board next to the application; otherwise it says that Generate Board creates it;
- one file per board; the diagram's board setting selects the board of a build;
- **vendor flavours** (later, optional): templates adding a vendor's includes, start-up calls and glue (e.g. *STM32 HAL*: `HAL_Init()`, `HAL_InitTick`/`HAL_GetTick` in a small `.cpp`). The generator itself stays vendor-neutral.

## 5. The editor

- A custom editor for `*.app.json`, sharing the canvas, pan/zoom and dialog code with the HSM editor (`media/`), with new box and arrow kinds.
- Properties panel per box and arrow; event pickers filled from the receiver's model.
- Double-click: an actor opens its `*.hsm.json`; a module or service opens its source file at `task()` / `consume_batch()`.
- Errors and warnings from section 3 shown on the diagram and in VS Code's Problems panel.
- **Generate Board…**: the board blueprint (section 4.2).
- **Export Application**: regenerates the tool-owned files and creates the missing user-owned ones; it also exports every referenced HSM model, so one click updates the whole project.

## 6. Live view (trace phase 3)

With `fa-trace` connected (the extension runs the decoder and owns the serial port), the same diagram shows the running system:

- each arrow counts and briefly highlights the events it carries (POST records already name sender and receiver);
- each actor shows its current state (STATES), each box its queue high-water mark, health status and free stack (HEALTH); faults turn the box red, paused tasks grey;
- double-clicking an actor opens its HSM with the current state highlighted.

## 7. Top-down design, one source of truth for events, and the target

Recreating Timebomb from scratch with the designer (2026-10-03) worked, but only bottom-up: the state machine had to exist before the diagram could use it, and the firmware build (CMake, toolchain, FreeRTOS configuration, linker script, vendor sources) was copied from the old project by hand. This phase makes the application the starting point and the diagram the place where the target is described.

### 7.1 The workflow

Two roles, as before: the **designer** (models, modules, behaviour) and the **BSP engineer** (the board). On a small project they are one person.

1. **Draw the application** (designer). Create `Timebomb.app.json`; add the components (the Timebomb actor, still without a state machine, ButtonPoller, the command interrupts in a subsystem); connect them, typing the events (`ButtonPressed`); choose the features; name the board (`Board::NucleoF446ZE`, `bsp_nucleo_f446ze.hpp`). An actor without a state machine is a to-do (a warning), not an error.
2. **Export Application** (designer). Writes the application and module files as today, and **creates the missing state machines**: `Timebomb.hsm.json` with a ROOT state and the signals the diagram sends to it, linked to the actor, and exported like the HSM editor does (actor header, events, requirements, tests), so the whole project compiles from the start. An actor's context menu offers the same for one actor: **Create State Machine**.
3. **Design each state machine** (designer). Double-click the actor: the HSM editor opens with its signals already there; draw the states, add internal signals (`Tick`).
4. **Write the behaviour** (designer): actions, module bodies, each module's hardware requirements; the simulator and designer tests run on the PC.
5. **The board** (BSP engineer), in parallel from step 1, as soon as the board is named: **Generate Board**, the **Target** section (7.5) or a vendor flavour, bring-up one function at a time against the contracts. Each export appends what the designers' requirements added.
6. **Build, flash, trace**: Export Application also writes the firmware build files (7.5); `cmake --build --preset firmware --target flash`, then `fa-trace`.

Bottom-up stays possible: a state machine drawn first is chosen for an actor as today.

What the user writes by hand comes down to the behaviour, the board's vendor code and the SDK download; everything that is wiring or configuration comes from the diagram or is generated from it.

### 7.2 Events: one source of truth

**The state machine owns its signals** (they make the actor's `Event` type and its event structs); the events on connections in `*.app.json` are **references** to them. Keeping the two consistent is the tool's job, whichever editor the change is made in:

| The user | In the diagram | In the state machine |
|---|---|---|
| types a new event on a connection to an actor | saved on the connection | **added to the machine's signals** at once (the transition is drawn when the designer is ready) |
| adds a signal in the HSM editor | nothing (it may be internal, like `Tick`); the connection dialog offers it from now on | — |
| renames a signal, in either editor | **renamed on every connection**, in every `*.app.json` of the folder | **renamed in the signal list and in every transition** (`ButtonPressed/act`) |
| removes an event from a connection | removed from that connection | **kept**: a timer, the PC or another sender may still use it |
| deletes a signal in the HSM editor | **removed from every connection** carrying it (a connection left without events is removed), with a note naming what changed | — |
| renames a state machine (**later**: the HSM editor has no rename yet, and it renames a namespace and every generated file name) | the actors using it follow | the machine's name is its event namespace (7.3), renamed with it |

**Renames reach the C++**: the struct in the user-owned `<name>_events.hpp` is renamed, keeping its fields. The user's own uses of the name (`Ctx::post(Timebomb::ButtonPressed{})` in a module) are renamed through clangd's Rename Symbol when clangd runs; otherwise the compiler points each one out.

**Mechanics**:
- Both editors run in one extension, which makes the cross-file edits as workspace edits to the other document: an open editor redraws at once, the change is unsaved there until saved.
- A rename is an **explicit message** from the editor (`renameSignal { from, to }`), not inferred by comparing the file before and after (a rename and a delete-plus-add look the same).
- Undo is per file in VS Code: undoing a rename in one editor does not undo it in the other, so the extension shows a note naming the files it changed.

### 7.3 Where an event lives: the receiver's namespace

An event belongs to the state machine that receives it, so its namespace is that **machine's name**: `ButtonPressed` on a connection into the Timebomb actor is `Timebomb::ButtonPressed`, declared in `timebomb_events.hpp`. A sender never declares an event; it uses the receiver's type (the module skeletons already write `Ctx::post(Timebomb::ButtonPressed{});`). An event created through a connection is added to the receiver's machine, so its struct lands in the receiver's file and namespace.

- **One name into two actors is two types**: `ButtonPressed` into Timebomb and into a Logger actor is `Timebomb::ButtonPressed` and `Logger::ButtonPressed`, and the sender posts each. This is the single-instance, type-routed design (one receiver per type, routing resolved at compile time), not publish/subscribe.
- **Top-down**: the namespace exists before the machine; a state machine created for an actor takes the actor's name, so events into the Timebomb actor are `Timebomb::...` from the start.
- **The machine's name, not the box's**: an actor named `Bomb` using `Timebomb.hsm.json` receives `Timebomb::...` events; the dialog and the generated code both resolve through the model. Renaming a machine is therefore renaming a namespace (7.2).
- Actors sending events are no different: `post(Timebomb::Explode{})`. Only the receiver matters.

### 7.4 Item types: owned by the receiving service

The same rule for items: built-in types (`uint16_t`) need no home, but a type named on a service (`LogLine` on an MPSC service) is **declared by that service**: its module file (created once) gets `struct LogLine` in `namespace App`, its fields left to the user. Producers include the service's module file; an interrupt pushing it from its acknowledge function names it in its requirements by a forward declaration.

### 7.5 The target

Decisions belong in the diagram; vendor content does not. The board's **Target** section in the sidebar (stored under `board` in `*.app.json`; it can move to a shared `*.board.json` later without changing anything else) holds the decisions, and Export Application generates the mechanics from them and from the diagram:

| Item | In the designer | File, owner |
|---|---|---|
| Core | Cortex-M3 / M4 / M4F / M7 / M33 | drives `-mcpu`, the FPU flags and the FreeRTOS port (`ARM_CM3`, `ARM_CM4F`, `ARM_CM33_NTZ`); M7 uses `ARM_CM4F` (except r0p1 parts) |
| CMake presets | — | `CMakePresets.json` (`host`, `firmware`), tool; the user's own presets go in CMake's `CMakeUserPresets.json` |
| Toolchain | its folder, if `arm-none-eabi-gcc` is not on PATH | `cmake/arm-none-eabi.cmake`, tool |
| Firmware target | vendor sources, include folders, defines (`STM32F446xx USE_HAL_DRIVER`), startup file, flash command template (`openocd -f board/st_nucleo_f4.cfg -c "program {elf} verify reset exit"`) | `freeactors_firmware.cmake`, tool, included by `CMakeLists.txt` like `freeactors_tests.cmake` (a hint if an existing one does not) |
| FreeRTOS kernel | its folder (default `$env{FREERTOS_KERNEL_PATH}`) | used by the firmware target |
| `FreeRTOSConfig.h` | tick rate; the NVIC priority bits (`__NVIC_PRIO_BITS`: 4 on STM32, Kinetis, SAM4; 3 on nRF52, TM4C) | tool: `configMAX_PRIORITIES` from the highest priority in the diagram, the hooks and static allocation FreeActors needs, stack overflow checking, `configASSERT`; it includes the user-owned `freertos_config_user.h` (created once) first, for overrides |
| Linker script | its path | the user's or the vendor's; checked, not written |
| HAL / SDK configuration | its folder | the vendor's template |
| Startup and system files | their paths | the vendor's |

**Checks** (section 3, Problems panel): a linker script without a `.noinit` section while the health monitor is on (error); a Target source, startup file or linker script that does not exist (warning: the SDK may come later); a core FreeActors does not support (only ARMv7-M and ARMv8-M Mainline cores are offered).

**Any start-up code links**: FreeActors' vector table names the core exception handlers (`HardFault_Handler`, ...) by their CMSIS names; the framework gives them weak defaults (a loop for the debugger), so a vendor's or the user's definitions replace them and a start-up file without them still links.

**The PC commands are a box**: while Commands (`FA_TRACE_COMMANDS`) is on, the diagram shows the built-in command service as a fixed box (*PC commands*: moved, not deleted or renamed; no module of the code, `Fa::Application` builds it in). The command UART's receive interrupts feed it with DMA stream arrows, so the diagram shows which interrupts carry the commands (apart from, say, a GPS's into its own DMA ring); their handlers call `IsrCtx::command_rx(Hw::<irq>_ack())`, the actual connection. A pre-0.0.9 interrupt property *commands* becomes such an arrow when the application is opened.

**An interrupt's handler is generated from all its outgoing arrows**: one block per arrow, each with its own acknowledge function; with several arrows (one interrupt line serving two purposes, e.g. DMA channels sharing an interrupt) each block is guarded by a pending check of the board's (`<irq>_<target>_pending()`), so no output is dropped.

**The application's files have fixed names** (`app_config.hpp`, `app.hpp`, `app.cpp`, `app_main.cpp`, `app_hw_contract.hpp`): a folder holds one application (its CMake presets, `FreeRTOSConfig.h` and firmware build are per folder already), so renaming the application never leaves module files including a stale configuration; its name names the firmware (`<name>.elf`). Files of the earlier scheme (`timebomb_config.hpp`, ...) are recognised by their banner on export, removed, and the includes of them in the user's files rewritten.

**Vendor flavours** fill these fields from three more (the part, the SDK folder, flash and RAM sizes) with **Apply flavour**, and create the vendor-side files that are missing (yours afterwards). *STM32F4 + HAL* (SDK folder: ST's repositories `cmsis_core`, `cmsis_device_f4`, `stm32f4xx_hal_driver`) sets the core, the startup and system files for the part, the HAL sources and include folders, the defines (`STM32F446xx USE_HAL_DRIVER`) and an OpenOCD flash command; it creates the linker script (with `.noinit`) from the sizes, the HAL configuration from ST's template and the board's HAL tick glue (`<board>.cpp`); Generate Board then starts the board with the HAL's header and `HAL_Init()`, and reads the interrupt count from the part's device header. The fields are generic, checked against nRF52 (nrfx), TM4C (TivaWare), Kinetis (MCUXpresso) and SAM4 (ASF): every SDK comes down to sources, include folders, defines, a linker script, a startup file and a flash command (OpenOCD, pyOCD, J-Link, probe-rs, nrfjprog).

## 8. Phases

1. **Event payloads** (section 2): user-owned event structs (done in 0.0.8); field layouts read for the trace dictionary and `fa-trace` (done in 0.0.8).
2. **Model and editor**: `*.app.json`, components, connections, drill-down; no generation yet.
3. **Checks** (section 3).
4. **Generation** (section 4), with the Timebomb project migrated to it and verified on the board; the POSIX test application generated from a model as well. Includes the board blueprint (4.2); vendor flavours after it, STM32 HAL first.
5. **Top-down design and the target** (section 7), in steps:
   1. an actor without a state machine is a warning; Export Application and **Create State Machine** create the missing `*.hsm.json` with the signals from the diagram;
   2. one source of truth for events: additions and renames from either editor, deletions in the HSM editor removing them from connections, renaming a machine (7.2, 7.3);
   3. item types declared by the receiving service (7.4);
   4. the Target section and the generated firmware build files and `FreeRTOSConfig.h` (7.5);
   5. the first vendor flavour, STM32F4 + HAL;
   6. acceptance: Timebomb recreated top-down from an empty folder (application first), nothing copied but the SDK, verified on the board.
6. **Live view** (section 6).

Each phase ships as a release of the extension.

## 9. Testing

| What | How |
|---|---|
| Payloads | events headers with fields parsed into the dictionary; actor tests posting events with data; `post_by_index` with payloads in the POSIX test; `fa-trace` encoding round trip |
| Checks | fixture `*.app.json` files, one per rule, run through the checker from `tests/gen.js` (like the conflicting HSM model today) |
| Generation | the POSIX application and the target-compile application generated from fixture models instead of hand-written, so the existing runtime and size checks cover the generated wiring |
| Editor | the webview rendered headless (as for the README screenshot) for a smoke test of loading and drawing a model |
| Board blueprint | a blueprint generated for each fixture application compiles as is, and passes the hardware contract; appending after a change keeps hand-written members |
| Board | Timebomb from its application model: trace, commands, health, as verified today |
| Signal sync | each rule of 7.2 on fixture models: the edit to the other file, renames in transitions and connections, the events struct renamed keeping its fields; the editors' explicit rename messages in the editor test |
| Top-down | a diagram with an actor and no state machine: Export Application creates and exports the machine, and the project builds (host and Cortex-M4) |
| Target | the generated firmware build for the fixture application configures and builds with the FreeRTOS kernel (as the target compile check today); each target check on a broken variation |

## 10. Decisions

1. **`main` is generated**; vendor start-up belongs to the board (`Hw::init()`); an optional user hook `app_on_init()` starts code outside FreeActors.
2. **Interrupts are C++ template modules** (`InterruptInterface<I>`, `template <typename Hw, typename IsrCtx>`) with an interrupt-only context; the interrupt number comes from the board inside the module, so the `Fa::Application` list only names modules; the vector table is built at compile time and installed through VTOR (section 4.1). Plain-C interrupt functions with a generated `app_isr.h` were considered and set aside for now (they would need interrupt numbers in the application's definition).
3. **One application per `*.app.json`**, the root of a component hierarchy; subsystems are structural in v1 (section 1.3).
4. **Top-down design**: the application can be drawn first; Export Application creates the missing state machines with the signals the diagram sends them (section 7.1).
5. **One source of truth for events**: the receiving state machine owns its signals, connections refer to them; the tool keeps both consistent, including deleting a signal in the HSM editor, which removes it from the connections (section 7.2). An event's namespace is the receiving machine's name; item types are declared by the receiving service (7.3, 7.4).
6. **The diagram holds the target's decisions, not vendor content**: core, paths, sources, defines, flash command in the board's Target section; the CMake build and `FreeRTOSConfig.h` are generated; linker script, SDK configuration and startup files stay the vendor's, referenced by path and checked (section 7.5).
7. **The PC commands are a box with arrows**, not a property of interrupt modules: the diagram shows every data path, and a handler is generated from all its module's arrows (section 7.5).
8. **The application's generated files have fixed names**: renaming the application is always safe (section 7.5).
