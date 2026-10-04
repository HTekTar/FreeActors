// Test fixture: a periodic module in the shape the module skeletons have (values from AppConfig)
#pragma once
#include "minimal_config.hpp"
#include "fa_freertos.hpp"
#include "timebomb_events.hpp"

namespace App {
template <typename Hw, typename Ctx>
struct ButtonPoller : Fa::TimeServiceInterface<ButtonPoller<Hw, Ctx>, AppConfig::ButtonPoller::period_ms> {
    static void task() noexcept {
        if (Hw::read_button()) Ctx::post(Timebomb::ButtonPressed{});
    }
};
} // namespace App
