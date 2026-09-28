# Single-producer services and continuous DMA — design

Status: **proposal for review**. Nothing here is implemented yet.
Scope: FreeActors v1.0 — a lock-free single-producer service, and continuous (circular) DMA reception built on it. First user: the command side of the trace (`CommandService`, trace.md section 3) receiving over UART with idle-line detection.

## Goals

- Move data from one interrupt to one consumer task without locks, copies or per-byte interrupts.
- Support continuous DMA in its two common forms with one abstraction: **variable-length** reception (UART with idle-line detection) and **fixed blocks** (ADC, audio: half/complete transfer).
- Detect, count and report overruns — including data overwritten *while* the consumer was reading it.
- Stay vendor-neutral: the board drives the DMA controller; the framework owns everything around it (indices, ownership, overrun detection, wake-up, routing).

## Decisions (from the discussion)

1. Processing happens in the service's own task; actors receive small results as events, never raw buffers.
2. Overrun: counted; `FA_ASSERT` in debug builds; command frames are protected by their CRC; sample consumers are told (`span_intact()`, `on_overrun()`).
3. Order: `SpscServiceInterface` first; `DmaRingInterface` shares its lock-free core; `CommandService` is the first DMA user; a fixed-block (ADC) example follows.

## 1. Shared lock-free core

Both services keep two **monotonic 32-bit counters** instead of wrapping indices:

- `written` — elements made available; advanced **only by the producer** (interrupt).
- `consumed` — elements released; advanced **only by the consumer** task.

`available = written - consumed` (unsigned arithmetic, correct across 2³² wrap-around as long as fewer than 2³² elements are in flight). The slot of element `k` is `k % N`.

Memory ordering (`std::atomic<uint32_t>`, lock-free on Cortex-M):

| Side | Order |
|---|---|
| Producer | write the data (or let the DMA write it) → `written.store(release)` |
| Consumer | `written.load(acquire)` → read the data → `consumed.store(release)` |
| Producer, checking space | `consumed.load(acquire)` |

No critical sections, no compare-and-swap. The consumer is woken with a task notification only when the service goes from empty to non-empty (as in the MPSC service).

## 2. `Fa::SpscServiceInterface<S, T, N>` — one producer, copies items

```cpp
template <typename S, typename T, size_t N>
struct SpscServiceInterface {
    using element_type = T;
    static bool push_from_isr(T const &item, BaseType_t *woken);   // THE producer (one interrupt)
    static bool push(T const &item);                               // alternatively: one task
    static void create_task();
    static uint32_t dropped();
    static size_t high_water();
};
```

- **Exactly one producer** — one interrupt handler *or* one task, never both, never two. This is the one rule the type cannot enforce; two producers corrupt it silently.
- Same consumer contract as `MpscServiceInterface`: `consume(T const&)` or zero-copy `consume_batch(T const*, n)` (at most two spans per drain), optional `on_start()`, task settings from `TimeServiceTraits<S>`.
- Full: drop the new item, count it, `FA_ASSERT` unless `assert_on_full = false`.
- Routing by element type: `Application::spsc_push_from_isr(item, &woken)` finds the single service owning `T`.

## 3. `Fa::DmaRingInterface<S, T, N>` — the DMA hardware is the producer

The DMA runs continuously in **circular mode** over a static buffer of `N` elements. The board's interrupt reports **where the DMA has written up to**; the framework turns positions into spans.

```cpp
template <typename S, typename T, size_t N>
struct DmaRingInterface {
    static T *buffer();                                          // N elements, aligned, statically allocated
    static constexpr size_t size = N;
    static void progress_from_isr(size_t write_position, BaseType_t *woken);   // 0 <= position < N
    static uint32_t overruns();
    static bool span_intact();       // callable inside consume_batch: the span being consumed was not overwritten
    static void create_task();
};
```

`S` provides:

```cpp
static void consume_batch(T const *data, size_t n) noexcept;   // required: spans in place (at most two per drain)
static void on_overrun(size_t lost) noexcept;                   // optional: unread data was overwritten
static void on_start() noexcept;                                // optional
```

### 3.1 Positions → `written`

