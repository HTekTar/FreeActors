# FreeActors backlog

Bugs and design work for the extension (generator/editor) and `freeactors_lib`, in priority order.
Status: ✅ done · ◐ partly done · ⬜ open · 🔶 needs a decision. IDs are stable; refer to items by number.

Design constraints that apply to every item:
- One instance per machine and one receiver per event type in v1 (multi-instance may come in v2.0; keep `instance_id` available).
- Vendor-neutral: as many Cortex-M4 parts as possible, with and without FPU. No vendor HAL/SDK assumptions in framework or generated code.
- Target builds: no heap, exceptions, RTTI, virtuals or iostream. Host-only code stays behind `FA_SIM`.

## P0 — blocks everything or destroys user code
| # | Item | Status |
|---|---|---|
| 1 | Simulator didn't build: `fa_common`/`fa_util` include cycle, `FindActorForEvent`, `Hsm::schedule/post` | ✅ |
| 2 | Non-ASCII text in the user's actor header corrupted on export | ✅ |
| 3 | Bare `catch` overwrote user files on any error | ✅ |

## P1 — engine correctness
| # | Item | Status |
|---|---|---|
| 4 | Test harness (`npm test`: doctest, fixtures, exported-project builds) | ✅ |
| 5 | Exit actions skipped on transitions inherited from a superstate | ✅ |
| 6 | `entry_ROOT` never ran at startup (`Hsm::start`) | ✅ |
| 7 | Initial transition with an action produced invalid C++ (`parseTrigger`) | ✅ |
| 8 | Two unguarded reactions on one signal (export validation) | ✅ |
| 9 | Generated `std::get` → `*std::get_if` | ✅ |
| — | Transition actions run in UML order (exit → action → entry) | ✅ |

## P2 — firmware build
| # | Item | Status |
|---|---|---|
| 10 | Blueprint pulled `fa_sim.hpp`/iostream into firmware | ✅ |
| 11 | `NullContext` only existed under `FA_SIM` | ✅ |
| 12 | `Hsm` initialised a nonexistent `queue` member | ✅ |
| 13 | Actor stub didn't compile (`InstanceIdOf`, ctor base, `UBaseType_t`) | ✅ |
| — | Firmware trace path broken → opt-in `FA_TRACE`; `Fa::is_detected_v` missing (contracts never compiled) | ✅ |
| 14 | `fa_freertos.hpp`: namespace `fa`, no FreeRTOS includes | ✅ |
| 15 | `fa_app.hpp` doesn't compile (`ModuleTemplates`, `notify_tick`, tick naming) | ✅ |
| 16 | Board selection: BSP policy = requirements only, board chosen via `AppTraits::Platform`, no default `HwPolicy` | ✅ |
| — | Actor test support: `RecordingContext`, generated `<name>_test_bsp.hpp`, shared test log | ✅ |
| — | Target compile check: arm-none-eabi, FPU (ARM_CM4F) and no-FPU (ARM_CM3), size report | ✅ |

