# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension ("FreeActors HSM Editor") that provides a graphical custom editor for hierarchical state machines stored as `*.hsm.json`, and exports them to C++17 code built on the header-only **FreeActors** framework in [freeactors_lib/](freeactors_lib/). The generated C++ targets embedded/FreeRTOS, and can also be built as a desktop REPL simulator.

## Commands

- `npm run compile` — `tsc` build to `out/` **and** copy `freeactors_lib/*` into `out/freeactors_lib/`.
- `npm run watch` — copy lib once, then `tsc -watch`. Used as the preLaunchTask for the "Run Extension" launch config (F5 opens an Extension Development Host).
- `npm run watch:lib` — nodemon re-copies the C++ lib on `.hpp/.h/.cpp` changes (nodemon is not in devDependencies).
- Packaging: `.vsix` files in the repo root are built with `vsce package` (not a devDependency; use `npx @vscode/vsce package`). Bump `version` in [package.json](package.json) first.
- `npm test` — compile, then run [tests/run.sh](tests/run.sh) (needs g++, cmake, ctest). [tests/gen.js](tests/gen.js) runs the real generator from `out/extension.js` (the `vscode` module is stubbed) on [tests/fixtures/](tests/fixtures/). It then checks, all with doctest:
  - [tests/engine_test.cpp](tests/engine_test.cpp): model configuration (`FA_SIM`, `MockMachine`), comparing UML entry/exit/action/transition traces;
  - [tests/actor_test.cpp](tests/actor_test.cpp): firmware code path on the host (no `FA_SIM`, real `Actor` classes and payloads), built twice, plain and with `-DFA_TRACE`;
  - each fixture exported as a complete new project (`gen.js --project`), built with CMake, and its generated designer tests run with ctest;
  - negative checks: a conflicting model is rejected, and the hardware contract rejects a BSP missing a declared function;
  - target compile check: [tests/target/target_app.cpp](tests/target/target_app.cpp) built with `arm-none-eabi-g++` for Cortex-M4 with FPU (FreeRTOS `ARM_CM4F` port) and without (`ARM_CM3`), with a flash/RAM size report. Needs `FREERTOS_KERNEL_PATH` (a FreeRTOS kernel `Source` folder); prints `SKIP` without it;
  - POSIX runtime test: [tests/posix/posix_app.cpp](tests/posix/posix_app.cpp) runs a real two-actor `Fa::Application` on the FreeRTOS POSIX port (real tasks, queues, tick, timers) and checks routing and timer delivery with real-time tolerances. Also needs `FREERTOS_KERNEL_PATH`. Locally: `FREERTOS_KERNEL_PATH=~/projects/FreeRTOS/FreeRTOS/Source npm test`.

  Run one test after `npm test`: `tests/build/engine_test -tc="*armed*" -sc="*inherited*"` (`-tc` filters test cases, `-sc` subcases). For any engine or generator behavior change, add a fixture and/or test case. Generator functions and constants the tests use must stay `export`ed.

No linter is configured. `tsconfig.json` is strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

To exercise generated C++: open/create a `*.hsm.json` in the dev host, click export, then in that folder `cmake -B build && cmake --build build && ./build/<name>_sim` to run the REPL simulator.

## Architecture

Three parts, communicating as below:

1. **Webview UI** — [media/webview.html](media/webview.html) (template with `{{styleUri}}`/`{{scriptUri}}` placeholders), [media/main.js](media/main.js) (plain JS, no bundler), [media/style.css](media/style.css). The canvas editor owns the HSM model and posts messages to the extension:
   - `ready` → extension replies with `update` (full document text)
   - `documentEdit` `{jsonText}` → extension replaces the whole TextDocument
   - `exportCppBlueprint` → triggers code generation

2. **Extension host** — everything lives in [src/extension.ts](src/extension.ts): `FreeActorsEditorProvider` (a `CustomTextEditorProvider`; the JSON text document is the source of truth, and empty files get a default skeleton with a `ROOT` state) plus a set of string-building `generate*` functions for C++.

