// Test fixture: an interrupt module in the shape the module skeletons have (priority from AppConfig)
#pragma once
#include "minimal_config.hpp"
#include "fa_interrupt.hpp"
#include "timebomb_events.hpp"

namespace App {
template <typename Hw, typename IsrCtx>
struct Tap : Fa::InterruptInterface<Tap<Hw, IsrCtx>> {
    static constexpr auto IRQNum = Hw::Irq::tap;
    static constexpr uint32_t PRI = AppConfig::Tap::pri;
    static void handler() {
        if (Hw::tap_ack()) IsrCtx::post(Timebomb::ButtonPressed{});
    }
};
} // namespace App
