// Test fixture: a user-owned events header with fields (tests/payload_test.cpp, fa-trace field encoding)
#pragma once
#include <cstdint>

namespace Sensor {

struct Temperature { int16_t celsius = 0; };                       // 2 bytes
struct Frame {                                                      // 7 bytes, alignment 1
    uint8_t length = 0;
    uint8_t data[5]{};
    bool last = false;
};
struct Reading {                                                    // 12 bytes: id, 3 bytes padding, value, scale
    uint8_t id = 0;
    int32_t value = 0;
    float scale = 1.0f;
};
struct Status {};                                                   // no data
struct Custom {                                                     // not understood (a method): raw bytes in fa-trace
    uint16_t raw = 0;
    uint8_t high() const { return static_cast<uint8_t>(raw >> 8); }
};

} // namespace Sensor
