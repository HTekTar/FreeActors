#pragma once
#ifndef FA_FREEACTORS_HPP
#define FA_FREEACTORS_HPP

// FreeRTOS binding: static per-actor task + queue storage, and periodic process modules.
// Firmware only (needs FreeRTOS.h and a FreeRTOSConfig.h with configSUPPORT_STATIC_ALLOCATION = 1).

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>

#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"

#include "fa_common.hpp"
#include "fa_core.hpp"
#include "fa_spsc.hpp"
#include "fa_util.hpp"

namespace Fa{
    template <typename Actor>
    struct StaticActorStorage {
        using Traits    = ActorTraits<Actor>;
        using EventType = typename Actor::EventType;

        inline static Actor instance;

        inline static StaticTask_t  taskControlBlock;
        inline static StackType_t   taskStack[Traits::StackDepthWords];
        inline static TaskHandle_t  taskHandle{nullptr};

        inline static StaticQueue_t queueControlBlock;
        inline static uint8_t       queueStorage[Traits::QueueLength * sizeof(EventType)];
        inline static QueueHandle_t queueHandle{nullptr};

        // Events lost because this actor's queue was full (posts and timer deliveries never block).
        inline static std::atomic<uint32_t> dropped{0};

        // Queue-full policy: always counted; with assertions enabled (debug) it also stops at FA_ASSERT,
        // because a full queue means QueueLength is too small or the actor is stuck.
        static void on_queue_full() {
            dropped.fetch_add(1, std::memory_order_relaxed);
            FA_ASSERT(false /* actor queue full: increase ActorTraits::QueueLength */);
        }

        [[noreturn]] static void taskLoop(void* /*pvParameters*/) {
            Actor::start(instance);

            EventType event;
            BaseType_t rxStatus;
            for (;;) {
                rxStatus = xQueueReceive(queueHandle, &event, portMAX_DELAY);
                configASSERT(rxStatus  == pdPASS);
                Actor::dispatch(instance, event);
            }
        }
    };

    // ms -> ticks, at least one tick for any ms > 0.
    constexpr TickType_t ms_to_ticks_clamped(std::size_t ms) {
        uint64_t ticks = (static_cast<uint64_t>(ms) * configTICK_RATE_HZ) / 1000ULL;
        if (ms > 0 && ticks == 0) {
            return 1;
        }
        return static_cast<TickType_t>(ticks);
    }

    // Task settings of a periodic process module S: specialise with
    //   static constexpr const char* name;  static constexpr size_t stack_size;  (words)
    //   static constexpr UBaseType_t priority;
    template <typename S>
    struct TimeServiceTraits;

    // Periodic process module. Derive S from TimeServiceInterface<S, DelayMs>, give it
    //   static void task() noexcept;
    // and register S's template in Fa::Application's module list. Application::init creates the task
    // (statically allocated); it runs S::task() every DelayMs, drift-free (vTaskDelayUntil).
    // S can post events to actors through the Ctx it is instantiated with: Ctx::post(evt).
    template <typename S, size_t DelayMs = 1>
    struct TimeServiceInterface {
        static inline TaskHandle_t task_handle{nullptr};
        static inline StackType_t  s_timer_task_stack[TimeServiceTraits<S>::stack_size];
        static inline StaticTask_t task_tcb;
        static inline constexpr TickType_t tick_delay = ms_to_ticks_clamped(DelayMs);

        static void create_task() {
            task_handle = xTaskCreateStatic(
                &service_task,
                TimeServiceTraits<S>::name,
                TimeServiceTraits<S>::stack_size,
                nullptr,
                TimeServiceTraits<S>::priority,
                s_timer_task_stack,
                &task_tcb
            );
            configASSERT(task_handle != nullptr);
        }

        [[noreturn]] static void service_task(void* /*pvParameters*/) {
            static_assert(noexcept(S::task()), "S::task() must be noexcept to prevent exception unwinding into FreeRTOS");

            TickType_t xLastWakeTime = xTaskGetTickCount();
            for (;;) {
                vTaskDelayUntil(&xLastWakeTime, tick_delay);

                S::task();
            }
        }
    };

    namespace detail {
        template <typename S, typename T, typename = void>
        struct has_consume_batch : std::false_type {};
        template <typename S, typename T>
        struct has_consume_batch<S, T, std::void_t<decltype(S::consume_batch(std::declval<T const *>(), size_t{}))>>
            : std::true_type {};

