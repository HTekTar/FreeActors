// ==========================================================================
// Event payloads from the PC: fa-trace encodes field values from the trace dictionary (layouts read from the
// user's events header, tests/fixtures/sensor.events.hpp); the target rebuilds the event from those bytes
// (memcpy, as Application::post_by_index does). Here the frames written by
//   fa-trace --encode "post Sensor ..."  (run.sh, file named by $FA_PAYLOAD_FRAMES)
// are decoded with Fa::frame::Decoder and the events rebuilt; every field must have the value typed on the PC.
// The generated sensor_event_list.hpp also asserts the layouts at compile time.
// ==========================================================================

#define DOCTEST_CONFIG_IMPLEMENT
#include "doctest.h"

#include "sensor_event_list.hpp"
#include "fa_frame.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <type_traits>
#include <vector>

namespace {
    struct Post { uint8_t actor; uint8_t event; std::vector<uint8_t> payload; };
    std::vector<Post> posts;

    // As Application::post_by_index: the payload must be exactly the event's size (0 for an empty event)
    template <typename E>
    E rebuild(Post const &p) {
        constexpr size_t expected = std::is_empty_v<E> ? 0 : sizeof(E);
        REQUIRE(p.payload.size() == expected);
        E e{};
        if constexpr (expected > 0) std::memcpy(static_cast<void *>(&e), p.payload.data(), expected);
        return e;
    }

    template <typename E>
    constexpr uint8_t index_of() { return static_cast<uint8_t>(Fa::get_index_v<E, Sensor::Event>); }
}

TEST_CASE("frames decode to one POST per command, for the right events") {
    REQUIRE(posts.size() == 5);
    CHECK(posts[0].event == index_of<Sensor::Temperature>());
    CHECK(posts[1].event == index_of<Sensor::Reading>());
    CHECK(posts[2].event == index_of<Sensor::Frame>());
    CHECK(posts[3].event == index_of<Sensor::Status>());
    CHECK(posts[4].event == index_of<Sensor::Custom>());
}

TEST_CASE("post Sensor Temperature celsius=-5") {
    CHECK(rebuild<Sensor::Temperature>(posts.at(0)).celsius == -5);
}

TEST_CASE("post Sensor Reading 7 -100000 0.5: positional values, padding after id") {
    const auto r = rebuild<Sensor::Reading>(posts.at(1));
    CHECK(r.id == 7);
    CHECK(r.value == -100000);
    CHECK(r.scale == 0.5f);
}

TEST_CASE("post Sensor Frame length=3 data=1,2,3 last=true: arrays, the rest stays 0") {
    const auto f = rebuild<Sensor::Frame>(posts.at(2));
    CHECK(f.length == 3);
    const uint8_t data[5] = {1, 2, 3, 0, 0};
    CHECK(std::memcmp(f.data, data, sizeof data) == 0);
    CHECK(f.last == true);
}

TEST_CASE("post Sensor Status: an event without data has no payload") {
    rebuild<Sensor::Status>(posts.at(3));
}

TEST_CASE("post Sensor Custom 34 12: a struct fa-trace cannot read takes raw bytes") {
    CHECK(rebuild<Sensor::Custom>(posts.at(4)).raw == 0x1234);
}

int main(int argc, char **argv) {
    char const *path = std::getenv("FA_PAYLOAD_FRAMES");
    if (path == nullptr) { std::fprintf(stderr, "set FA_PAYLOAD_FRAMES\n"); return 2; }
    std::FILE *in = std::fopen(path, "rb");
    if (in == nullptr) { std::fprintf(stderr, "cannot open %s\n", path); return 2; }
    Fa::frame::Decoder decoder;
    for (int byte; (byte = std::fgetc(in)) != EOF;) {
        decoder.feed(static_cast<uint8_t>(byte), [](uint8_t type, uint8_t const *body, size_t n) {
            if (type == 0x81 && n >= 3) posts.push_back({body[1], body[2], std::vector<uint8_t>(body + 3, body + n)});
        });
    }
    std::fclose(in);
    doctest::Context context(argc, argv);
    return context.run();
}
