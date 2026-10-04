// Test fixture: a board for the Minimal application (the Timebomb fixture's and the modules' requirements)
#pragma once
#include <cstddef>
#include <cstdint>

extern "C" uint32_t _estack;
enum IRQn_Type : int { EXTI15_10_IRQn = 40 };

struct TestBoard {
    static void init() {}
    static void set_led(bool) {}
    static uint16_t read_adc(uint8_t) { return 0; }
    static bool read_button() { return false; }

    struct Irq {
#ifndef MISSING_TAP_IRQ
        static constexpr IRQn_Type tap = EXTI15_10_IRQn;
#endif
    };
    static constexpr size_t irq_count = 97;
    static constexpr void const* initial_stack = &_estack;
    static bool tap_ack() { return true; }

    static void trace_write(uint8_t const* data, size_t n) noexcept {
        for (size_t i = 0; i < n; ++i) *reinterpret_cast<volatile uint32_t*>(0x40004804u) = data[i];
    }
    static uint32_t trace_timestamp() noexcept { return 0; }
    static uint32_t trace_timestamp_hz() noexcept { return 16000000; }
};