        template <typename S, typename = void>
        struct has_on_start : std::false_type {};
        template <typename S>
        struct has_on_start<S, std::void_t<decltype(S::on_start())>> : std::true_type {};

        // Service kinds: Application routes pushes by item type AND kind, so a multi-producer push can
        // never reach a single-producer service
        struct MpscKind {};
        struct SpscKind {};

        template <typename S, typename = void>
        struct assert_on_full_of : std::true_type {};
        template <typename S>
        struct assert_on_full_of<S, std::void_t<decltype(S::assert_on_full)>>
            : std::bool_constant<S::assert_on_full> {};
    }

    // Multi-producer, single-consumer service (docs/design/trace.md, section 1).
    // Derive S from MpscServiceInterface<S, T, N> and give it ONE of
    //   static void consume(T const &item) noexcept;                    // per item
    //   static void consume_batch(T const *items, size_t n) noexcept;   // contiguous slices, zero-copy
    // optionally static void on_start() noexcept (runs once in the task before draining), and
    // static constexpr bool assert_on_full = false to only count drops. Task settings: TimeServiceTraits<S>.
    //
    // Producers: push() from tasks, push_from_isr() from interrupts (or via Hsm::mpsc_push /
    // Application::mpsc_push_from_isr, routed by T). Each push is a short critical section around one copy.
    // A full buffer drops the new item and counts it (FA_ASSERT unless assert_on_full is false).
    // The consumer task is woken only when the buffer goes from empty to non-empty; slots are released only
    // after S has consumed them, so producers never overwrite items being consumed.
    template <typename S, typename T, size_t N>
    struct MpscServiceInterface {
        using element_type = T;
        using service_kind = detail::MpscKind;

        static_assert(N > 0, "MpscServiceInterface needs at least one slot");
        static_assert(std::is_trivially_copyable_v<T>, "MPSC items must be trivially copyable");
        static_assert(sizeof(T) <= 64, "MPSC items must be small: each push copies one inside a critical section");

        static bool push(T const &item) {
            bool wake = false;
            taskENTER_CRITICAL();
            const bool stored = put(item, wake);
            taskEXIT_CRITICAL();
            if (!stored) {
                on_full();
                return false;
            }
            if (wake && task_handle != nullptr) {
                xTaskNotifyGive(task_handle);
            }
            return true;
        }

        static bool push_from_isr(T const &item, BaseType_t *higher_priority_task_woken) {
            bool wake = false;
            UBaseType_t saved = taskENTER_CRITICAL_FROM_ISR();
            const bool stored = put(item, wake);
            taskEXIT_CRITICAL_FROM_ISR(saved);
            if (!stored) {
                on_full();
                return false;
            }
            if (wake && task_handle != nullptr) {
                vTaskNotifyGiveFromISR(task_handle, higher_priority_task_woken);
            }
            return true;
        }

        static uint32_t dropped() { return dropped_; }
        static size_t high_water() { return high_water_; }

        static void create_task() {
            task_handle = xTaskCreateStatic(
                &service_task,
                TimeServiceTraits<S>::name,
                TimeServiceTraits<S>::stack_size,
                nullptr,
                TimeServiceTraits<S>::priority,
                task_stack_,
                &task_tcb_
            );
            configASSERT(task_handle != nullptr);
        }

        static inline TaskHandle_t task_handle{nullptr};

    private:
        // Caller holds the critical section.
        static bool put(T const &item, bool &wake) {
            if (count_ == N) {
                ++dropped_;
                return false;
            }
            buffer_[head_] = item;
            head_ = (head_ + 1) % N;
            ++count_;
            wake = (count_ == 1);
            if (count_ > high_water_) {
                high_water_ = count_;
            }
            return true;
        }

        static void on_full() {
            if constexpr (detail::assert_on_full_of<S>::value) {
                FA_ASSERT(false /* MPSC service buffer full: increase N */);
            }
        }

        static void consume_span(size_t first, size_t n) {
            if constexpr (detail::has_consume_batch<S, T>::value) {
                S::consume_batch(&buffer_[first], n);
            } else {
                for (size_t i = 0; i < n; ++i) {
                    S::consume(buffer_[first + i]);
                }
            }
        }

