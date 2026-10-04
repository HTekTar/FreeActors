// ==========================================================================
// Hardware requirements of every module kind (tests/requirements/gen_requirements.js generates the contracts):
// a board providing everything passes the application-wide contract; the interrupt module's TestBsp provides
// its interrupt numbers. Board variations that miss something must fail to compile (run.sh, -DMISSING_*).
// ==========================================================================
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "myapp_hw_contract.hpp"
#include "commandrxisr_test_bsp.hpp"

#include <cstddef>
#include <cstdint>

enum IRQn_Type : int { DMA1_Stream1_IRQn = 12, USART3_IRQn = 39 };

struct Board {
    static void init() {}
    static void set_led(bool) {}
    static uint16_t read_adc(uint8_t) { return 0; }
    static bool read_button() { return false; }          // required by Timebomb and ButtonPoller alike
    struct Irq {
#ifndef MISSING_IRQ
        static constexpr IRQn_Type command_rx_dma = DMA1_Stream1_IRQn;
#endif
        static constexpr IRQn_Type command_rx_uart = USART3_IRQn;
    };
#ifndef WRONG_RETURN
    static size_t command_rx_dma_ack() { return 0; }
#else
    static bool command_rx_dma_ack() { return false; }   // the stub's bool kept: converts to size_t, so only the return check sees it
#endif
#ifndef MISSING_ACK
    static size_t command_rx_uart_ack() { return 0; }
#endif
};

static_assert(App::HwContract<Board>::verify());

TEST_CASE("a board with every module's requirements passes the application-wide contract") {
    CHECK(App::HwContract<Board>::verify());
}

TEST_CASE("the interrupt module's test double provides its interrupt numbers and records its calls") {
    CHECK(CommandRxIsr::TestBsp::Irq::command_rx_dma != CommandRxIsr::TestBsp::Irq::command_rx_uart);
    Fa::test::reset<CommandRxIsr::TestBsp>();
    CommandRxIsr::TestBsp::command_rx_dma_ack_result = 17;
    CHECK(CommandRxIsr::TestBsp::command_rx_dma_ack() == 17);
    CHECK(Fa::test::log() == Fa::test::steps{"command_rx_dma_ack"});   // calls without arguments are logged by name
}
