#ifndef FA_COMMAND_SERVICE_HPP
#define FA_COMMAND_SERVICE_HPP

// ==========================================================================
// Fa::CommandService — commands from the PC (docs/design/trace.md, section 3; wire format section 4.3).
//
// Built into Fa::Application, like the trace service: define FA_TRACE_COMMANDS (needs FA_TRACE) and the
// application creates it. Replies (ACK, STATES, HELLO) go out on the trace stream.
//
// Where the command bytes come from (AppTraits::CommandIn, default: the board) — one of two ways:
//   receive DMA (preferred; docs/design/dma.md section 3.4):
//     static void rx_stream_start(uint8_t *buffer, size_t n) noexcept;   // start continuous reception
//     and from the DMA / UART interrupt:
//       App::Application::command_rx_progress_from_isr(position, &woken); portYIELD_FROM_ISR(woken);
//   one byte per interrupt (no rx_stream_start):
//       App::Application::command_rx_byte_from_isr(byte, &woken);        portYIELD_FROM_ISR(woken);
// Optional:
//     static void reset() noexcept;   // RESET command (needs FA_DEBUG_COMMANDS); refused (NotSupported) without it
//
// FA_DEBUG_COMMANDS unlocks the commands that stop the machine: PAUSE, RESUME, HEALTH_TEST and RESET. Leave it
// off in release builds: the command input is not authenticated. Without it they are answered NotSupported.
//
// Damaged input needs no special care: every command frame carries a CRC, so bytes lost to an overrun
// only cost the frames they were part of (the PC sees no ACK and may retry).
// ==========================================================================

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "fa_common.hpp"
#include "fa_frame.hpp"
#include "fa_freertos.hpp"
#include "fa_trace_service.hpp"

namespace Fa {

namespace command_frame {
    constexpr uint8_t Post         = 0x81;   // u8 sequence, u8 actor, u8 event_index, payload
    constexpr uint8_t QueryStates  = 0x82;   // u8 sequence
    constexpr uint8_t Reset        = 0x83;   // u8 sequence
    constexpr uint8_t HelloRequest = 0x84;   // (no body)
    constexpr uint8_t Filter       = 0x85;   // u8 sequence, u16 kinds_mask, u32 actors_mask
    constexpr uint8_t QueryHealth  = 0x86;   // u8 sequence (FA_HEALTH; refused without it)
    constexpr uint8_t Pause        = 0x87;   // u8 sequence, u8 task (FA_DEBUG_COMMANDS)
    constexpr uint8_t Resume       = 0x88;   // u8 sequence, u8 task (FA_DEBUG_COMMANDS)
    constexpr uint8_t HealthTest   = 0x89;   // u8 sequence, u8 task (FA_DEBUG_COMMANDS and FA_HEALTH)

    constexpr size_t DmaBufferBytes = 256;   // receive DMA ring; frames may span reports and the wrap
    constexpr size_t ByteQueueBytes = 64;    // per-byte reception: bytes queued between interrupt and task
    constexpr uint32_t ResetDelayMs = 50;    // time for the ACK to leave before a reset
}

namespace detail {
    template <typename In, typename = void>
    struct has_rx_stream_start : std::false_type {};
    template <typename In>
    struct has_rx_stream_start<In, std::void_t<decltype(In::rx_stream_start(std::declval<uint8_t *>(), size_t{}))>>
        : std::true_type {};

    template <typename In, typename = void>
    struct has_reset : std::false_type {};
    template <typename In>
    struct has_reset<In, std::void_t<decltype(In::reset())>> : std::true_type {};
}

template <typename Hw, typename Ctx, typename In = Hw>
struct CommandService;

template <typename Hw, typename Ctx, typename In>
struct TimeServiceTraits<CommandService<Hw, Ctx, In>> {
    static constexpr const char* name     = "FaCmd";
    static constexpr size_t stack_size    = 256;   // words: the frame decoder's scratch lives on this stack
    static constexpr UBaseType_t priority = 1;     // same as the trace task: commands are not urgent
};

namespace detail {
    template <typename Hw, typename Ctx, typename In>
    using command_base_t = std::conditional_t<
        has_rx_stream_start<In>::value,
        DmaRingInterface<CommandService<Hw, Ctx, In>, uint8_t, command_frame::DmaBufferBytes>,
        SpscServiceInterface<CommandService<Hw, Ctx, In>, uint8_t, command_frame::ByteQueueBytes>>;
}

template <typename Hw, typename Ctx, typename In>
struct CommandService : detail::command_base_t<Hw, Ctx, In> {
    using Base = detail::command_base_t<Hw, Ctx, In>;
    static constexpr bool uses_dma = detail::has_rx_stream_start<In>::value;

