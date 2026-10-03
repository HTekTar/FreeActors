#ifndef FA_INTERRUPT_HPP
#define FA_INTERRUPT_HPP

// ==========================================================================
// Interrupt modules (docs/design/app-diagram.md, section 4.1).
//
// An interrupt is a module of its own, shaped like every other module, but it receives an IsrCtx instead
// of a Ctx: the context offers only what is allowed in an interrupt.
//
//   template <typename Hw, typename IsrCtx>
//   struct ButtonIsr : Fa::InterruptInterface<ButtonIsr<Hw, IsrCtx>> {
//       static constexpr IRQn_Type IRQNum = Hw::Irq::button;   // which interrupt: the board's
//       static constexpr uint32_t PRI = 10;                    // priority, NVIC units (0 = most urgent)
//       static void handler() {
//           if (Hw::button_ack()) IsrCtx::post(Timebomb::ButtonPressed{});
//       }
//   };
//   using Application = Fa::Application<Traits, Timebomb::Actor, ButtonIsr>;
//
// On a Cortex-M target Fa::Application builds the vector table from its interrupt modules at compile time
// (constexpr, in flash), points VTOR at it, sets each priority and enables each interrupt. No vector names,
// no extern "C", no NVIC calls in board code. On the host (tests, POSIX port) nothing is installed; a test
// calls handle() itself to fire the interrupt.
// ==========================================================================

#include <array>
#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "FreeRTOS.h"
#include "task.h"

#include "fa_common.hpp"

#if defined(__arm__) && !defined(FA_SIM)
#define FA_VECTOR_TABLE 1   // a Cortex-M target: the application installs its vector table
#endif

// Yield at the end of an interrupt if a task was woken. On Cortex-M this only pends PendSV. On the host
// (POSIX port) interrupts are simulated from the tick hook, whose tick handler switches tasks itself.
#ifdef FA_VECTOR_TABLE
#define FA_YIELD_FROM_ISR(woken) portYIELD_FROM_ISR(woken)
#else
#define FA_YIELD_FROM_ISR(woken) ((void)(woken))
#endif

namespace Fa {

namespace detail {
    struct InterruptKind {};

    // Priority bits of this device's NVIC: from FreeRTOSConfig.h (configPRIO_BITS, the usual convention)
    // or the CMSIS device header (__NVIC_PRIO_BITS)
#if defined(configPRIO_BITS)
    constexpr unsigned nvic_priority_bits = configPRIO_BITS;
#elif defined(__NVIC_PRIO_BITS)
    constexpr unsigned nvic_priority_bits = __NVIC_PRIO_BITS;
#else
    constexpr unsigned nvic_priority_bits = 0;
#endif
}

// Base of every interrupt module (CRTP). I provides IRQNum, PRI and static void handler().
template <typename I>
struct InterruptInterface {
    using service_kind = detail::InterruptKind;

    // The address the vector table holds
    static void handle() {
        I::handler();
    }

    // Compile-time checks, evaluated when the application installs the module
    static constexpr bool check() {
        static_assert(static_cast<int>(I::IRQNum) >= 0,
            "IRQNum must be a device interrupt (>= 0): core exceptions (SysTick, PendSV, ...) belong to FreeRTOS");
#ifdef FA_VECTOR_TABLE   // priorities only exist on the target
        static_assert(detail::nvic_priority_bits > 0,
            "Unknown NVIC priority bits: define configPRIO_BITS in FreeRTOSConfig.h");
        static_assert(I::PRI < (1u << detail::nvic_priority_bits),
            "PRI is out of range for this device's NVIC priority bits (configPRIO_BITS)");
#if defined(configMAX_SYSCALL_INTERRUPT_PRIORITY)
        static_assert((I::PRI << (8 - detail::nvic_priority_bits)) >= configMAX_SYSCALL_INTERRUPT_PRIORITY,
            "PRI is more urgent than configMAX_SYSCALL_INTERRUPT_PRIORITY: an interrupt at this priority may not "
            "call FreeRTOS (IsrCtx). Use a numerically higher PRI (less urgent).");
#endif
#endif
        return true;
    }
};

template <typename M, typename = void>
struct is_interrupt_module : std::false_type {};
template <typename M>
struct is_interrupt_module<M, std::void_t<typename M::service_kind>>
    : std::is_same<typename M::service_kind, detail::InterruptKind> {};

// The context of interrupt modules: only operations allowed in an interrupt. Each one yields at its end if a
// task was woken (portYIELD_FROM_ISR only pends PendSV on Cortex-M: several in one handler are harmless).
template <typename App>
struct IsrContext {
    // To the actor accepting E (exactly one: checked at compile time)
    template <typename E>
    static void post(E const& evt) {
        BaseType_t woken = pdFALSE;
        App::postFromISR(evt, &woken);
        FA_YIELD_FROM_ISR(woken);
    }

    // To the SPSC or MPSC service owning T (exactly one: checked at compile time)
    template <typename T>
    static bool push(T const& item) {
        BaseType_t woken = pdFALSE;
        const bool pushed = App::push_from_isr(item, &woken);
        FA_YIELD_FROM_ISR(woken);
        return pushed;
    }

