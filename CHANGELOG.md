# Changelog

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
