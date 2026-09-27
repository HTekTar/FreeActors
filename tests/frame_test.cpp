// ==========================================================================
// Wire framing (fa_frame.hpp): CRC-16/CCITT-FALSE, COBS, frame encode/decode. Built and run by tests/run.sh.
// ==========================================================================

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "fa_frame.hpp"

#include <cstring>
#include <random>
#include <vector>

using namespace Fa::frame;
using bytes = std::vector<uint8_t>;

namespace {
    bytes cobs(bytes const &in) {
        bytes out(in.size() + in.size() / 254 + 2);
        out.resize(cobs_encode(in.data(), in.size(), out.data()));
        return out;
    }

    struct Received {
        uint8_t type;
        bytes body;
    };

    std::vector<Received> receive(bytes const &stream, Decoder &decoder) {
        std::vector<Received> frames;
        for (uint8_t b : stream) {
            decoder.feed(b, [&](uint8_t type, uint8_t const *body, size_t n) {
                frames.push_back({type, bytes(body, body + n)});
            });
        }
        return frames;
    }

    bytes framed(uint8_t type, bytes const &body) {
        bytes out(MaxEncoded);
        out.resize(encode(type, body.data(), body.size(), out.data()));
        return out;
    }
}

TEST_CASE("CRC-16/CCITT-FALSE check value") {
    const char *check = "123456789";
    CHECK(crc16(reinterpret_cast<uint8_t const *>(check), 9) == 0x29B1);
}

TEST_CASE("COBS reference vectors") {
    CHECK(cobs({0x00}) == bytes{0x01, 0x01});
    CHECK(cobs({0x00, 0x00}) == bytes{0x01, 0x01, 0x01});
    CHECK(cobs({0x11, 0x22, 0x00, 0x33}) == bytes{0x03, 0x11, 0x22, 0x02, 0x33});
    CHECK(cobs({0x11, 0x00, 0x00, 0x00}) == bytes{0x02, 0x11, 0x01, 0x01, 0x01});

    bytes run(254);
    for (size_t i = 0; i < run.size(); ++i) run[i] = static_cast<uint8_t>(i + 1);
    bytes encoded = cobs(run);
    CHECK(encoded.front() == 0xFF);
    CHECK(std::memchr(encoded.data(), 0, encoded.size()) == nullptr);
}

TEST_CASE("frames round-trip, including zeros and the maximum body") {
    std::mt19937 rng(1234);
    Decoder decoder;
    for (size_t n : {size_t{0}, size_t{1}, size_t{8}, size_t{253}, MaxBody}) {
        if (n > MaxBody) continue;
        bytes body(n);
        for (auto &b : body) b = static_cast<uint8_t>(rng() % 4 == 0 ? 0 : rng());   // plenty of zeros
        bytes wire = framed(0x42, body);
        CHECK(wire.back() == 0x00);
        CHECK(std::memchr(wire.data(), 0, wire.size() - 1) == nullptr);   // only the terminator is zero

        auto frames = receive(wire, decoder);
        REQUIRE(frames.size() == 1);
        CHECK(frames[0].type == 0x42);
        CHECK(frames[0].body == body);
    }
    CHECK(decoder.bad_frames == 0);
}

TEST_CASE("a body longer than MaxBody is refused") {
    bytes body(MaxBody + 1, 1);
    uint8_t out[MaxEncoded + 16];
    CHECK(encode(0x01, body.data(), body.size(), out) == 0);
}

TEST_CASE("the decoder resynchronises after garbage and rejects corrupted frames") {
    Decoder decoder;
    bytes stream = {0x13, 0x37, 0x99};               // listening started mid-frame
    bytes good = framed(0x02, {1, 2, 3, 0, 5});
    bytes bad = framed(0x02, {9, 9, 9});
    bad[2] ^= 0x10;                                  // corrupt one byte: the CRC must catch it
    stream.push_back(0x00);                          // end of the partial frame
    stream.insert(stream.end(), bad.begin(), bad.end());
    stream.insert(stream.end(), good.begin(), good.end());

    auto frames = receive(stream, decoder);
    REQUIRE(frames.size() == 1);
    CHECK(frames[0].body == bytes{1, 2, 3, 0, 5});
    CHECK(decoder.bad_frames == 2);                  // the partial frame and the corrupted one
}
