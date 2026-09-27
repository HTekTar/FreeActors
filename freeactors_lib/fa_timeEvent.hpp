#ifndef FA_TIMEEVENT
#define FA_TIMEEVENT

// ==========================================================================
// Time events (firmware): what Hsm::schedule / Hsm::cancel end up in.
//
// - A timer is identified by (owner actor, event type): at most one pending timer per pair.
//   Scheduling a pending one restarts it; cancel removes it.
// - Pending timers live in a fixed pool (MaxTimers slots, MaxEventPayloadSize bytes each), ordered by
//   expiry as a delta list: each slot stores the ticks after the slot before it.
// - The tick interrupt (Application::on_tick_isr from vApplicationTickHook) counts down the head and
//   delivers every timer that expires in that tick straight to its receiving actor's queue
//   (xQueueSendFromISR). Periodic timers are re-inserted relative to their expiry, so they do not drift.
// ==========================================================================

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>

#include "fa_core.hpp"
#include "fa_freertos.hpp"

namespace Fa {

// Identity of a timer: the actor that owns it, the actor that receives it, and the event's index in the
// receiver's event variant (receiver + index identify the event type).
struct TimerKey {
    uint8_t owner;
    uint8_t target;
    uint8_t signal;

    bool operator==(TimerKey const& other) const {
        return owner == other.owner && target == other.target && signal == other.signal;
    }
};

// Fixed pool of pending timers, kept as a delta list. Insert/cancel run in task context (critical section);
// tick runs in the tick interrupt.
template <size_t Sz, size_t N>
class TimerQueue {
    static_assert(N > 0, "TimerQueue needs at least one slot");
    static_assert(N < 255, "TimerQueue capacity must be under 255");
    static constexpr uint8_t NONE = 255;

    struct Slot {
        uint8_t  next;      // next slot in the pending list, or in the free list
        TimerKey key;
        uint32_t delta;     // ticks after the previous pending slot expires
        uint32_t period;    // 0 = one-shot
        alignas(std::max_align_t) uint8_t payload[Sz];
    };

public:
    TimerQueue() {
        for (size_t i = 0; i < N; ++i) {
            slots_[i].next = (i + 1 < N) ? static_cast<uint8_t>(i + 1) : NONE;
        }
    }

    // (Re)starts the timer for key: removes a pending one with the same key, then inserts `size` payload bytes
    // to expire after `ticks` ticks (then every `period` ticks if period > 0). False if the pool is full.
    bool schedule(TimerKey key, void const* payload, size_t size, uint32_t ticks, uint32_t period) {
        taskENTER_CRITICAL();
        remove(key);
        const uint8_t s = free_;
        if (s == NONE) {
            taskEXIT_CRITICAL();
            return false;
        }
        free_ = slots_[s].next;

        slots_[s].key = key;
        slots_[s].period = period;
        std::memcpy(slots_[s].payload, payload, size);
        insert(s, ticks);
        taskEXIT_CRITICAL();
        return true;
    }

    void cancel(TimerKey key) {
        taskENTER_CRITICAL();
        remove(key);
        taskEXIT_CRITICAL();
    }

    // Tick interrupt: count down the head, then hand every timer that expired in this tick to
    // deliver(target, payload_bytes). Periodic timers are re-inserted, one-shots return to the free list.
    template <typename Deliver>
    void tick(Deliver&& deliver) {
        UBaseType_t saved = taskENTER_CRITICAL_FROM_ISR();
        if (head_ != NONE && slots_[head_].delta > 0) {
            --slots_[head_].delta;
        }
        while (head_ != NONE && slots_[head_].delta == 0) {
            const uint8_t s = head_;
            head_ = slots_[s].next;
            deliver(slots_[s].key.target, static_cast<uint8_t const*>(slots_[s].payload));
            if (slots_[s].period > 0) {
                insert(s, slots_[s].period);
            } else {
                slots_[s].next = free_;
                free_ = s;
            }
        }
        taskEXIT_CRITICAL_FROM_ISR(saved);
    }

private:
    // Caller holds the critical section. Timers expiring at the same tick keep scheduling order (FIFO).
    void insert(uint8_t s, uint32_t ticks) {
        uint8_t prev = NONE;
        uint8_t curr = head_;
        uint32_t remaining = ticks;
        while (curr != NONE && remaining >= slots_[curr].delta) {
            remaining -= slots_[curr].delta;
            prev = curr;
            curr = slots_[curr].next;
        }
        slots_[s].delta = remaining;
        slots_[s].next = curr;
        if (curr != NONE) {
            slots_[curr].delta -= remaining;
        }
        if (prev == NONE) {
            head_ = s;
        } else {
            slots_[prev].next = s;
        }
    }

