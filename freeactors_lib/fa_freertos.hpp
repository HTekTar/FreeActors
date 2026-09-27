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
}
#endif //FA_FREEACTORS_HPP