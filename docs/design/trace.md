# Trace and remote control — design

Status: **agreed** (phase 1 in progress).
Scope: FreeActors v1.0 — a runtime trace from the target to the PC (one-way), and commands from the PC to the target (two-way).

## Goals

- See what the actors do on real hardware: events dispatched, guards evaluated, actions run, transitions taken, events lost — with timestamps.
- Drive the target from the PC: post events, query every actor's state, reset. The REPL that drives the simulator today should be able to drive the board.
- Stay true to FreeActors: statically allocated, no heap, no exceptions/RTTI, vendor-neutral, zero cost when disabled, hardware reached only through policies, routing checked at compile time.

## Non-goals (v1.0)

- Formatting text on the target (`printf`-style). The target sends compact binary records; names are resolved on the PC.
- Reading/writing actor data, pausing actors, breakpoints — later, if needed.

## Overview

```
 target                                                              PC
 ──────                                                              ──
 actors ─┐ this->… (engine hooks, FA_TRACE)                          
 ISRs ───┼─► TraceService  (MpscServiceInterface<…, TraceRecord, N>)  
         │      consumer task: frame + trace_write(bytes) ──UART──►  decoder ─► text / REPL / editor view
         │                                                               │
         └── CommandService (SpscServiceInterface<…, RxChunk, N>)  ◄──UART── commands
                consumer task: parse frames, post events, query states
```

Two building blocks carry everything: a **locking multi-producer** service for records going out, and a **lock-free single-producer** service for bytes coming in. Both are generic application modules and usable for other purposes (logging, sample streams).

## 1. Service interfaces (freeactors_lib)

Both are CRTP bases for application modules, like `TimeServiceInterface<S, DelayMs>`. `S` is the derived module; its task settings come from `Fa::TimeServiceTraits<S>` (name, stack words, priority), which is reused unchanged.

### 1.1 `Fa::MpscServiceInterface<S, T, N>` — locking, many producers

```cpp
template <typename S, typename T, size_t N>
struct MpscServiceInterface {
    static bool push(T const &item);                               // task context
    static bool push_from_isr(T const &item, BaseType_t *woken);   // interrupt context
    static void create_task();                                     // called by Application::init
    static uint32_t dropped();                                     // items lost because the buffer was full
    static size_t high_water();                                    // most items ever buffered at once
};
```

- Storage: `std::array<T, N>` plus head/tail indices, all `static inline` (no heap).
- Push: a short critical section (`taskENTER_CRITICAL` / `taskENTER_CRITICAL_FROM_ISR`) around copying one `T` and advancing `head`; then the consumer is notified (`xTaskNotifyGive` / `vTaskNotifyGiveFromISR`).
- `static_assert(std::is_trivially_copyable_v<T>)` and a size limit keep the critical section short and bounded.

### 1.2 `Fa::SpscServiceInterface<S, T, N>` — lock-free, one producer

Same interface, but **exactly one producer** (normally one interrupt handler). This contract is documented, not enforced; two producers would corrupt it.

- `head` is written only by the producer, `tail` only by the consumer (`std::atomic<uint32_t>`; lock-free on Cortex-M).
- Producer: copy the item into its slot, then `head.store(…, release)`.
- Consumer: `head.load(acquire)`, read the items, then `tail.store(…, release)`.
- No critical sections, no compare-and-swap.

### 1.3 Common behaviour

| Aspect | Rule |
|---|---|
| Buffer full | Drop the **new** item, never overwrite; count it (`dropped()`); `FA_ASSERT` in debug builds (same as the actor-queue policy) unless the service sets `assert_on_full = false` — `TraceService` does: trace overflow is expected under load and reported as `LOST` |
| Sizing | `high_water()` records the fullest the buffer has been; size `N` from worst-case runs plus a margin |
| Consumer | The task sleeps until notified, then drains everything available. `S` provides **one** of: `static void consume(T const &) noexcept;` (per item) or `static void consume_batch(T const *items, size_t n) noexcept;` (zero-copy contiguous slices, at most two per drain because of wrap-around). Detected at compile time. |
| Slot release | Slots are released only after `consume`/`consume_batch` returns, so producers never overwrite items being consumed |

### 1.4 Routing through the application

Routed by element type, like events: exactly one registered service per element type `T` (`static_assert`).

```cpp
// Fa::Context<App> (what actors reach through Hsm)
template <typename T> static bool mpsc_push(T const &item);

// Hsm (actor side)
template <typename T> bool mpsc_push(T const &item);            // this->mpsc_push(LogLine{…})

// Fa::Application (interrupt handlers are not actors)
template <typename T> static bool mpsc_push_from_isr(T const &item, BaseType_t *woken);
template <typename T> static bool spsc_push_from_isr(T const &item, BaseType_t *woken);
```

