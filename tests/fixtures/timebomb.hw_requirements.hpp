// Fixture BSP policy for tests/fixtures/timebomb.hsm.json: declares driver functions so the exported
// project exercises the generated TestBsp stub and the hardware contract (see tests/gen.js --project).
#pragma once
#include <cstdint>

namespace Timebomb {

struct HwRequirements {
    static void init();
    static void set_led(bool on);
    static uint16_t read_adc(uint8_t channel);
    static bool read_button();
};

} // namespace Timebomb
