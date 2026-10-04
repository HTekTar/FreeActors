#pragma once
namespace Tap {
struct HwRequirements {
    struct Irq { static const int tap; };
    static bool tap_ack();
};
}