    // Caller holds the critical section. The removed slot's remaining delta moves to its successor, so the
    // other timers keep their expiry times.
    void remove(TimerKey key) {
        uint8_t prev = NONE;
        for (uint8_t curr = head_; curr != NONE; prev = curr, curr = slots_[curr].next) {
            if (slots_[curr].key == key) {
                const uint8_t next = slots_[curr].next;
                if (next != NONE) {
                    slots_[next].delta += slots_[curr].delta;
                }
                if (prev == NONE) {
                    head_ = next;
                } else {
                    slots_[prev].next = next;
                }
                slots_[curr].next = free_;
                free_ = curr;
                return;
            }
        }
    }

    std::array<Slot, N> slots_{};
    uint8_t head_ = NONE;
    uint8_t free_ = 0;
};

// ms -> ticks in 32-bit arithmetic; at least one tick, so a timer never expires in the tick it was set.
inline uint32_t timer_ticks(uint16_t ms) {
    const uint64_t ticks = (static_cast<uint64_t>(ms) * configTICK_RATE_HZ + 999u) / 1000u;
    return ticks == 0 ? 1u : static_cast<uint32_t>(ticks);
}

// ==========================================================================
// TimeEventService: the application's timers, for the actors in List
// ==========================================================================
template <typename List, size_t MaxEventPayloadSize = 32, size_t MaxTimers = 16>
struct TimeEventService;

template <typename... Ms, size_t MaxEventPayloadSize, size_t MaxTimers>
struct TimeEventService<TypeList<Ms...>, MaxEventPayloadSize, MaxTimers> {
private:
    using Actors = TypeList<Ms...>;
    using DeliverFn = void (*)(uint8_t const* payload);

    // Tick interrupt: copy the stored bytes into a real event object (well-defined for trivially copyable
    // types, no aliasing through casts) and queue it for actor M without blocking.
    template <typename M>
    static void deliver(uint8_t const* payload) {
        typename M::EventType event;
        std::memcpy(static_cast<void*>(&event), payload, sizeof(event));
        if (xQueueSendFromISR(StaticActorStorage<M>::queueHandle, &event, nullptr) != pdPASS) {
            StaticActorStorage<M>::on_queue_full();
        }
    }

    static constexpr std::array<DeliverFn, sizeof...(Ms)> deliver_table = { &deliver<Ms>... };

    template <typename Owner, typename Target, typename Evt>
    static TimerKey key_for() {
        using Event = typename Target::EventType;
        static_assert(std::variant_size_v<Event> < 256, "Too many events for a timer key");
        return TimerKey{
            static_cast<uint8_t>(type_id_v<Owner, Actors>),
            static_cast<uint8_t>(type_id_v<Target, Actors>),
            static_cast<uint8_t>(get_index_v<Evt, Event>)
        };
    }

public:
    static inline TimerQueue<MaxEventPayloadSize, MaxTimers> queue;

    // Owner: the scheduling actor. Target: the actor that receives Evt.
    template <typename Owner, typename Target, typename Evt>
    static bool schedule(Evt const& evt, uint16_t ms, bool periodic) {
        using Event = typename Target::EventType;
        static_assert(std::is_trivially_copyable_v<Event>, "Timer events must be trivially copyable");
        static_assert(sizeof(Event) <= MaxEventPayloadSize,
            "Event too large for a timer slot: increase MaxTimerPayloadSize in your AppTraits");

        const Event event = evt;
        const uint32_t ticks = timer_ticks(ms);
        return queue.schedule(key_for<Owner, Target, Evt>(), &event, sizeof(event), ticks, periodic ? ticks : 0u);
    }

    template <typename Owner, typename Target, typename Evt>
    static void cancel() {
        queue.cancel(key_for<Owner, Target, Evt>());
    }

    static void on_tick_isr() {
        queue.tick([](uint8_t target, uint8_t const* payload) {
            if (target < deliver_table.size()) {
                deliver_table[target](payload);
            }
        });
    }
};

} // namespace Fa
#endif
