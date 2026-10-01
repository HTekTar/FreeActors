#ifndef FA_FRAME_HPP
#define FA_FRAME_HPP

// ==========================================================================
// Wire framing for trace and commands (docs/design/trace.md, section 4):
//   frame = type (1) · body (0..MaxBody) · CRC-16/CCITT-FALSE over type+body (2, little-endian)
//   sent COBS-encoded and terminated by 0x00, so a receiver can start mid-stream and resynchronise
//   at the next 0x00.
// No FreeRTOS or hardware dependency: used on the target and in host tests.
// ==========================================================================

#include <cstddef>
#include <cstdint>

namespace Fa::frame {

    constexpr size_t MaxBody = 250;
    constexpr size_t MaxRaw = 1 + MaxBody + 2;                       // type + body + CRC
    constexpr size_t MaxEncoded = MaxRaw + MaxRaw / 254 + 1 + 1;     // COBS overhead + terminating 0x00

    // CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR.
    inline uint16_t crc16(uint8_t const *data, size_t n, uint16_t crc = 0xFFFF) {
        for (size_t i = 0; i < n; ++i) {
            crc ^= static_cast<uint16_t>(data[i]) << 8;
            for (int bit = 0; bit < 8; ++bit) {
                crc = (crc & 0x8000) ? static_cast<uint16_t>((crc << 1) ^ 0x1021) : static_cast<uint16_t>(crc << 1);
            }
        }
        return crc;
    }

    // COBS-encodes n bytes (no zero bytes in the output). Returns the encoded length.
    inline size_t cobs_encode(uint8_t const *in, size_t n, uint8_t *out) {
        size_t write = 1;
        size_t code_index = 0;
        uint8_t code = 1;
        for (size_t read = 0; read < n; ++read) {
            if (in[read] == 0) {
                out[code_index] = code;
                code = 1;
                code_index = write++;
            } else {
                out[write++] = in[read];
                if (++code == 0xFF) {
                    out[code_index] = code;
                    code = 1;
                    code_index = write++;
                }
            }
        }
        out[code_index] = code;
        return write;
    }

    // Decodes n COBS bytes (without the terminating 0x00). Returns the decoded length, or 0 if malformed.
    inline size_t cobs_decode(uint8_t const *in, size_t n, uint8_t *out) {
        size_t read = 0;
        size_t write = 0;
        while (read < n) {
            const uint8_t code = in[read++];
            if (code == 0) return 0;
            for (uint8_t i = 1; i < code; ++i) {
                if (read >= n) return 0;
                out[write++] = in[read++];
            }
            if (code != 0xFF && read < n) {
                out[write++] = 0;
            }
        }
        return write;
    }

    // Builds a complete frame (type, body, CRC, COBS, 0x00) into out (at least MaxEncoded bytes).
    // Returns the number of bytes to send, or 0 if the body is too long.
    // Encodes on the fly, without a copy of the frame: it runs on small task stacks.
    inline size_t encode(uint8_t type, uint8_t const *body, size_t n, uint8_t *out) {
        if (n > MaxBody) return 0;
        uint16_t crc = crc16(&type, 1);
        crc = crc16(body, n, crc);
        size_t write = 1;
        size_t code_index = 0;
        uint8_t code = 1;
        for (size_t i = 0; i < n + 3; ++i) {                     // type, body, CRC low, CRC high
            const uint8_t byte = i == 0 ? type
                               : i <= n ? body[i - 1]
                               : i == n + 1 ? static_cast<uint8_t>(crc & 0xFF) : static_cast<uint8_t>(crc >> 8);
            if (byte == 0) {
                out[code_index] = code;
                code = 1;
                code_index = write++;
            } else {
                out[write++] = byte;
                if (++code == 0xFF) {
                    out[code_index] = code;
                    code = 1;
                    code_index = write++;
                }
            }
        }
        out[code_index] = code;
        out[write] = 0x00;
        return write + 1;
    }

    // Incremental receiver: feed bytes one at a time; on_frame(type, body, n) is called for every complete
    // frame with a valid CRC. Frames that are malformed or too long are dropped (counted in bad_frames).
    class Decoder {
    public:
        template <typename OnFrame>
        void feed(uint8_t byte, OnFrame &&on_frame) {
            if (byte != 0x00) {
                if (length_ < sizeof(encoded_)) {
                    encoded_[length_++] = byte;
                } else {
                    overflow_ = true;
                }
                return;
            }
            // 0x00 ends a frame
            if (length_ > 0) {
                const size_t n = overflow_ ? 0 : cobs_decode(encoded_, length_, raw_);
                if (n >= 3 && n <= MaxRaw && crc16(raw_, n - 2) == static_cast<uint16_t>(raw_[n - 2] | (raw_[n - 1] << 8))) {
                    on_frame(raw_[0], raw_ + 1, n - 3);
                } else {
                    ++bad_frames;
                }
            }
            length_ = 0;
            overflow_ = false;
        }

        uint32_t bad_frames = 0;

    private:
        uint8_t encoded_[MaxEncoded];
        uint8_t raw_[MaxEncoded];      // decoded frame (a member, not on the stack: small task stacks)
        size_t length_ = 0;
        bool overflow_ = false;
    };

} // namespace Fa::frame

#endif // FA_FRAME_HPP
