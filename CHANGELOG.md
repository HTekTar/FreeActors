# Changelog

## Unreleased

### Framework
- The trace service is built into the application (`FA_TRACE`), like the timer service.
- Lock-free single-producer services (`SpscServiceInterface`) and continuous DMA reception (`DmaRingInterface`).
- Commands from the PC (`FA_TRACE_COMMANDS`): post an event to any actor, query every actor's state, reset, set the trace filter; replies (`ACK`, `STATES`) are decoded by `fa-trace`. Input through receive DMA or one byte per interrupt.
- `Fa::CortexM::system_reset()`.

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
