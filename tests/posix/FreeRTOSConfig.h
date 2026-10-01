#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H

/*
 * FreeRTOS POSIX-port configuration for the FreeActors runtime integration test (tests/run.sh).
 * Tasks run as Linux threads and the tick is a Linux timer, so timing is real time with some jitter.
 */

#define configUSE_PORT_OPTIMISED_TASK_SELECTION     0
#define configTICK_RATE_HZ                          ( 1000 )
#define configUSE_PREEMPTION                        1
#define configUSE_TIME_SLICING                      1
#define configMAX_PRIORITIES                        7
#define configMINIMAL_STACK_SIZE                    128   /* the POSIX port runs each task on its own pthread stack;
                                                             the task stack buffer only holds the thread record */
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
#define INCLUDE_vTaskSuspend                        1

/* A failed configASSERT ends the test run with a message instead of hanging */
#ifdef __cplusplus
extern "C"
#endif
void vFaAssertFailed( const char * file, unsigned long line );
#define configASSERT( x )    if( ( x ) == 0 ) { vFaAssertFailed( __FILE__, __LINE__ ); }

#endif /* FREERTOS_CONFIG_H */
