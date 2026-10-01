#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H

/*
 * Generic Cortex-M4 configuration for the FreeActors target compile check (tests/run.sh).
 * Compile-only and vendor-neutral: no chip headers; values are typical, not tuned for any part.
 * Used with both the ARM_CM4F (FPU) and ARM_CM3 (M4 without FPU) ports.
 */

#define configCPU_CLOCK_HZ                          ( 84000000UL )
#define configTICK_RATE_HZ                          ( 1000 )
#define configUSE_PREEMPTION                        1
#define configMAX_PRIORITIES                        8
#define configMINIMAL_STACK_SIZE                    128
#define configMAX_TASK_NAME_LEN                     16
#define configUSE_16_BIT_TICKS                      0
#define INCLUDE_uxTaskGetStackHighWaterMark         1
#define configIDLE_SHOULD_YIELD                     1

/* FreeActors allocates every task and queue statically */
#define configSUPPORT_STATIC_ALLOCATION             1
#define configSUPPORT_DYNAMIC_ALLOCATION            0

#define configUSE_IDLE_HOOK                         0
#define configUSE_TICK_HOOK                         1   /* drives Fa::Application::on_tick_isr() */
#define configUSE_MUTEXES                           0
#define configUSE_TIMERS                            0
#define configQUEUE_REGISTRY_SIZE                   0
#define configCHECK_FOR_STACK_OVERFLOW              0
#define configUSE_MALLOC_FAILED_HOOK                0

#define INCLUDE_vTaskDelay                          1
#define INCLUDE_xTaskDelayUntil                     1

/* Cortex-M interrupt priorities. The number of priority bits is chip-specific (commonly 3 or 4). */
#define configPRIO_BITS                             4
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY     15
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 5
#define configKERNEL_INTERRUPT_PRIORITY             ( configLIBRARY_LOWEST_INTERRUPT_PRIORITY << ( 8 - configPRIO_BITS ) )
#define configMAX_SYSCALL_INTERRUPT_PRIORITY        ( configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << ( 8 - configPRIO_BITS ) )

#define configASSERT( x )    if( ( x ) == 0 ) { taskDISABLE_INTERRUPTS(); for( ;; ) {} }

#endif /* FREERTOS_CONFIG_H */