    // DMA ring service S: the DMA has written up to position
    template <template <typename, typename> class S>
    static void stream(size_t position) {
        BaseType_t woken = pdFALSE;
        App::template dma_progress_from_isr<S>(position, &woken);
        FA_YIELD_FROM_ISR(woken);
    }

#ifdef FA_TRACE_COMMANDS
    // The built-in command service's receive DMA: written up to position
    static void command_rx(size_t position) {
        BaseType_t woken = pdFALSE;
        App::command_rx_progress_from_isr(position, &woken);
        FA_YIELD_FROM_ISR(woken);
    }
#endif
};

namespace detail {
    template <typename... Is>
    constexpr bool unique_irqs() {
        constexpr int irqs[] = { static_cast<int>(Is::IRQNum)..., -1 };
        for (size_t i = 0; i < sizeof...(Is); ++i)
            for (size_t j = i + 1; j < sizeof...(Is); ++j)
                if (irqs[i] == irqs[j]) return false;
        return true;
    }

    template <typename Hw, typename = void>
    struct has_irq_count : std::false_type {};
    template <typename Hw>
    struct has_irq_count<Hw, std::void_t<decltype(Hw::irq_count)>> : std::true_type {};
}

#ifdef FA_VECTOR_TABLE
// ---- Vector table (Cortex-M targets) ---------------------------------------------------------------------

using Vector = void (*)();

extern "C" {
    // Core exceptions: CMSIS names, defined (often weakly) by the vendor's startup file
    void NMI_Handler(void);
    void HardFault_Handler(void);
    void MemManage_Handler(void);
    void BusFault_Handler(void);
    void UsageFault_Handler(void);
    void DebugMon_Handler(void);
    // FreeRTOS port handlers (FreeRTOSConfig.h may rename them to SVC_Handler etc.; the names follow it)
    void vPortSVCHandler(void);
    void xPortPendSVHandler(void);
    void xPortSysTickHandler(void);
}

namespace detail {
    // An interrupt that is not in the application's vector table: disable it so it cannot fire forever,
    // remember which one it was (debugger: Fa::detail::unexpected_irq), and stop in debug builds.
    inline volatile int32_t unexpected_irq = -1;

    inline void unexpected_interrupt() {
        uint32_t ipsr;
        __asm volatile("mrs %0, ipsr" : "=r"(ipsr));
        const int32_t irq = static_cast<int32_t>(ipsr & 0x1FFu) - 16;
        unexpected_irq = irq;
        if (irq >= 0) {
            reinterpret_cast<volatile uint32_t*>(0xE000E180u)[irq >> 5] = 1u << (irq & 31);   // NVIC_ICER
        }
        FA_ASSERT(false /* an interrupt fired that is not in the application's vector table: see Fa::detail::unexpected_irq */);
    }

    // VTOR needs the table aligned to a power of two at least its size (and at least 128 bytes)
    constexpr size_t vector_alignment(size_t entries) {
        size_t a = 128;
        while (a < entries * sizeof(Vector)) a *= 2;
        return a;
    }

    template <size_t Count, typename... Is>
    constexpr std::array<Vector, Count> build_vector_table() {
        std::array<Vector, Count> v{};
        // [0] initial stack pointer and [1] reset: read by the hardware from the boot table only, never from VTOR
        v[2] = &NMI_Handler;        v[3] = &HardFault_Handler;  v[4] = &MemManage_Handler;
        v[5] = &BusFault_Handler;   v[6] = &UsageFault_Handler;
        v[11] = &vPortSVCHandler;   v[12] = &DebugMon_Handler;
        v[14] = &xPortPendSVHandler; v[15] = &xPortSysTickHandler;
        for (size_t i = 16; i < Count; ++i) v[i] = &unexpected_interrupt;
        ((v[16 + static_cast<size_t>(Is::IRQNum)] = &Is::handle), ...);
        return v;
    }

    template <size_t Count, typename... Is>
    struct VectorTable {
        alignas(vector_alignment(Count)) static constexpr std::array<Vector, Count> table =
            build_vector_table<Count, Is...>();
    };

    inline volatile uint32_t& vtor() { return *reinterpret_cast<volatile uint32_t*>(0xE000ED08u); }
    inline volatile uint8_t* nvic_ipr() { return reinterpret_cast<volatile uint8_t*>(0xE000E400u); }
    inline volatile uint32_t* nvic_iser() { return reinterpret_cast<volatile uint32_t*>(0xE000E100u); }
    inline volatile uint32_t* nvic_icpr() { return reinterpret_cast<volatile uint32_t*>(0xE000E280u); }

    // Points VTOR at the table (interrupts must not fire meanwhile: called before any is enabled)
    inline void install_vector_table(Vector const* table) {
        __asm volatile("dsb" ::: "memory");
        vtor() = reinterpret_cast<uint32_t>(table);
        __asm volatile("dsb\n isb" ::: "memory");
    }

    template <typename I>
    void enable_interrupt() {
        constexpr unsigned irq = static_cast<unsigned>(I::IRQNum);
        nvic_ipr()[irq] = static_cast<uint8_t>(I::PRI << (8 - nvic_priority_bits));
        nvic_icpr()[irq >> 5] = 1u << (irq & 31);   // drop a request that came before the handler was installed
        nvic_iser()[irq >> 5] = 1u << (irq & 31);
    }
}
#endif // FA_VECTOR_TABLE

} // namespace Fa

#endif // FA_INTERRUPT_HPP
