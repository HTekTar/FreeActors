/*
 * linenoise.hpp -- guerrilla line editing library against readline guilt.
 *
 * Copyright (c) 2010-2023, Salvatore Sanfilippo <antirez at gmail dot com>
 * Copyright (c) 2010-2013, Pieter Noordhuis <pnoordhuis at gmail dot com>
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 *   * Redistributions of source code must retain the above copyright notice,
 *     this list of conditions and the following disclaimer.
 *   * Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

#pragma once
#ifndef LINENOISE_HPP
#define LINENOISE_HPP

#include <termios.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>
#include <ctype.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/ioctl.h>

#define LINENOISE_DEFAULT_HISTORY_MAX_LEN 100
#define LINENOISE_MAX_LINE 4096

// =========================================================================
//  1. C API Declarations & Types
// =========================================================================

#ifdef __cplusplus
extern "C" {
#endif

typedef struct linenoiseCompletions {
    size_t len;
    char **cvec;
} linenoiseCompletions;

typedef void(linenoiseCompletionCallback)(const char *, linenoiseCompletions *);
typedef char*(linenoiseHintsCallback)(const char *, int *color, int *bold);
typedef void(linenoiseFreeHintsCallback)(void *);

void linenoiseSetCompletionCallback(linenoiseCompletionCallback *);
void linenoiseSetHintsCallback(linenoiseHintsCallback *);
void linenoiseSetFreeHintsCallback(linenoiseFreeHintsCallback *);
void linenoiseAddCompletion(linenoiseCompletions *, const char *);

char *linenoise(const char *prompt);
void linenoiseFree(void *ptr);
int linenoiseHistoryAdd(const char *line);
int linenoiseHistorySetMaxLen(int len);
int linenoiseHistorySave(const char *filename);
int linenoiseHistoryLoad(const char *filename);
void linenoiseHistoryFree(void);
void linenoiseClearScreen(void);
void linenoiseSetMultiLine(int ml);
void linenoisePrintKeyCodes(void);
void linenoiseMaskModeEnable(void);
void linenoiseMaskModeDisable(void);

#ifdef __cplusplus
}
#endif

// =========================================================================
//  2. C++17 Inline Internal State (Eliminates ODR / Linker Collisions)
// =========================================================================

namespace linenoise_internal {
    inline linenoiseCompletionCallback *completionCallback = nullptr;
    inline linenoiseHintsCallback *hintsCallback = nullptr;
    inline linenoiseFreeHintsCallback *freeHintsCallback = nullptr;
    inline struct termios orig_termios; 
    inline int rawmode = 0; 
    inline int mlmode = 0; 
    inline int atexit_registered = 0; 
    inline int history_max_len = LINENOISE_DEFAULT_HISTORY_MAX_LEN;
    inline int history_len = 0;
    inline char **history = nullptr;
    inline int maskmode = 0;

    enum KEY_ACTION {
        KEY_NULL = 0,
        CTRL_A = 1,
        CTRL_B = 2,
        CTRL_C = 3,
        CTRL_D = 4,
        CTRL_E = 5,
        CTRL_F = 6,
        CTRL_H = 8,
        TAB = 9,
        CTRL_K = 11,
        CTRL_L = 12,
        ENTER = 13,
        CTRL_N = 14,
        CTRL_P = 16,
        CTRL_T = 20,
        CTRL_U = 21,
        CTRL_W = 23,
        ESC = 27,
        BACKSPACE = 127
    };

    struct linenoiseState {
        int ifd;
        int ofd;
        char *buf;
        size_t buflen;
        const char *prompt;
        size_t plen;
        size_t pos;
        size_t oldpos;
        size_t len;
        size_t cols;
        size_t maxrows;
        int history_index;
    };

    struct abuf {
        char *b;
        int len;
    };

    inline void abInit(struct abuf *ab) {
        ab->b = NULL;
        ab->len = 0;
    }

    inline void abAppend(struct abuf *ab, const char *s, int len) {
        char *n = (char*)realloc(ab->b, ab->len + len);
        if (n == NULL) return;
        memcpy(n + ab->len, s, len);
        ab->b = n;
        ab->len += len;
    }

    inline void abFree(struct abuf *ab) {
        free(ab->b);
    }

    inline int enableRawMode(int fd);
    inline void disableRawMode(int fd);

    inline void linenoiseAtExit(void) {
        disableRawMode(STDIN_FILENO);
        linenoiseHistoryFree();
    }

    inline int enableRawMode(int fd) {
        struct termios raw;
        if (!isatty(STDIN_FILENO)) goto fatal;
        if (!atexit_registered) {
            atexit(linenoiseAtExit);
            atexit_registered = 1;
        }
        if (tcgetattr(fd, &orig_termios) == -1) goto fatal;

        raw = orig_termios;
        raw.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
        raw.c_oflag &= ~(OPOST);
        raw.c_cflag |= (CS8);
        raw.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
        raw.c_cc[VMIN] = 1;
        raw.c_cc[VTIME] = 0;

        if (tcsetattr(fd, TCSAFLUSH, &raw) < 0) goto fatal;
        rawmode = 1;
        return 0;

    fatal:
        errno = ENOTTY;
        return -1;
    }

    inline void disableRawMode(int fd) {
        if (rawmode && tcsetattr(fd, TCSAFLUSH, &orig_termios) != -1)
            rawmode = 0;
    }

    inline int getCursorPosition(int ifd, int ofd) {
        char buf[32];
        int cols, rows;
        unsigned int i = 0;

        if (write(ofd, "\x1b[6n", 4) != 4) return -1;

        while (i < sizeof(buf) - 1) {
            if (read(ifd, buf + i, 1) != 1) break;
            if (buf[i] == 'R') break;
            i++;
        }
        buf[i] = '\0';

        if (buf[0] != ESC || buf[1] != '[') return -1;
        if (sscanf(buf + 2, "%d;%d", &rows, &cols) != 2) return -1;
        return cols;
    }

    inline int getColumns(int ifd, int ofd) {
        struct winsize ws;
        if (ioctl(1, TIOCGWINSZ, &ws) == -1 || ws.ws_col == 0) {
            int start = getCursorPosition(ifd, ofd);
            if (start == -1) goto failed;

            if (write(ofd, "\x1b[999C", 6) != 6) goto failed;
            int cols = getCursorPosition(ifd, ofd);
            if (cols == -1) goto failed;

            if (cols > start) {
                char seq[32];
                snprintf(seq, 32, "\x1b[%dD", cols - start);
                if (write(ofd, seq, strlen(seq)) == -1) {}
            }
            return cols;
        } else {
            return ws.ws_col;
        }

    failed:
        return 80;
    }

    inline void linenoiseBeep(void) {
        fprintf(stderr, "\x7");
        fflush(stderr);
    }

    inline void freeCompletions(linenoiseCompletions *lc) {
        for (size_t i = 0; i < lc->len; i++)
            free(lc->cvec[i]);
        if (lc->cvec != NULL)
            free(lc->cvec);
    }

    inline int completeLine(struct linenoiseState *ls) {
        linenoiseCompletions lc = { 0, NULL };
        int nread, nwritten;
        char c = 0;

        completionCallback(ls->buf, &lc);
        if (lc.len == 0) {
            linenoiseBeep();
        } else {
            size_t stop = 0, i = 0;
            while (!stop) {
                if (i < lc.len) {
                    struct linenoiseState saved = *ls;
                    ls->len = ls->pos = strlen(lc.cvec[i]);
                    ls->buf = lc.cvec[i];
                    // Refresh line in single-line mode for autocomplete
                    {
                        char seq[64];
                        size_t plen = strlen(ls->prompt);
                        int fd = ls->ofd;
                        char *buf = ls->buf;
                        size_t len = ls->len;
                        size_t pos = ls->pos;
                        struct abuf ab;
                        abInit(&ab);

                        snprintf(seq, 64, "\r");
                        abAppend(&ab, seq, strlen(seq));
                        abAppend(&ab, ls->prompt, plen);
                        abAppend(&ab, buf, len);
                        snprintf(seq, 64, "\x1b[0K");
                        abAppend(&ab, seq, strlen(seq));
                        snprintf(seq, 64, "\r\x1b[%dC", (int)(pos + plen));
                        abAppend(&ab, seq, strlen(seq));
                        if (write(fd, ab.b, ab.len) == -1) {}
                        abFree(&ab);
                    }
                    ls->len = saved.len;
                    ls->pos = saved.pos;
                    ls->buf = saved.buf;
                }

                nread = read(ls->ifd, &c, 1);
                if (nread <= 0) {
                    freeCompletions(&lc);
                    return -1;
                }

                switch (c) {
                    case TAB:
                        i = (i + 1) % (lc.len + 1);
                        if (i == lc.len) linenoiseBeep();
                        break;
                    case ESC:
                        if (i < lc.len) {
                            // Refresh back to user buffer
                            char seq[64];
                            struct abuf ab;
                            abInit(&ab);
                            snprintf(seq, 64, "\r");
                            abAppend(&ab, seq, strlen(seq));
                            abAppend(&ab, ls->prompt, strlen(ls->prompt));
                            abAppend(&ab, ls->buf, ls->len);
                            snprintf(seq, 64, "\x1b[0K");
                            abAppend(&ab, seq, strlen(seq));
                            snprintf(seq, 64, "\r\x1b[%dC", (int)(ls->pos + strlen(ls->prompt)));
                            abAppend(&ab, seq, strlen(seq));
                            if (write(ls->ofd, ab.b, ab.len) == -1) {}
                            abFree(&ab);
                        }
                        stop = 1;
                        break;
                    default:
                        if (i < lc.len) {
                            nwritten = snprintf(ls->buf, ls->buflen, "%s", lc.cvec[i]);
                            ls->len = ls->pos = nwritten;
                        }
                        stop = 1;
                        break;
                }
            }
        }
        freeCompletions(&lc);
        return c;
    }

    inline void refreshSingleLine(struct linenoiseState *l) {
        char seq[64];
        size_t plen = strlen(l->prompt);
        int fd = l->ofd;
        char *buf = l->buf;
        size_t len = l->len;
        size_t pos = l->pos;
        struct abuf ab;

        while ((plen + pos) >= l->cols) {
            buf++;
            len--;
            pos--;
        }
        while (plen + len > l->cols) {
            len--;
        }

        abInit(&ab);
        snprintf(seq, 64, "\r");
        abAppend(&ab, seq, strlen(seq));
        abAppend(&ab, l->prompt, strlen(l->prompt));
        if (maskmode == 1) {
            while (len--) abAppend(&ab, "*", 1);
        } else {
            abAppend(&ab, buf, len);
        }

        if (hintsCallback && plen + len < l->cols) {
            int color = -1, bold = 0;
            char *hint = hintsCallback(l->buf, &color, &bold);
            if (hint != NULL) {
                int hintlen = strlen(hint);
                int hintdiff = (l->cols - (plen + len));
                if (hintlen > hintdiff) hintlen = hintdiff;
                if (color != -1 || bold != 0)
                    snprintf(seq, 64, "\033[%d;%d;49m", bold, color);
                else
                    snprintf(seq, 64, "\033[90m");
                abAppend(&ab, seq, strlen(seq));
                abAppend(&ab, hint, hintlen);
                abAppend(&ab, "\033[0m", 4);
                if (freeHintsCallback) freeHintsCallback(hint);
            }
        }

        snprintf(seq, 64, "\x1b[0K");
        abAppend(&ab, seq, strlen(seq));
        snprintf(seq, 64, "\r\x1b[%dC", (int)(pos + plen));
        abAppend(&ab, seq, strlen(seq));
        if (write(fd, ab.b, ab.len) == -1) {}
        abFree(&ab);
    }

    inline void refreshLine(struct linenoiseState *l) {
        refreshSingleLine(l);
    }

    inline int linenoiseEditInsert(struct linenoiseState *l, char c) {
        if (l->len < l->buflen) {
            if (l->len == l->pos) {
                l->buf[l->pos] = c;
                l->pos++;
                l->len++;
                l->buf[l->len] = '\0';
                if ((!hintsCallback && l->plen + l->len < l->cols && !maskmode)) {
                    if (write(l->ofd, &c, 1) == -1) return -1;
                } else {
                    refreshLine(l);
                }
            } else {
                memmove(l->buf + l->pos + 1, l->buf + l->pos, l->len - l->pos);
                l->buf[l->pos] = c;
                l->len++;
                l->pos++;
                l->buf[l->len] = '\0';
                refreshLine(l);
            }
        }
        return 0;
    }

    inline void linenoiseEditMoveLeft(struct linenoiseState *l) {
        if (l->pos > 0) {
            l->pos--;
            refreshLine(l);
        }
    }

    inline void linenoiseEditMoveRight(struct linenoiseState *l) {
        if (l->pos != l->len) {
            l->pos++;
            refreshLine(l);
        }
    }

    inline void linenoiseEditMoveHome(struct linenoiseState *l) {
        if (l->pos != 0) {
            l->pos = 0;
            refreshLine(l);
        }
    }

    inline void linenoiseEditMoveEnd(struct linenoiseState *l) {
        if (l->pos != l->len) {
            l->pos = l->len;
            refreshLine(l);
        }
    }

    inline void linenoiseEditHistoryNext(struct linenoiseState *l, int dir) {
        if (history_len > 1) {
            free(history[history_len - 1 - l->history_index]);
            history[history_len - 1 - l->history_index] = strdup(l->buf);
            l->history_index += (dir == 1) ? 1 : -1;
            if (l->history_index < 0) {
                l->history_index = 0;
                return;
            } else if (l->history_index >= history_len) {
                l->history_index = history_len - 1;
                return;
            }
            strncpy(l->buf, history[history_len - 1 - l->history_index], l->buflen);
            l->buf[l->buflen - 1] = '\0';
            l->len = l->pos = strlen(l->buf);
            refreshLine(l);
        }
    }

    inline void linenoiseEditDelete(struct linenoiseState *l) {
        if (l->len > 0 && l->pos < l->len) {
            memmove(l->buf + l->pos, l->buf + l->pos + 1, l->len - l->pos - 1);
            l->len--;
            l->buf[l->len] = '\0';
            refreshLine(l);
        }
    }

    inline void linenoiseEditBackspace(struct linenoiseState *l) {
        if (l->pos > 0 && l->len > 0) {
            memmove(l->buf + l->pos - 1, l->buf + l->pos, l->len - l->pos);
            l->pos--;
            l->len--;
            l->buf[l->len] = '\0';
            refreshLine(l);
        }
    }

    inline void linenoiseEditDeletePrevWord(struct linenoiseState *l) {
        size_t old_pos = l->pos;
        size_t diff;

        while (l->pos > 0 && l->buf[l->pos - 1] == ' ') l->pos--;
        while (l->pos > 0 && l->buf[l->pos - 1] != ' ') l->pos--;
        diff = old_pos - l->pos;
        memmove(l->buf + l->pos, l->buf + old_pos, l->len - old_pos + 1);
        l->len -= diff;
        refreshLine(l);
    }

    inline int linenoiseEdit(int stdin_fd, int stdout_fd, char *buf, size_t buflen, const char *prompt) {
        struct linenoiseState l;
        l.ifd = stdin_fd;
        l.ofd = stdout_fd;
        l.buf = buf;
        l.buflen = buflen;
        l.prompt = prompt;
        l.plen = strlen(prompt);
        l.oldpos = l.pos = 0;
        l.len = 0;
        l.cols = getColumns(stdin_fd, stdout_fd);
        l.maxrows = 0;
        l.history_index = 0;

        l.buf[0] = '\0';
        l.buflen--;

        linenoiseHistoryAdd("");

        if (write(l.ofd, prompt, l.plen) == -1) return -1;
        while (1) {
            char c;
            int nread = read(l.ifd, &c, 1);
            if (nread <= 0) return l.len;

            if (c == TAB && completionCallback != NULL) {
                c = completeLine(&l);
                if (c < 0) return l.len;
                if (c == 0) continue;
            }

            switch (c) {
                case ENTER:
                    history_len--;
                    free(history[history_len]);
                    return (int)l.len;
                case CTRL_C:
                    errno = EAGAIN;
                    return -1;
                case BACKSPACE:
                case 8:
                    linenoiseEditBackspace(&l);
                    break;
                case CTRL_D:
                    if (l.len > 0) {
                        linenoiseEditDelete(&l);
                    } else {
                        history_len--;
                        free(history[history_len]);
                        return -1;
                    }
                    break;
                case CTRL_T:
                    if (l.pos > 0 && l.pos < l.len) {
                        int aux = buf[l.pos - 1];
                        buf[l.pos - 1] = buf[l.pos];
                        buf[l.pos] = aux;
                        if (l.pos != l.len - 1) l.pos++;
                        refreshLine(&l);
                    }
                    break;
                case CTRL_B:
                    linenoiseEditMoveLeft(&l);
                    break;
                case CTRL_F:
                    linenoiseEditMoveRight(&l);
                    break;
                case CTRL_P:
                    linenoiseEditHistoryNext(&l, 1);
                    break;
                case CTRL_N:
                    linenoiseEditHistoryNext(&l, 0);
                    break;
                case ESC: {
                    char seq[3];
                    if (read(l.ifd, seq, 1) == 0) break;
                    if (read(l.ifd, seq + 1, 1) == 0) break;

                    if (seq[0] == '[') {
                        if (seq[1] >= '0' && seq[1] <= '9') {
                            if (read(l.ifd, seq + 2, 1) == 0) break;
                            if (seq[2] == '~') {
                                switch (seq[1]) {
                                    case '3': linenoiseEditDelete(&l); break;
                                }
                            }
                        } else {
                            switch (seq[1]) {
                                case 'A': linenoiseEditHistoryNext(&l, 1); break;
                                case 'B': linenoiseEditHistoryNext(&l, 0); break;
                                case 'C': linenoiseEditMoveRight(&l); break;
                                case 'D': linenoiseEditMoveLeft(&l); break;
                                case 'H': linenoiseEditMoveHome(&l); break;
                                case 'F': linenoiseEditMoveEnd(&l); break;
                            }
                        }
                    } else if (seq[0] == 'O') {
                        switch (seq[1]) {
                            case 'H': linenoiseEditMoveHome(&l); break;
                            case 'F': linenoiseEditMoveEnd(&l); break;
                        }
                    }
                    break;
                }
                default:
                    if (linenoiseEditInsert(&l, c)) return -1;
                    break;
                case CTRL_U:
                    buf[0] = '\0';
                    l.pos = l.len = 0;
                    refreshLine(&l);
                    break;
                case CTRL_K:
                    buf[l.pos] = '\0';
                    l.len = l.pos;
                    refreshLine(&l);
                    break;
                case CTRL_A:
                    linenoiseEditMoveHome(&l);
                    break;
                case CTRL_E:
                    linenoiseEditMoveEnd(&l);
                    break;
                case CTRL_L:
                    linenoiseClearScreen();
                    refreshLine(&l);
                    break;
                case CTRL_W:
                    linenoiseEditDeletePrevWord(&l);
                    break;
            }
        }
        return l.len;
    }

    inline int linenoiseRaw(char *buf, size_t buflen, const char *prompt) {
        int count;
        if (buflen == 0) {
            errno = EINVAL;
            return -1;
        }
        if (enableRawMode(STDIN_FILENO) == -1) return -1;
        count = linenoiseEdit(STDIN_FILENO, STDOUT_FILENO, buf, buflen, prompt);
        disableRawMode(STDIN_FILENO);
        printf("\n");
        return count;
    }
} // namespace linenoise_internal

// =========================================================================
//  3. Public Inline Functions
// =========================================================================

inline void linenoiseSetCompletionCallback(linenoiseCompletionCallback *fn) {
    linenoise_internal::completionCallback = fn;
}

inline void linenoiseSetHintsCallback(linenoiseHintsCallback *fn) {
    linenoise_internal::hintsCallback = fn;
}

inline void linenoiseSetFreeHintsCallback(linenoiseFreeHintsCallback *fn) {
    linenoise_internal::freeHintsCallback = fn;
}

inline void linenoiseAddCompletion(linenoiseCompletions *lc, const char *str) {
    size_t len = strlen(str);
    char *copy = (char*)malloc(len + 1);
    if (!copy) return;
    memcpy(copy, str, len + 1);
    lc->cvec = (char**)realloc(lc->cvec, sizeof(char*) * (lc->len + 1));
    lc->cvec[lc->len++] = copy;
}

inline char *linenoise(const char *prompt) {
    char buf[LINENOISE_MAX_LINE];
    if (!isatty(STDIN_FILENO)) {
        if (fgets(buf, LINENOISE_MAX_LINE, stdin) == NULL) return NULL;
        size_t len = strlen(buf);
        while (len && (buf[len - 1] == '\n' || buf[len - 1] == '\r')) {
            len--;
            buf[len] = '\0';
        }
        return strdup(buf);
    } else {
        int count = linenoise_internal::linenoiseRaw(buf, LINENOISE_MAX_LINE, prompt);
        if (count == -1) return NULL;
        return strdup(buf);
    }
}

inline void linenoiseFree(void *ptr) {
    free(ptr);
}

inline int linenoiseHistoryAdd(const char *line) {
    if (linenoise_internal::history_max_len == 0) return 0;
    if (linenoise_internal::history == NULL) {
        linenoise_internal::history = (char**)malloc(sizeof(char*) * linenoise_internal::history_max_len);
        if (linenoise_internal::history == NULL) return 0;
        memset(linenoise_internal::history, 0, (sizeof(char*) * linenoise_internal::history_max_len));
    }
    if (linenoise_internal::history_len && !strcmp(linenoise_internal::history[linenoise_internal::history_len - 1], line))
        return 0;

    char *linecopy = strdup(line);
    if (!linecopy) return 0;
    if (linenoise_internal::history_len == linenoise_internal::history_max_len) {
        free(linenoise_internal::history[0]);
        memmove(linenoise_internal::history, linenoise_internal::history + 1, sizeof(char*) * (linenoise_internal::history_max_len - 1));
        linenoise_internal::history_len--;
    }
    linenoise_internal::history[linenoise_internal::history_len] = linecopy;
    linenoise_internal::history_len++;
    return 1;
}

inline int linenoiseHistorySetMaxLen(int len) {
    if (len < 1) return 0;
    if (linenoise_internal::history) {
        int tocopy = linenoise_internal::history_len;
        char **newHistory = (char**)malloc(sizeof(char*) * len);
        if (!newHistory) return 0;
        if (len < tocopy) tocopy = len;
        memcpy(newHistory, linenoise_internal::history + (linenoise_internal::history_len - tocopy), sizeof(char*) * tocopy);
        free(linenoise_internal::history);
        linenoise_internal::history = newHistory;
    }
    linenoise_internal::history_max_len = len;
    if (linenoise_internal::history_len > len) {
        linenoise_internal::history_len = len;
    }
    return 1;
}

inline void linenoiseHistoryFree(void) {
    if (linenoise_internal::history) {
        for (int j = 0; j < linenoise_internal::history_len; j++)
            free(linenoise_internal::history[j]);
        free(linenoise_internal::history);
        linenoise_internal::history = NULL;
        linenoise_internal::history_len = 0;
    }
}

inline int linenoiseHistorySave(const char *filename) {
    mode_t old_umask = umask(S_IXUSR | S_IRWXG | S_IRWXO);
    FILE *fp = fopen(filename, "w");
    umask(old_umask);
    if (fp == NULL) return -1;
    chmod(filename, S_IRUSR | S_IWUSR);
    for (int j = 0; j < linenoise_internal::history_len; j++)
        fprintf(fp, "%s\n", linenoise_internal::history[j]);
    fclose(fp);
    return 0;
}

inline int linenoiseHistoryLoad(const char *filename) {
    FILE *fp = fopen(filename, "r");
    char buf[LINENOISE_MAX_LINE];
    if (fp == NULL) return -1;
    while (fgets(buf, LINENOISE_MAX_LINE, fp) != NULL) {
        char *p = strchr(buf, '\r');
        if (!p) p = strchr(buf, '\n');
        if (p) *p = '\0';
        linenoiseHistoryAdd(buf);
    }
    fclose(fp);
    return 0;
}

inline void linenoiseClearScreen(void) {
    if (write(STDOUT_FILENO, "\x1b[H\x1b[2J", 7) <= 0) {}
}

inline void linenoiseSetMultiLine(int ml) {
    linenoise_internal::mlmode = ml;
}

inline void linenoiseMaskModeEnable(void) {
    linenoise_internal::maskmode = 1;
}

inline void linenoiseMaskModeDisable(void) {
    linenoise_internal::maskmode = 0;
}

inline void linenoisePrintKeyCodes(void) {
    char quit[4];
    printf("Linenoise key codes debugging mode.\nPress keys to see scan codes. Type 'quit' to exit.\n");
    if (linenoise_internal::enableRawMode(STDIN_FILENO) == -1) return;
    memset(quit, ' ', 4);
    while (1) {
        char c;
        int nread = read(STDIN_FILENO, &c, 1);
        if (nread <= 0) continue;
        memmove(quit, quit + 1, sizeof(quit) - 1);
        quit[sizeof(quit) - 1] = c;
        if (memcmp(quit, "quit", sizeof(quit)) == 0) break;
        printf("'%c' %02x (%d) (type quit to exit)\n", isprint(c) ? c : '?', (unsigned int)c, (int)c);
        printf("\r");
        fflush(stdout);
    }
    linenoise_internal::disableRawMode(STDIN_FILENO);
}

#endif // LINENOISE_HPP