3. **C++ framework** — [freeactors_lib/](freeactors_lib/); the build copies it to `out/freeactors_lib/` (the packaged copy) and export copies it from there into a `freeactors/` subfolder of the project (`copyFrameworkFilesToWorkspace`, which also copies the `fa-trace.js` decoder). **When adding/renaming a header, update `FRAMEWORK_FILES`** in extension.ts (missing files are only warned about). `doctest.h` (vendored doctest v2.5.3, MIT) and `fa_test.hpp` (test helpers) ship there too. `fa_mempool.hpp` and `linenoise.hpp` remain in the source tree but are deliberately excluded (stripped by `copy-lib`, listed in `.vscodeignore`, absent from `frameworkFiles`).

### HSM JSON model

Top-level: `name`, `signals`, `guards`, `actions`, `states[]`. Each state has `id`, `name`, `parent`, geometry, `entry`/`exit`, `transitions[]` (`event` as `"Signal/action"`, `guard`, target), and `local_events[]` (internal transitions, `"Signal/action"`). `extractCatalogs` normalizes the root state to `ROOT` and builds guard/action catalogs; a method written with `()` is parameterless, otherwise it takes the triggering event's payload. `Init_sig` is the initial-transition pseudo-signal.

### Export: tool-owned vs user-owned files

For machine `Foo`, export writes into the `.hsm.json`'s folder:

| File | Ownership |
|---|---|
| `foo_events.hpp`, `foo_hsm.hpp` (blueprint, incl. unified reachability metadata), `foo_hw_contract.hpp` | Tool-owned, overwritten every export |
| `foo_bsp_policy.hpp` | User-owned **hardware requirements** (declarations only, `struct HwRequirements`), generated only if missing; **parsed** (`parseBspPolicyHeader`) into the hw contract and `TestBsp`. The board is a separate user type selected once via `AppTraits::Platform`; the actor has no default `HwPolicy` |
| `foo_test_bsp.hpp` | Tool-owned `TestBsp` (host test double: records calls in `Fa::test::log()`, returns `<fn>_result`), rewritten every export from the requirements |
| `foo_actor.hpp` | User-owned; if it exists, `patchExistingActorHeader` appends newly-required handler methods and migrates legacy signatures (e.g. `Actor<HwPolicy>` → `Actor<HwPolicy, Ctx>`) without touching user code |
| `main.cpp`, `CMakeLists.txt` | Generated only if missing (REPL sim using `Fa::SimRunner`); new `CMakeLists.txt` includes `freeactors_tests.cmake` |
| `tests/foo_model_test.cpp`, `tests/foo_actor_test.cpp` | User-owned designer tests (doctest + `fa_test.hpp`), generated only if missing. The actor test's `TestBsp` is pre-filled from the BSP policy's declared functions |
| `freeactors_tests.cmake` | Tool-owned test targets; export shows a hint if an existing `CMakeLists.txt` doesn't include it |

Changes to the generators must stay compatible with the patcher's regexes and with the templates in `freeactors_lib`.

### C++ library notes

Goal: a C++17 micro-framework on FreeRTOS for ARM Cortex-M4. Code compiled without `FA_SIM` (the target build) must stay free of heap allocation, exceptions, RTTI and virtual dispatch. Host-only facilities (`<iostream>`, `<string>`, tracing, REPL) belong behind `#ifdef FA_SIM`.

