// Test fixture: hardware requirements of a periodic module
#pragma once
#include <cstdint>
namespace ButtonPoller {
struct HwRequirements {
    static bool read_button();   // PC13, active high
};
} // namespace ButtonPoller