        // Consumes everything available; items pushed meanwhile are picked up by the next loop pass.
        static void drain() {
            for (;;) {
                taskENTER_CRITICAL();
                const size_t n = count_;
                const size_t first = tail_;
                taskEXIT_CRITICAL();
                if (n == 0) {
                    return;
                }
                const size_t before_wrap = (n < N - first) ? n : N - first;
                consume_span(first, before_wrap);
                if (n > before_wrap) {
                    consume_span(0, n - before_wrap);
                }
                taskENTER_CRITICAL();
                tail_ = (tail_ + n) % N;
                count_ -= n;
                taskEXIT_CRITICAL();
            }
        }

        [[noreturn]] static void service_task(void * /*pvParameters*/) {
            if constexpr (detail::has_on_start<S>::value) {
                S::on_start();
            }
            drain();   // items pushed before the scheduler started (no task to notify then)
            for (;;) {
                ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
                drain();
            }
        }

        static inline std::array<T, N> buffer_{};
        static inline size_t head_ = 0;
        static inline size_t tail_ = 0;
        static inline size_t count_ = 0;
        static inline uint32_t dropped_ = 0;
        static inline size_t high_water_ = 0;
        static inline StackType_t task_stack_[TimeServiceTraits<S>::stack_size];
        static inline StaticTask_t task_tcb_;
    };

    // Single-producer, single-consumer service, lock-free (docs/design/dma.md, section 2).
    // EXACTLY ONE producer: one interrupt handler (push_from_isr) or one task (push), never both, never two.
    // Consumer contract as MpscServiceInterface: consume(T const&) or zero-copy consume_batch(T const*, n),
    // optional on_start() and assert_on_full; task settings from TimeServiceTraits<S>.
    // Routed by item type: Application::spsc_push_from_isr(item, &woken) / Application::spsc_push(item).
    template <typename S, typename T, size_t N>
    struct SpscServiceInterface {
        using element_type = T;
        using service_kind = detail::SpscKind;

        static bool push_from_isr(T const &item, BaseType_t *higher_priority_task_woken) {
            bool wake = false;
            if (!ring_.push(item, wake)) {
                on_full();
                return false;
            }
            if (wake && task_handle != nullptr) {
                vTaskNotifyGiveFromISR(task_handle, higher_priority_task_woken);
            }
            return true;
        }

        static bool push(T const &item) {
            bool wake = false;
            if (!ring_.push(item, wake)) {
                on_full();
                return false;
            }
            if (wake && task_handle != nullptr) {
                xTaskNotifyGive(task_handle);
            }
            return true;
        }

        static uint32_t dropped() { return ring_.dropped(); }
        static size_t high_water() { return ring_.high_water(); }

        static void create_task() {
            task_handle = xTaskCreateStatic(
                &service_task,
                TimeServiceTraits<S>::name,
                TimeServiceTraits<S>::stack_size,
                nullptr,
                TimeServiceTraits<S>::priority,
                task_stack_,
                &task_tcb_
            );
            configASSERT(task_handle != nullptr);
        }

        static inline TaskHandle_t task_handle{nullptr};

    private:
        static void on_full() {
            if constexpr (detail::assert_on_full_of<S>::value) {
                FA_ASSERT(false /* SPSC service buffer full: increase N */);
            }
        }

        // Consumes until the ring is empty; the final check pairs with the producer's wake decision
        // (fa_spsc.hpp), so returning here and sleeping can never strand an item.
        static void drain() {
            while (ring_.available() > 0) {
                ring_.consume_available([](T const *items, size_t n) {
                    if constexpr (detail::has_consume_batch<S, T>::value) {
                        S::consume_batch(items, n);
                    } else {
                        for (size_t i = 0; i < n; ++i) {
                            S::consume(items[i]);
                        }
                    }
                });
            }
        }

        [[noreturn]] static void service_task(void * /*pvParameters*/) {
            if constexpr (detail::has_on_start<S>::value) {
                S::on_start();
            }
            for (;;) {
                drain();   // also picks up items pushed before the scheduler started
                ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            }
        }

        static inline SpscRing<T, N> ring_;
        static inline StackType_t task_stack_[TimeServiceTraits<S>::stack_size];
        static inline StaticTask_t task_tcb_;
    };
}
#endif //FA_FREEACTORS_HPP