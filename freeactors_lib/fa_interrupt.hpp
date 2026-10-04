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
//
// Switches (set automatically, except FA_NO_VECTOR_TABLE):
//   FA_CORTEX_M_NVIC     Cortex-M with ARMv7-M or later (M3, M4, M7, M33...): NVIC priorities and enables,
//                        yields from interrupts, priority checks against FreeRTOS
//   FA_VECTOR_TABLE      FreeActors builds the vector table and points VTOR at it
//   FA_NO_VECTOR_TABLE   (yours) the vector table belongs to someone else (a bootloader forwarding interrupts,
//                        Nordic's SoftDevice): no table, VTOR untouched. Bind each interrupt module to its vector
//                        by name in the board's source:   FA_BIND_ISR(USART3_IRQHandler, App::Application, CommandRxIsr)
//                        A module left unbound fails to link (undefined reference to ...interrupt_module_bound_by_FA_BIND_ISR...).
// Interrupt modules on other ARM cores (Cortex-M0/M0+: ARMv6-M; Cortex-A) are a compile error.
// ==========================================================================

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <type_traits>

// FreeRTOS is optional here: host actor tests use interrupt modules with Fa::test::IsrRecordingContext and
// no RTOS; IsrContext and the target parts need it
#if __has_include("FreeRTOS.h")
#include "FreeRTOS.h"
#include "task.h"
#define FA_HAVE_FREERTOS 1
#endif

#include "fa_common.hpp"

#if !defined(FA_SIM) && defined(__ARM_ARCH_PROFILE) && (__ARM_ARCH_PROFILE == 'M') && (__ARM_ARCH >= 7)
#define FA_CORTEX_M_NVIC 1
#ifndef FA_NO_VECTOR_TABLE
#define FA_VECTOR_TABLE 1
#endif
#elif !defined(FA_SIM) && defined(__arm__)
#define FA_INTERRUPTS_UNSUPPORTED 1   // an ARM core without the ARMv7-M NVIC/VTOR (Cortex-M0/M0+, Cortex-A)
#endif

#ifdef FA_HAVE_FREERTOS
// Yield at the end of an interrupt if a task was woken. On Cortex-M this only pends PendSV. On the host
// (POSIX port) interrupts are simulated from the tick hook, whose tick handler switches tasks itself.
#ifdef FA_CORTEX_M_NVIC
#define FA_YIELD_FROM_ISR(woken) portYIELD_FROM_ISR(woken)
#else
#define FA_YIELD_FROM_ISR(woken) ((void)(woken))
#endif
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

#ifdef FA_CORTEX_M_NVIC
namespace detail {
    // NVIC registers (ARMv7-M architecture: the same address on every vendor's Cortex-M3/M4/M7)
    inline volatile uint32_t* nvic_iser() { return reinterpret_cast<volatile uint32_t*>(0xE000E100u); }
    inline volatile uint32_t* nvic_icer() { return reinterpret_cast<volatile uint32_t*>(0xE000E180u); }
    inline volatile uint32_t* nvic_icpr() { return reinterpret_cast<volatile uint32_t*>(0xE000E280u); }
    inline volatile uint8_t*  nvic_ipr()  { return reinterpret_cast<volatile uint8_t*>(0xE000E400u); }
}
#endif

// Base of every interrupt module (CRTP). I provides IRQNum, PRI and static void handler().
template <typename I>
struct InterruptInterface {
    using service_kind = detail::InterruptKind;

    // The address the vector table holds
    static void handle() {
        I::handler();
    }

    // Called once by Fa::Application::init, after every module exists: sets the priority (PRI), drops a
    // request that came before the handler was installed, and enables the interrupt.
    // On the host (tests, POSIX port) there is no NVIC: init, enable and disable do nothing.
    static void init() {
#ifdef FA_CORTEX_M_NVIC
        detail::nvic_ipr()[irq()] = static_cast<uint8_t>(I::PRI << (8 - detail::nvic_priority_bits));
        detail::nvic_icpr()[irq() >> 5] = 1u << (irq() & 31);
        enable();
#endif
    }

    // At run time, e.g. to mask the interrupt in some state or while reconfiguring its peripheral
    static void enable() {
#ifdef FA_CORTEX_M_NVIC
        detail::nvic_iser()[irq() >> 5] = 1u << (irq() & 31);
#endif
    }

