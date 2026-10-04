# Changelog

## Unreleased

### Editor
- Application editor (`*.app.json`): draw the application from its building blocks (actors, periodic modules, interrupt modules, SPSC/MPSC/DMA services) grouped in subsystems, connect them with events, items and DMA streams, and edit each component's properties. Connecting to an actor offers the events of its state machine; double-click opens the state machine. Code generation from the application follows in a later release.
- Checks on the application: wrong events, a state machine used twice, an SPSC service with several producers, conflicting interrupts or priorities FreeRTOS does not allow, invalid names and more, shown on the diagram, in the editor's problem list and in VS Code's Problems panel.
- The hardware requirements file is now `<name>_hw_requirements.hpp` (was `<name>_bsp_policy.hpp`: it lists what a state machine needs from any board, it is not the board). Export renames an existing file once, unchanged, and updates the include in your actor header.
- The state machine editor highlights the state actually under the cursor when linking (it used to highlight the enclosing state).

## 0.0.8

### Framework
- Interrupt modules: an interrupt is a module of its own (`Fa::InterruptInterface`), with an interrupt-only context (`IsrCtx::post`, `push`, `stream`): no vector names, no `extern "C"`, no `woken`/`portYIELD_FROM_ISR`, no NVIC calls. The application builds the vector table at compile time (in flash) and installs it through VTOR; priorities are checked against FreeRTOS at compile time. `FA_NO_VECTOR_TABLE` + `FA_BIND_ISR` for systems that own their vector table.
- Interrupts in the trace by name (`[POST] from CmdRxUart`); an interrupt storm (a flag never cleared) is cut off and reported, and an interrupt missing from the table is disabled and reported, both as health faults that survive the reset.

### Editor and export
- Actors call `post`, `schedule` and `cancel` without `this->`, and the board as `Hw::`; existing actors get this on the next export, without changes to your code.
- Event structs are yours: `<name>_events.hpp` is created once and never overwritten, so add the data an event carries as fields there (`struct Temperature { int16_t celsius = 0; };`). New signals are appended as empty structs; the event list moves to the generated `<name>_event_list.hpp`. An existing events header is converted on the next export, keeping fields you added.
- Events with data from the PC: export reads the fields of your event structs (numbers, `bool`, `float`, fixed-size arrays) into the trace dictionary, and `fa-trace` posts them by name: `post Sensor Temperature celsius=21`; `events` shows each event's fields. A struct changed without exporting again fails the build with a clear message. Structs fa-trace cannot read still take raw bytes.
- Code completion with clangd: export writes a `.clangd` file and CMake writes `compile_commands.json`, so actions complete `schedule(...)` with its parameters and `Hw::` with the board functions.

## 0.0.7

- Marketplace page: screenshot of the editor with the Time Bomb example, credited to Miro Samek's Modern Embedded Systems Programming course; links to the GitHub repository.

## 0.0.6

### Framework
- The trace service is built into the application (`FA_TRACE`), like the timer service.
- Lock-free single-producer services (`SpscServiceInterface`) and continuous DMA reception (`DmaRingInterface`).
- Commands from the PC (`FA_TRACE_COMMANDS`): post an event to any actor, query every actor's state, reset, set the trace filter; type them in `fa-trace` while the trace runs (or script them with `--encode`); replies appear in the trace. Input through receive DMA or one byte per interrupt.
- `Fa::CortexM::system_reset()`.
- Health monitor and watchdog manager (`FA_HEALTH`): every task the framework runs is checked without code in the modules (stuck in a step, work waiting without progress, optional idle timeout); the hardware watchdog is fed only while all are healthy; the fault that caused a reset is reported at the next start-up; `health` in `fa-trace` shows each task's status, longest step and free stack.
- Debug commands (`FA_DEBUG_COMMANDS`): `pause` / `resume` any task between steps, `health test` to prove the watchdog chain on the real board; `reset` now needs this switch too.
- `fa-trace`: colored output in a terminal, `events` and Tab completion, recognises a target restart.

## 0.0.5

### Editor and export
- Export no longer corrupts non-ASCII text and never overwrites your files on errors.
- Models are validated before export: invalid JSON and conflicting unguarded reactions are rejected with a clear message.
- Initial transitions can have actions.
- Hardware requirements file (`<name>_bsp_policy.hpp`) lists the drivers an actor needs; the board is chosen once by the application.
- New generated files: model and actor tests (doctest), `<name>_test_bsp.hpp` (host test double), `freeactors_tests.cmake`, and `<name>_trace.json` (trace dictionary).

### Framework
- UML transition order: exit actions, transition action, entry actions; exit actions now run on transitions inherited from a superstate, and the top state's entry action runs at start-up.
- The firmware code path compiles for Cortex-M4 with and without FPU.
- Timers: `schedule(event, ms, periodic)` and `cancel(event)`, owned by the actor, delivered from the tick without drift; timers are no longer delivered to the wrong actor.
- Events never block; lost events are counted (and asserted in debug builds).
- Periodic process modules (`TimeServiceInterface`) and multi-producer services (`MpscServiceInterface`).
- Runtime trace (`FA_TRACE`) with `Fa::TraceService` and the `fa-trace` decoder (serial, TCP, file).

## 0.0.4 and earlier
- Visual HSM editor, C++ blueprint export, REPL simulator with reachability (`reach`, `take`).