`NullContext` and `Fa::test::RecordingContext` implement `mpsc_push` as a no-op / a recorded entry.

## 2. Trace (target → PC)

### 2.1 What is traced

With `FA_TRACE` defined, the engine hooks in `fa_trace.hpp` (already called at every dispatch, guard, action and transition) build a `TraceRecord` and push it through `M::Context`. Without `FA_TRACE` the hooks stay empty (no code, no data). The application-provided `emit_trace_token()` of today goes away.

| Kind | Value | `id` field | When |
|---|---|---|---|
| `EVENT` | 0 | event index in the actor's `Event` variant | an event is dispatched to the actor |
| `GUARD_FALSE` | 1 | `GuardDescriptor<G>::id` | a guard evaluated false |
| `GUARD_TRUE` | 2 | `GuardDescriptor<G>::id` | a guard evaluated true |
| `ACTION` | 3 | `ActionDescriptor<A>::id` | an action ran (entry, exit, transition or internal) |
| `TRANSITION` | 4 | `src_state << 8 \| dst_state` (indices in `StateCatalog`) | a transition started |
| `DROPPED` | 5 | `target_actor << 8 \| event_index` | an event was lost (the target's queue was full); `actor` = sender |
| `POST` | 6 | `target_actor << 8 \| event_index` | an event is about to be queued; `actor` = **sender** |
| `TIMER_SCHEDULE` | 7 | `target_actor << 8 \| event_index` | `schedule(e, ms, periodic)`; `actor` = owner |
| `TIMER_CANCEL` | 8 | `target_actor << 8 \| event_index` | `cancel(e)`; `actor` = owner |

Sender ids that are not actors: `0xFF` = interrupt (`postFromISR`), `0xFE` = timer expiry, `0xFD` = PC command, `0xFC` = non-actor code in a task (start-up code, periodic modules).

`EVENT` is the backbone: it anchors the guard/action/transition records that follow, and it is the only record of an event the current state ignores. `POST` adds causality: who sent an event, when, and — paired with the matching `EVENT` — how long it waited in the queue.

### 2.1.1 Where records are produced — no user code

Everything is recorded inside the framework; actor code does not change.

- Engine hooks (`dispatch`, `Guard::eval`, `Action::execute`, `Transition::execute`): `EVENT`, `GUARD_*`, `ACTION`, `TRANSITION`. They reach the application through `M::Context::trace<M>(kind, id)`; `NullContext` and `RecordingContext` ignore it.
- Application routing — the single place every event passes before a queue: `POST`, then the queue send, then `DROPPED` if the send failed. `Hsm::post` passes the sending actor's type down (`Ctx::post<Sender>(evt)`), like `schedule` passes the owner. Interrupts, start-up code, the timer service and the PC command service post without `Hsm` and get the reserved sender ids.
- **Ordering rule**: `POST` is recorded *before* the queue send. A higher-priority receiver runs inside `xQueueSend`, so recording afterwards would put its `EVENT` before the `POST` that caused it.
- Timer service: `TIMER_SCHEDULE`, `TIMER_CANCEL`; an expiry is a `POST` with sender `0xFE`, recorded in the tick hook before `xQueueSendFromISR`.

### 2.1.2 Keeping it unintrusive

- The trace consumer task runs at the lowest application priority (only uses otherwise idle time).
- Producers wake the consumer only when the buffer goes from empty to non-empty; other pushes cost a critical section, an 8-byte copy and a timestamp read.
- Full buffer: drop and count, never block (reported as `LOST`).
- Compile time: without `FA_TRACE` nothing is generated; `FA_TRACE_NO_POST` leaves out `POST` and `TIMER_*` records.
- Run time: a filter (record kinds × actors) checked with one comparison before a record is built; default: everything. Changed from the PC with the `FILTER` command (phase 2).
- `trace_write` should not busy-wait in a way that starves anything; interrupt- or DMA-driven transmission is best.

### 2.2 `TraceRecord` — 8 bytes

```cpp
struct TraceRecord {        // trivially copyable; sent little-endian as-is
    uint32_t timestamp;     // board trace clock (wraps; the PC unwraps it)
    uint8_t  kind;          // table above
    uint8_t  actor;         // actor index in the Application (same numbering as timers)
    uint16_t id;
};
```

The actor index could later carry an instance number for multi-instance support (v2).

### 2.3 `Fa::TraceService<Hw, Ctx, Out = Hw>`

An application module on `MpscServiceInterface<TraceService, TraceRecord, N>` (N from `AppTraits`, default 128 → 1 KB). It implements `consume_batch`: frames the records and writes them with `Out::trace_write`. It also sends the `HELLO` frame at start-up and a `LOST` frame after drops (the gap marker).

Registered like any module; `Out` defaults to the board and can be swapped with an alias template:

```cpp
using Application = Fa::Application<Traits, Timebomb::Actor, App::ButtonPoller, Fa::TraceService>;

template <typename Hw, typename Ctx> using RttTrace = Fa::TraceService<Hw, Ctx, Board::RttOut>;
```

### 2.4 Output policy contract (default: the board)

```cpp
static void trace_write(uint8_t const *data, size_t n) noexcept;   // may block (called from the consumer task)
static uint32_t trace_timestamp() noexcept;                        // callable from any context, incl. ISRs
static uint32_t trace_timestamp_hz() noexcept;                     // sent to the PC in HELLO (a function:
                                                                   // the core clock is known only at run time)
```

Checked at compile time with readable `static_assert`s (the hardware-contract detection idiom). On Cortex-M3/M4/M7 boards `trace_timestamp()` is typically the DWT cycle counter (`DWT->CYCCNT`, enabled once in `init()`); boards without it can return the RTOS tick count.

## 3. Commands (PC → target)

### 3.1 `Fa::CommandService<Hw, Ctx>`

An application module on `SpscServiceInterface<CommandService, RxChunk, N>`:

```cpp
struct RxChunk { uint8_t n; uint8_t bytes[7]; };   // 8 bytes, trivially copyable
```

The board's UART receive interrupt collects bytes into `RxChunk`s and pushes them:

```cpp
App::Application::spsc_push_from_isr(chunk, &woken);
portYIELD_FROM_ISR(woken);
```

The consumer task feeds a frame parser and executes complete commands. Replies go out as trace frames through `mpsc_push` to `TraceService`, so there is one outgoing stream and one decoder.

### 3.2 Application support (reflection tables built at compile time)

```cpp
// Fa::Context<App>
static CommandStatus post_by_index(uint8_t actor, uint8_t event, uint8_t const *payload, size_t n);
static uint16_t state_of(uint8_t actor);
static uint8_t actor_count();
```

`post_by_index` rebuilds the event from its bytes (events are trivially copyable; the payload size must match exactly) and posts it through normal routing and the queue-full policy. Reset uses a board policy function, `static void reset() noexcept;` (optional; the command is refused if the board does not provide it).

## 4. Wire format

### 4.1 Framing

Each frame is `type (1 byte) · body · CRC-16/CCITT-FALSE (2 bytes, little-endian, over type + body)`, **COBS-encoded** and terminated by `0x00`.

- COBS makes frames self-synchronising: a receiver that starts listening mid-stream skips to the next `0x00`.
- Overhead: 1 byte per 254 bytes of payload, plus the terminator and CRC.
- A frame body is at most 250 bytes.

### 4.2 Target → PC

| Type | Name | Body |
|---|---|---|
| `0x01` | `HELLO` | `u8 protocol_version` (1) · `u32 trace_timestamp_hz` · `u8 actor_count` · per actor: `u8 name_length` · name (`ActorTraits<A>::Name`, already in flash as the task name) · `u32 model_hash` |
| `0x02` | `RECORDS` | `u8 sequence` · `TraceRecord[]` (up to 31 per frame) |
| `0x03` | `LOST` | `u32 records_dropped` since the previous `LOST` |
| `0x04` | `STATES` | `u8 command_sequence` · per actor: `u16 state_index` |
| `0x05` | `ACK` | `u8 command_sequence` · `u8 status` (0 ok, 1 unknown actor, 2 unknown event, 3 payload size mismatch, 4 queue full, 5 not supported, 6 bad frame) |

`sequence` lets the PC detect lost frames (transport errors) separately from `LOST` (buffer overflow on the target).

### 4.3 PC → target

| Type | Name | Body |
|---|---|---|
| `0x81` | `POST` | `u8 command_sequence` · `u8 actor` · `u8 event_index` · payload bytes |
| `0x82` | `QUERY_STATES` | `u8 command_sequence` |
| `0x83` | `RESET` | `u8 command_sequence` |
| `0x84` | `HELLO_REQUEST` | — (target answers with `HELLO`; for a PC connecting mid-run) |
| `0x85` | `FILTER` | `u8 command_sequence` · `u16 kinds_mask` (bit n = kind n) · `u32 actors_mask` (bit n = actor n) |

## 5. Dictionary (ids → names)

The target sends only numbers. Export writes a tool-owned **`<name>_trace.json`** per machine:

- `machine`, `model_hash`
- `events`: names in `Event` variant order (reserved signals first: `Enter_sig`, `Exit_sig`, `Init_sig`, `ExitToParent_sig`)
- `states`: names in `StateCatalog` order
- `guards`, `actions`: id → name (the ids in `GuardDescriptor`/`ActionDescriptor`)

The blueprint also gets `constexpr uint32_t model_hash` (a hash of the model), which the target reports in `HELLO`. The decoder matches each actor by `ActorTraits::Name` to a dictionary and **warns if the hashes differ** (firmware built from a different model than the dictionary).

## 6. PC side

- **Phase 1 — decoder CLI** (`tools/fa-trace`, Node.js, in this repo): prints the same format as the simulator trace, with timestamps and actor names:
  `12.503 ms  Timebomb  [TRANSITION] LEDON ===> LEDOFF`.
  Its input is a byte stream from one of three sources, on Windows, Linux and macOS:
  - **serial port** via the `serialport` npm package (Node-API, prebuilt binaries for Windows/macOS/Linux, x64 and ARM64; default 115 200 baud);
  - **TCP**, e.g. OpenOCD's RTT server (`rtt server start <port> 0`, needs a debug probe and an RTT `Out` policy on the target) or any serial-to-network bridge;
  - **file or pipe**, for recorded traces and the POSIX test.
  `serialport` is the extension's first native dependency: the `.vsix` must ship its prebuilt binaries for every platform, or be published per platform (`vsce --target`). Development and CI testing happen on Linux; Windows needs a check on a Windows machine or CI runner.
- **Phase 2 — REPL on the board**: the existing REPL commands (`send`, `print state`) sent as command frames; replies and trace shown as today.
- **Phase 3 — VS Code live view**: the HSM editor highlights each actor's active state as the target runs; a trace panel.

## 7. What the designer writes

Once per application:
1. Define `FA_TRACE` in the firmware build.
2. Register the modules: `Fa::TraceService` (and `Fa::CommandService` for two-way) in `Fa::Application<…>`.

Once per board (the transport, like any driver): `trace_write(bytes, n)`, `trace_timestamp()` / `trace_timestamp_hz`, and for two-way the UART receive interrupt pushing `RxChunk`s (optionally `reset()`).

Provided by the framework, the same on every Cortex-M whatever the vendor:
- a cycle-counter clock (`DWT->CYCCNT` through CMSIS) usable as `trace_timestamp`;
- later: `Fa::RttOut`, an RTT transport needing no board code at all.

Everything else — records, sender ids, timestamps, buffering, framing, `HELLO`, gap markers, the dictionary — is the framework's and Export's job.

## 8. Bandwidth

At 115 200 baud a UART carries about 11.5 KB/s ≈ 1 300 records/s after framing. The Timebomb example produces a few dozen records per second. Busy systems should raise the baud rate (the ST-LINK/V2-1 virtual COM port supports up to about 2 Mbaud) or rely on `LOST` frames and `high_water()` to size the buffer.

## 9. Testing

| What | How |
|---|---|
| MPSC/SPSC correctness | Host stress test: producer and consumer threads, millions of items; no loss (except counted drops), duplication or reordering. SPSC also under **ThreadSanitizer**. |
| Drop / high-water / batch slices | Host unit tests (doctest) |
| Records and frames | Actor tests with a recording `Out`: exact bytes for a known sequence |
| End to end | POSIX run: `TraceService` writes to a pipe, the decoder CLI reads it and the harness compares the text; `CommandService` fed from the tick hook (interrupt context), commands checked by their effect on the actors |
| Target build | Both M4 variants compile with `FA_TRACE` on and off; size report shows the cost |

## 10. Phases

1. `MpscServiceInterface`, `TraceService`, records, framing, dictionary export, decoder CLI.
2. `SpscServiceInterface`, `CommandService`, reflection tables, REPL on the board.
3. VS Code live view.

## 11. Decisions

Decided:
1. **Windows**: supported through `serialport` (serial) and TCP (e.g. OpenOCD RTT); file/pipe input everywhere.
2. **Default baud rate**: 115 200.
3. **`emit_trace_token`** is replaced outright by `TraceRecord`s pushed through the context.

4. **Both ends are traced** by default: `EVENT` always with `FA_TRACE`; `POST` and timer records switchable (`FA_TRACE_NO_POST`) and filterable at run time.