The interrupt passes the DMA's current write position `p` (an index in the buffer). The framework advances `written` by `(p - last_position) mod N` and wakes the consumer. Interrupts must come at least twice per lap — the **half-transfer and transfer-complete** interrupts guarantee it — so a delta is always less than `N`. `p == last_position` (e.g. an idle-line interrupt with no new data) changes nothing.

- **Variable length (UART + idle line)**: positions arrive at half, complete *and* whenever the line goes idle after a burst → short messages are delivered immediately.
- **Fixed blocks (ADC, audio)**: positions arrive only at `N/2` and `0` → the consumer sees half-buffer blocks. Same code.

### 3.2 Overruns

The hardware cannot be refused: when the consumer falls behind, the DMA overwrites unread data.

| When | Detection | Framework action |
|---|---|---|
| Before a drain | `written - consumed > N` | Count, `FA_ASSERT` (debug), call `on_overrun(lost)`, discard all unread data (resynchronise `consumed` to `written`) |
| During consumption | after `consume_batch`, the DMA moved past `span_start + N` | `span_intact()` returns false (checked by the consumer before acting on its result); counted as an overrun |

Sample consumers compute on the span, then `if (span_intact()) Ctx::post(Result{…});`. Command consumers need nothing extra: a damaged frame fails its CRC.

### 3.3 Buffer placement and caches (policy hooks)

- Alignment: the buffer is aligned to 32 bytes (a cache line on Cortex-M7).
- Placement: `FA_DMA_BUFFER` (defaults to nothing) lets a board put DMA buffers in a DMA-capable RAM section (e.g. **not** the STM32F4's CCM RAM).
- Cache: before a span is consumed the framework calls `Hw::dma_invalidate(ptr, bytes)` if the board provides it (Cortex-M7 D-cache); nothing on Cortex-M4.

### 3.4 Board contract

```cpp
static void rx_stream_start(uint8_t *buffer, size_t n) noexcept;   // called by the service's on_start
// and, from the DMA/UART interrupt:
App::Application::dma_progress_from_isr<Fa::CommandService>(position, &woken);
```

STM32 HAL mapping (UART, idle line, circular DMA):

```cpp
static void rx_stream_start(uint8_t *buffer, size_t n) noexcept {
    HAL_UARTEx_ReceiveToIdle_DMA(&uart, buffer, n);   // DMA configured in circular mode
}
extern "C" void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *h, uint16_t position) {   // half, complete, idle
    BaseType_t woken = pdFALSE;
    App::Application::dma_progress_from_isr<Fa::CommandService>(position % 256, &woken);
    portYIELD_FROM_ISR(woken);
}
```

Starting the stream from the service's `on_start` means data only flows once its consumer runs — no overrun at boot.

## 4. `CommandService` on a DMA ring

`Fa::CommandService<Hw, Ctx, In = Hw>` derives from `DmaRingInterface<CommandService, uint8_t, 256>`; its `consume_batch` feeds `Fa::frame::Decoder` and executes complete commands (trace.md section 3). Boards without DMA can feed the same decoder from a per-byte receive interrupt through `SpscServiceInterface` instead; the command logic does not depend on where the bytes come from.

## 5. Testing

| What | How |
|---|---|
| SPSC core | Host stress test: one producer thread, one consumer thread, many millions of items; nothing lost (except counted drops), duplicated or reordered; run under **ThreadSanitizer** |
| DMA ring logic | Host tests driving `progress_from_isr` with scripted positions: wrap-around, idle-line bursts, deltas of 0, exact-lap and beyond-lap overruns, `span_intact()` during consumption |
| On FreeRTOS | POSIX run: the tick hook plays the DMA (writes bytes into the ring, reports positions); commands decoded and executed |
| On the Nucleo | USART3 (ST-LINK virtual COM port) with circular DMA + idle line: commands from the PC decoder, replies in the trace |
| Target build | Both M4 variants compile; size report |

## 6. Phases

1. `SpscServiceInterface` (+ shared lock-free core, stress test with ThreadSanitizer).
2. `DmaRingInterface` (+ host tests with scripted positions).
3. `CommandService` on the DMA ring (trace phase 2), Nucleo USART3 RX DMA, REPL on the board.
4. Fixed-block example (ADC via DMA, e.g. the internal temperature sensor).