## P3 — timer service (tested by the FreeRTOS POSIX host run in the harness ✅)
| # | Item | Status |
|---|---|---|
| 17 | Event stored as `TimeEvent<E>`, read back as `TimeEvent<Subvariant>`; variant-to-variant conversion | ✅ both sides use the actor's `EventType` (POSIX run) |
| 18 | `machine_id = instance_id`, table indexed by actor position (timers were misdelivered to another actor) | ✅ (POSIX run) |
| 19 | Timers behind an expired head drift late, cumulatively | ✅ expired timers delivered in the tick itself; periodic re-armed from its expiry |
| 20 | `schedule()` truncates `uint32_t` ms to `uint16_t` | ✅ `uint16_t ms` end to end, 32-bit ticks inside |
| 21 | Payload read through `reinterpret_cast` (aliasing UB; alignment only a risk off-M4) | ✅ `memcpy` into typed objects |
| 22 | No timer cancellation (re-arming Timebomb doubles the blink rate) | ✅ `Hsm::schedule(e, ms, periodic)` + `cancel(e)`/`cancel<E>()`, one timer per (owner actor, event type), rescheduling restarts |
| 23 | Service task polls instead of being notified from the tick ISR | ✅ no timer task: delivery from the tick hook (`xQueueSendFromISR`) |
| 24 | Full actor queue → `configASSERT` halts the device (timer delivery); `post()` blocks forever | ✅ never block; always counted in `StaticActorStorage<A>::dropped`; `FA_ASSERT` stops debug builds; `FA_NO_ASSERT` = drop + count |
| 25 | Compile errors in `fa_timeEvent`/`TimeServiceInterface` | ✅ (fixed in P2; service period defaults to 1 ms until #23) |

| — | Periodic process modules: `TimeServiceInterface` restored after being removed in the timer rework; module detection fixed (it required both `create_task()` and `on_tick_isr()`, so a periodic module was never started). Tested with a debounced-button module | ✅ |

Known limitation (documented, not a bug): a timer that expired and was queued to its actor just before `cancel()` is still delivered. A delivery-time check in the actor's task would close it if a real case needs it.

## v1.0 features
| # | Item | Status |
|---|---|---|
| 41 | Trace, phase 1: `MpscServiceInterface`, `TraceService`, records with sender, framing, dictionary + model hash, `fa-trace` decoder (serial/TCP/file). Runs on the Nucleo | ✅ |
| 42 | Trace, phase 2: lock-free `SpscServiceInterface`, `CommandService` (post by index, query states, reset, filter, HELLO request), REPL on the board | ⬜ |
| 43 | Trace, phase 3: live view in the VS Code HSM editor | ⬜ |
| 44 | Trace transport improvements: interrupt/DMA UART transmit instead of blocking; `Fa::RttOut` | ⬜ |

## P4 — generator robustness
| # | Item | Status |
|---|---|---|
| 26 | Reachability tables: sibling guard negation, local-event shadowing, targetless transitions | ⬜ |
| 27 | BSP contract parser: `T *p`, `const T`, `(void)`, multi-word return types | ⬜ |
| 28 | Signal/state names not validated as C++ identifiers; undeclared signals (invalid JSON now rejected) | ◐ |
| 29 | Webview: no CSP, model text inserted with `innerHTML` | ⬜ |
| 30 | Patcher edits the first `public:`/`private:` in the file; loose "method exists" check | ⬜ |

## P5 — design
| # | Item | Status |
|---|---|---|
| 31 | Replace the regex patcher with compile-time detection checks; never rewrite user files (the patcher's newest migration, dropping `= DefaultHwPolicy`, has no test) | ⬜ |
| 33 | Clear compile errors for reserved `Fa::*_sig` in `post`/`schedule`, and for a machine registered twice | ⬜ |
| 34 | RAM: task per actor, queue slots sized by the largest event (revisit with v2) | ⬜ |
| 35 | Generated model checks: every transition taken on `MockMachine`, unreachable states/transitions reported (after #26) | ⬜ |
| 36 | Generated actor tests: bounded exploration of the real actor + per-transition hardware-call snapshots (after #26) | ⬜ |
| 37 | Design rule, documented: all external input reaches an actor as events; guards read only actor data and payload | ⬜ |
| 38 | Firmware integration: tool-owned `freeactors_firmware.cmake` (`freeactors_add_to_target(...)`) + host/firmware CMake presets | ⬜ |
| 39 | Compiler portability: Clang/LLVM Embedded, Arm Compiler 6, IAR (e.g. `[[gnu::packed]]` in `fa_trace.hpp`) | ⬜ |
| 40 | Re-entrancy guard: `FA_ASSERT` if an action calls `dispatch()` on its own machine | ⬜ |

## P6 — cleanup
- ✅ `fa_actor.hpp` removed from the framework copy list.
- ⬜ Events header: identical `FA_SIM` and target branches.
- ⬜ Generated headers use both `#pragma once` and include guards.
- ⬜ Tool-owned files rewritten even when unchanged (needless rebuilds).
- ✅ `Instance_holder` removed from `fa_timeEvent.hpp`.
- ⬜ Unused `Catalog` typedef warning in `fa_sim.hpp:423`.