- Namespace `Fa` (note: [fa_freertos.hpp](freeactors_lib/fa_freertos.hpp) uses lowercase `fa`).
- Target tracing is compiled out unless `FA_TRACE` is defined; then the application must define `Fa::emit_trace_token(trace_token)` ([fa_trace.hpp](freeactors_lib/fa_trace.hpp)).
- Start a machine with `M::start(m)` (Enter ROOT, then Init); transition actions run between exits and entries (UML order), via `TransitionTo<Dest, Act, Sig>`.
- Actor-side API on `Hsm`: `this->post(evt)`, `this->schedule(evt, ms, periodic = false)`, `this->cancel(evt)` / `cancel<E>()`. A timer is identified by (owner actor, event type); rescheduling restarts it. Firmware timers live in a fixed pool (`AppTraits::MaxTimers`, `MaxTimerPayloadSize`) and are delivered from the tick hook (`App::on_tick_isr()` in `vApplicationTickHook`); there is no timer task.
- Application modules: `Fa::Application<AppTraits, Modules...>` takes templates `<Hw, Ctx>`. Actors (have `EventType`) get a task + queue. **Periodic process modules** derive from `Fa::TimeServiceInterface<S, DelayMs>` (fa_freertos.hpp), provide `static void task() noexcept` and a `Fa::TimeServiceTraits<S>` specialisation (name, stack words, priority); `init` starts their task (detected by `create_task()`), and they post via `Ctx::post`. Modules with `on_tick_isr()` are also called from the tick hook. Example: [tests/fixtures/timebomb_button.hpp](tests/fixtures/timebomb_button.hpp) (debounced button).
- **Trace** ([docs/design/trace.md](docs/design/trace.md)): with `FA_TRACE`, engine hooks and application routing produce 8-byte `TraceRecord`s (EVENT, GUARD, ACTION, TRANSITION, POST with sender, DROPPED, TIMER_SCHEDULE/CANCEL) through `M::Context::trace<M>` → `Fa::TraceService` ([fa_trace_service.hpp](freeactors_lib/fa_trace_service.hpp)), an `MpscServiceInterface` module that frames them ([fa_frame.hpp](freeactors_lib/fa_frame.hpp): COBS + CRC-16) and writes them with the output policy's `trace_write` (default: the board). POST is recorded *before* the queue send. `FA_TRACE_NO_POST` drops POST/TIMER records. Export writes `<name>_trace.json` (ids → names) and a `ModelHash` in the blueprint; [tools/fa-trace.js](tools/fa-trace.js) decodes (`--dict <folder> --serial <port> | --tcp host:port | --file <path>`).
- MPSC services: `Fa::MpscServiceInterface<S, T, N>` (locking; `push`/`push_from_isr`, `consume` or zero-copy `consume_batch`, drop newest + count + `high_water()`); routed by item type via `Hsm::mpsc_push` / `Application::mpsc_push(_from_isr)`.
- SPSC services: `Fa::SpscServiceInterface<S, T, N>` — lock-free, **exactly one producer** (one ISR via `Application::spsc_push_from_isr`, or one task via `spsc_push`), same consumer contract as MPSC. Core: `Fa::SpscRing` in [fa_spsc.hpp](freeactors_lib/fa_spsc.hpp) (FreeRTOS-free; monotonic counters; seq_cst publish/check pairs prevent lost wake-ups), stress-tested under ThreadSanitizer (`tests/spsc_test.cpp`). Services carry a `service_kind` tag so MPSC and SPSC routing can never mix. Design: [docs/design/dma.md](docs/design/dma.md).
- DMA ring services: `Fa::DmaRingInterface<S, T, N>` — the DMA hardware is the producer; the board's interrupt reports its write position with `Application::dma_progress_from_isr<Service>(pos, &woken)`; the service consumes spans in place (`consume_batch`), starts its stream in `on_start`, and checks `span_intact()` (conservative: the hardware may be up to N/2 ahead of the last report). Core: `Fa::DmaRing` in [fa_dma.hpp](freeactors_lib/fa_dma.hpp), host-tested with scripted positions (`tests/dma_test.cpp`, also under ThreadSanitizer). `FA_DMA_BUFFER` places buffers in DMA-capable RAM.
- Queue-full policy: `post`, `postFromISR` and timer delivery never block. A lost event is counted in `Fa::StaticActorStorage<Actor>::dropped` and hits `FA_ASSERT` (configASSERT) when assertions are on; `-DFA_NO_ASSERT` turns FreeActors' asserts off (drop + count only).
- `FA_SIM` define switches between host simulation and target behavior (see [fa_ops.hpp](freeactors_lib/fa_ops.hpp), [fa_common.hpp](freeactors_lib/fa_common.hpp)); the simulator main defines it before including the blueprint.
- Heavy template metaprogramming: `TypeList`, `MetaTable<DescriptorPolicy, ...>` reflection over events/states/guards/actions, `HsmTraits`/`ActorTraits`. Core HSM in [fa_core.hpp](freeactors_lib/fa_core.hpp); REPL simulator in [fa_sim.hpp](freeactors_lib/fa_sim.hpp) + [fa_repl.hpp](freeactors_lib/fa_repl.hpp); app/module composition in [fa_app.hpp](freeactors_lib/fa_app.hpp); time events + FreeRTOS delta queue in [fa_timeEvent.hpp](freeactors_lib/fa_timeEvent.hpp)/[fa_freertos.hpp](freeactors_lib/fa_freertos.hpp).
