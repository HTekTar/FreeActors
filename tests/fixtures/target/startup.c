/* Test fixture: a vendor-neutral start-up for any Cortex-M (what a vendor's startup file does): the reset vector,
 * .data copied from flash, .bss cleared, C++ constructors, main(). FreeActors installs its own vector table (VTOR)
 * before the scheduler starts, so this one only needs the stack and the reset entry. */
#include <stdint.h>

extern uint32_t _estack, _sidata, _sdata, _edata, _sbss, _ebss;
extern void __libc_init_array(void);
extern int main(void);

uint32_t SystemCoreClock = 16000000u;   /* CMSIS: the vendor's system_<device>.c defines it */

void Reset_Handler(void) {
    uint32_t *src = &_sidata, *dst = &_sdata;
    while (dst < &_edata) *dst++ = *src++;
    for (dst = &_sbss; dst < &_ebss;) *dst++ = 0;
    __libc_init_array();
    main();
    for (;;) {}
}

static void Default_Handler(void) { for (;;) {} }

__attribute__((section(".isr_vector"), used))
void (*const g_vectors[16])(void) = {
    (void (*)(void))(&_estack), Reset_Handler, Default_Handler, Default_Handler,
};