    static void disable() {
#ifdef FA_CORTEX_M_NVIC
        detail::nvic_icer()[irq() >> 5] = 1u << (irq() & 31);
        __asm volatile("dsb\n isb" ::: "memory");   // the interrupt cannot fire once this returns
#endif
    }

    static constexpr unsigned irq() { return static_cast<unsigned>(I::IRQNum); }

    // Compile-time checks, evaluated when the application installs the module
    static constexpr bool check() {
        static_assert(static_cast<int>(I::IRQNum) >= 0,
            "IRQNum must be a device interrupt (>= 0): core exceptions (SysTick, PendSV, ...) belong to FreeRTOS");
#ifdef FA_INTERRUPTS_UNSUPPORTED
        static_assert(sizeof(I) == 0,
            "Interrupt modules need a Cortex-M with ARMv7-M or later (M3, M4, M7, M33): NVIC priorities and VTOR");
#endif
#ifdef FA_CORTEX_M_NVIC   // priorities only exist on the target
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

namespace detail {
    // Trace sender of the interrupt running now (0xC0 + module index), saved and restored around each module,
    // so nested interrupts are attributed correctly. TraceSender::Isr outside interrupt modules.
    inline volatile uint8_t current_isr_sender = TraceSender::Isr;

    // The first interrupt fault (storm, unexpected interrupt), for the health monitor to report: set in the
    // interrupt, taken by the monitor task
    struct InterruptFault {
        std::atomic<bool> pending{false};
        uint8_t module = 0;          // TraceSender id: 0xC0 + n, or TraceSender::Isr for an unexpected interrupt
        uint8_t fault = 0;           // HealthFault
        uint16_t value = 0;          // storm: calls in one tick; unexpected: the interrupt number
    };
    inline InterruptFault interrupt_fault;

    inline void report_interrupt_fault(uint8_t module, uint8_t fault, uint16_t value) {
        if (!interrupt_fault.pending.load(std::memory_order_relaxed)) {
            interrupt_fault.module = module;
            interrupt_fault.fault = fault;
            interrupt_fault.value = value;
            interrupt_fault.pending.store(true, std::memory_order_release);
        }
    }

    // Interrupt storm limit: an interrupt module may set MaxRatePerSecond; the default catches a flag that is
    // never cleared (which fires the interrupt back to back, hundreds of thousands of times per second)
    template <typename I, typename = void>
    struct max_rate_of { static constexpr uint32_t value = 50000; };
    template <typename I>
    struct max_rate_of<I, std::void_t<decltype(I::MaxRatePerSecond)>> { static constexpr uint32_t value = I::MaxRatePerSecond; };

    template <typename I, typename = void>
    struct interrupt_name_of { static constexpr const char* value = nullptr; };
    template <typename I>
    struct interrupt_name_of<I, std::void_t<decltype(I::Name)>> { static constexpr const char* value = I::Name; };
}

template <typename M, typename = void>
struct is_interrupt_module : std::false_type {};
template <typename M>
struct is_interrupt_module<M, std::void_t<typename M::service_kind>>
    : std::is_same<typename M::service_kind, detail::InterruptKind> {};

#ifdef FA_HAVE_FREERTOS
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
#endif // FA_HAVE_FREERTOS

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

#if defined(FA_CORTEX_M_NVIC) && !defined(FA_VECTOR_TABLE)
// ---- Binding by name (FA_NO_VECTOR_TABLE) -------------------------------------------------------------------
namespace detail {
    // Defined by FA_BIND_ISR for its module; Application refers to it for every interrupt module, so a module
    // nobody bound is a link error naming it
    // (not const: a const variable at namespace scope would have internal linkage, invisible to the linker)
    template <typename Module>
    extern bool interrupt_module_bound_by_FA_BIND_ISR;

    // Refers to the module's binding in a way the optimizer keeps
    template <typename Module>
    void require_binding() {
        __asm volatile("" :: "r"(&interrupt_module_bound_by_FA_BIND_ISR<Module>));
    }
}
#define FA_BIND_ISR(vector_name, App, Module)                                                                  \
    template <> bool Fa::detail::interrupt_module_bound_by_FA_BIND_ISR<App::module_t<Module>> = true;          \
    extern "C" void vector_name(void) { App::template run_interrupt<App::module_t<Module>>(); }
#endif

#ifdef FA_VECTOR_TABLE
// ---- Vector table (Cortex-M targets) ---------------------------------------------------------------------

using Vector = void (*)();

// One entry of the table: entry 0 is the initial stack pointer (an address), every other entry a handler
union VectorEntry {
    void const* stack;
    Vector handler;
    constexpr VectorEntry() : handler(nullptr) {}
    constexpr VectorEntry(void const* sp) : stack(sp) {}
    constexpr VectorEntry(Vector h) : handler(h) {}
};
static_assert(sizeof(VectorEntry) == 4, "a vector table entry is one 32-bit word");

extern "C" {
    // Core exceptions: CMSIS names. A vendor's startup file usually defines them (weakly); any definition of the
    // application's or the vendor's replaces these weak defaults, which stop here (attach the debugger: the
    // exception's registers are on the stack), so start-up code without them links too
    __attribute__((weak)) void NMI_Handler(void) { for (;;) {} }
    __attribute__((weak)) void HardFault_Handler(void) { for (;;) {} }
    __attribute__((weak)) void MemManage_Handler(void) { for (;;) {} }
    __attribute__((weak)) void BusFault_Handler(void) { for (;;) {} }
    __attribute__((weak)) void UsageFault_Handler(void) { for (;;) {} }
    __attribute__((weak)) void DebugMon_Handler(void) { for (;;) {} }
    // FreeRTOS port handlers (FreeRTOSConfig.h may rename them to SVC_Handler etc.; the names follow it)
    void vPortSVCHandler(void);
    void xPortPendSVHandler(void);
    void xPortSysTickHandler(void);
}

namespace detail {
    // VTOR needs the table aligned to a power of two at least its size (and at least 128 bytes)
    constexpr size_t vector_alignment(size_t entries) {
        size_t a = 128;
        while (a < entries * sizeof(VectorEntry)) a *= 2;
        return a;
    }

    // [0] the initial stack pointer: FreeRTOS reads it through VTOR to reset the main stack when the scheduler
    //     starts (prvPortStartFirstTask), so it must be the real one (the board's Hw::initial_stack)
    // [1] reset: read from the boot table only
    template <size_t Count, typename App, typename... Is>
    constexpr std::array<VectorEntry, Count> build_vector_table(void const* initial_stack) {
        std::array<VectorEntry, Count> v{};
        v[0] = VectorEntry(initial_stack);
        v[2] = VectorEntry(&NMI_Handler);        v[3] = VectorEntry(&HardFault_Handler);
        v[4] = VectorEntry(&MemManage_Handler);  v[5] = VectorEntry(&BusFault_Handler);
        v[6] = VectorEntry(&UsageFault_Handler);
        v[11] = VectorEntry(&vPortSVCHandler);   v[12] = VectorEntry(&DebugMon_Handler);
        v[14] = VectorEntry(&xPortPendSVHandler); v[15] = VectorEntry(&xPortSysTickHandler);
        for (size_t i = 16; i < Count; ++i) v[i] = VectorEntry(&App::unexpected_interrupt);
        ((v[16 + static_cast<size_t>(Is::IRQNum)] = VectorEntry(&App::template run_interrupt<Is>)), ...);
        return v;
    }

    template <typename Hw, typename App, size_t Count, typename... Is>
    struct VectorTable {
        alignas(vector_alignment(Count)) static constexpr std::array<VectorEntry, Count> table =
            build_vector_table<Count, App, Is...>(Hw::initial_stack);
    };

    template <typename Hw, typename = void>
    struct has_initial_stack : std::false_type {};
    template <typename Hw>
    struct has_initial_stack<Hw, std::void_t<decltype(Hw::initial_stack)>> : std::true_type {};

    inline volatile uint32_t& vtor() { return *reinterpret_cast<volatile uint32_t*>(0xE000ED08u); }

    // Points VTOR at the table (interrupts must not fire meanwhile: called before any is enabled)
    inline void install_vector_table(VectorEntry const* table) {
        __asm volatile("dsb" ::: "memory");
        vtor() = reinterpret_cast<uint32_t>(table);
        __asm volatile("dsb\n isb" ::: "memory");
    }
}

#endif // FA_VECTOR_TABLE

} // namespace Fa

#endif // FA_INTERRUPT_HPP
