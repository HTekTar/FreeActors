// Test fixture: hardware requirements of an interrupt module (two interrupts of one DMA reception)
#pragma once
#include <cstddef>
namespace CommandRxIsr {
struct HwRequirements {
    struct Irq {
        static const int command_rx_dma;    // DMA half / complete
        static const int command_rx_uart;   // UART idle line
    };
    static size_t command_rx_dma_ack();
    static size_t command_rx_uart_ack();
};
} // namespace CommandRxIsr