    // A damaged or lost byte only costs its frame (CRC): count, never assert
    static constexpr bool assert_on_overrun = false;
    static constexpr bool assert_on_full = false;

    static void on_start() noexcept {
        if constexpr (uses_dma) {
            In::rx_stream_start(Base::buffer(), Base::size);
        }
    }

    static void consume_batch(uint8_t const *data, size_t n) noexcept {
        for (size_t i = 0; i < n; ++i) {
            decoder_.feed(data[i], [](uint8_t type, uint8_t const *body, size_t length) {
                execute(type, body, length);
            });
        }
    }

    // Frames that failed their CRC or framing (diagnostics)
    static uint32_t bad_frames() { return decoder_.bad_frames; }

private:
    static void ack(uint8_t sequence, CommandStatus status) {
        Ctx::trace_control(trace_frame::ControlAck,
                           static_cast<uint16_t>(sequence << 8 | static_cast<uint8_t>(status)));
    }

    static void execute(uint8_t type, uint8_t const *body, size_t n) {
        if (type == command_frame::HelloRequest) {
            Ctx::trace_control(trace_frame::ControlHello, 0);
            return;
        }
        if (n < 1) {
            return;                                          // no sequence number to answer to
        }
        const uint8_t sequence = body[0];
        switch (type) {
            case command_frame::Post:
                if (n < 3) {
                    ack(sequence, CommandStatus::BadFrame);
                } else {
                    ack(sequence, Ctx::post_by_index(body[1], body[2], body + 3, n - 3));
                }
                break;
            case command_frame::QueryStates:
                Ctx::trace_control(trace_frame::ControlStates, sequence);
                break;
            case command_frame::QueryHealth:
                if constexpr (Ctx::health_enabled) {
                    Ctx::trace_control(trace_frame::ControlHealth, sequence);
                } else {
                    ack(sequence, CommandStatus::NotSupported);
                }
                break;
            case command_frame::Filter:
                if (n != 7) {
                    ack(sequence, CommandStatus::BadFrame);
                } else {
                    const uint32_t kinds = static_cast<uint32_t>(body[1] | body[2] << 8);
                    const uint32_t actors = static_cast<uint32_t>(body[3]) | static_cast<uint32_t>(body[4]) << 8 |
                                            static_cast<uint32_t>(body[5]) << 16 | static_cast<uint32_t>(body[6]) << 24;
                    Ctx::set_trace_filter(kinds, actors);
                    ack(sequence, CommandStatus::Ok);
                }
                break;
            case command_frame::Pause:
            case command_frame::Resume:
            case command_frame::HealthTest:
#ifdef FA_DEBUG_COMMANDS
                if (n != 2) {
                    ack(sequence, CommandStatus::BadFrame);
                } else if (type == command_frame::Pause) {
                    ack(sequence, Ctx::pause_task(body[1]));
                } else if (type == command_frame::Resume) {
                    ack(sequence, Ctx::resume_task(body[1]));
                } else {
                    ack(sequence, Ctx::health_test_task(body[1]));
                }
#else
                ack(sequence, CommandStatus::NotSupported);
#endif
                break;
            case command_frame::Reset:
#ifdef FA_DEBUG_COMMANDS
                if constexpr (detail::has_reset<In>::value) {
                    ack(sequence, CommandStatus::Ok);
                    vTaskDelay(pdMS_TO_TICKS(command_frame::ResetDelayMs));   // let the trace task send the ACK
                    In::reset();
                } else {
                    ack(sequence, CommandStatus::NotSupported);
                }
#else
                ack(sequence, CommandStatus::NotSupported);   // stopping the machine needs FA_DEBUG_COMMANDS
#endif
                break;
            default:
                ack(sequence, CommandStatus::NotSupported);
                break;
        }
    }

    static inline frame::Decoder decoder_;
};

} // namespace Fa

#endif // FA_COMMAND_SERVICE_HPP
