#pragma once
#ifndef FA_REPL_HPP
#define FA_REPL_HPP

#include <iostream>
#include <string>
#include <vector>
#include <functional>
#include <algorithm>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <conio.h>
#else
#include <termios.h>
#include <unistd.h>
#endif

namespace Fa {

class TerminalRawMode {
public:
    TerminalRawMode() { enable(); }
    ~TerminalRawMode() { disable(); }

    bool is_active() const { return active_; }

private:
    bool active_ = false;

#ifdef _WIN32
    DWORD orig_in_mode_ = 0;
    DWORD orig_out_mode_ = 0;
    HANDLE h_in_ = INVALID_HANDLE_VALUE;
    HANDLE h_out_ = INVALID_HANDLE_VALUE;

    void enable() {
        h_in_ = GetStdHandle(STD_INPUT_HANDLE);
        h_out_ = GetStdHandle(STD_OUTPUT_HANDLE);
        if (h_in_ == INVALID_HANDLE_VALUE || h_out_ == INVALID_HANDLE_VALUE) return;

        GetConsoleMode(h_in_, &orig_in_mode_);
        GetConsoleMode(h_out_, &orig_out_mode_);

        // Enable ANSI escape sequence processing on Windows 10/11
        SetConsoleMode(h_out_, orig_out_mode_ | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN);
        SetConsoleMode(h_in_, ENABLE_VIRTUAL_TERMINAL_INPUT);
        active_ = true;
    }

    void disable() {
        if (!active_) return;
        SetConsoleMode(h_in_, orig_in_mode_);
        SetConsoleMode(h_out_, orig_out_mode_);
        active_ = false;
    }
#else
    struct termios orig_termios_;

    void enable() {
        if (!isatty(STDIN_FILENO)) return;
        if (tcgetattr(STDIN_FILENO, &orig_termios_) == -1) return;

        struct termios raw = orig_termios_;
        raw.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
        raw.c_oflag &= ~(OPOST);
        raw.c_cflag |= (CS8);
        raw.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
        raw.c_cc[VMIN] = 1;
        raw.c_cc[VTIME] = 0;

        if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw) < 0) return;
        active_ = true;
    }

    void disable() {
        if (!active_) return;
        tcsetattr(STDIN_FILENO, TCSAFLUSH, &orig_termios_);
        active_ = false;
    }
#endif
};

class ReplEngine {
public:
    using CompletionCallback = std::function<std::vector<std::string>(const std::string& prefix)>;

    void set_completion_callback(CompletionCallback cb) {
        completion_cb_ = std::move(cb);
    }

    void add_history(const std::string& line) {
        if (!line.empty() && (history_.empty() || history_.back() != line)) {
            history_.push_back(line);
        }
    }

    std::string readline(const std::string& prompt) {
        std::cout << prompt << std::flush;

        TerminalRawMode raw;
        if (!raw.is_active()) {
            // Fallback if terminal redirection / non-TTY
            std::string line;
            if (!std::getline(std::cin, line)) return "";
            return line;
        }

        std::string buffer;
        size_t cursor_pos = 0;
        size_t history_index = history_.size();

        while (true) {
            char c = read_char();

            // Enter (CR / LF)
            if (c == '\r' || c == '\n') {
                std::cout << "\r\n" << std::flush;
                if (!buffer.empty()) add_history(buffer);
                return buffer;
            }

            // Ctrl+C / Ctrl+D
            if (c == 3 || (c == 4 && buffer.empty())) {
                std::cout << "\r\n" << std::flush;
                return "";
            }

            // Backspace (ASCII 8, 127)
            if (c == 127 || c == 8) {
                if (cursor_pos > 0) {
                    buffer.erase(--cursor_pos, 1);
                    refresh_line(prompt, buffer, cursor_pos);
                }
                continue;
            }

            // Tab Completion (ASCII 9)
            if (c == 9) {
                if (completion_cb_) {
                    auto matches = completion_cb_(buffer);
                    if (matches.size() == 1) {
                        buffer = matches[0];
                        cursor_pos = buffer.size();
                        refresh_line(prompt, buffer, cursor_pos);
                    } else if (matches.size() > 1) {
                        // Find common prefix or show suggestions
                        std::cout << "\r\n";
                        for (const auto& match : matches) {
                            std::cout << "  " << match;
                        }
                        std::cout << "\r\n";
                        refresh_line(prompt, buffer, cursor_pos);
                    }
                }
                continue;
            }

            // Escape Sequences (Arrows)
            if (c == 27) {
                char seq[2];
                seq[0] = read_char();
                seq[1] = read_char();

                if (seq[0] == '[') {
                    // Up Arrow (History Back)
                    if (seq[1] == 'A') {
                        if (history_index > 0) {
                            history_index--;
                            buffer = history_[history_index];
                            cursor_pos = buffer.size();
                            refresh_line(prompt, buffer, cursor_pos);
                        }
                    }
                    // Down Arrow (History Forward)
                    else if (seq[1] == 'B') {
                        if (history_index + 1 < history_.size()) {
                            history_index++;
                            buffer = history_[history_index];
                        } else {
                            history_index = history_.size();
                            buffer.clear();
                        }
                        cursor_pos = buffer.size();
                        refresh_line(prompt, buffer, cursor_pos);
                    }
                    // Right Arrow
                    else if (seq[1] == 'C') {
                        if (cursor_pos < buffer.size()) {
                            cursor_pos++;
                            refresh_line(prompt, buffer, cursor_pos);
                        }
                    }
                    // Left Arrow
                    else if (seq[1] == 'D') {
                        if (cursor_pos > 0) {
                            cursor_pos--;
                            refresh_line(prompt, buffer, cursor_pos);
                        }
                    }
                }
                continue;
            }

            // Printable Characters
            if (static_cast<unsigned char>(c) >= 32) {
                buffer.insert(cursor_pos++, 1, c);
                refresh_line(prompt, buffer, cursor_pos);
            }
        }
    }

private:
    std::vector<std::string> history_;
    CompletionCallback completion_cb_;

    char read_char() {
#ifdef _WIN32
        return static_cast<char>(_getch());
#else
        char c = 0;
        if (read(STDIN_FILENO, &c, 1) <= 0) return 0;
        return c;
#endif
    }

    void refresh_line(const std::string& prompt, const std::string& buf, size_t cursor_pos) {
        // VT100: Clear entire line, carriage return, reprint prompt + buf, move cursor
        std::cout << "\x1b[2K\r" << prompt << buf;
        
        // Reposition cursor if not at the end
        if (cursor_pos < buf.size()) {
            size_t move_back = buf.size() - cursor_pos;
            std::cout << "\x1b[" << move_back << "D";
        }
        std::cout << std::flush;
    }
};

} // namespace Fa

#endif // FA_REPL_HPP