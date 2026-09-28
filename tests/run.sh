#!/usr/bin/env bash
# Engine + generator regression tests.
# Generates C++ from tests/fixtures/*.hsm.json with the real extension generator (out/extension.js,
# so run `npm run compile` first — `npm test` does), compiles it against freeactors_lib in FA_SIM
# mode, and checks the dispatch traces. Exits non-zero if any check fails.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/build"
status=0

rm -rf "$OUT"
mkdir -p "$OUT"

for model in timebomb init_action transition_action; do
    node "$ROOT/tests/gen.js" "$ROOT/tests/fixtures/$model.hsm.json" "$OUT" || status=1
done

node "$ROOT/tests/gen.js" --expect-error "$ROOT/tests/fixtures/conflict.hsm.json" "2 unguarded reactions" || status=1

if grep -n 'std::get<' "$OUT"/*_hsm.hpp; then
    echo "FAIL  generated handlers use std::get (throwing path); expected std::get_if"
    status=1
else
    echo "PASS  generated handlers use non-throwing std::get_if"
fi

# build_and_run <name> <source> [extra g++ flags]: compile a doctest binary against the generated headers and run it
build_and_run() {
    local name="$1" source="$2"
    shift 2
    echo "== $name"
    if g++ -std=c++17 -Wall -Wextra "$@" -I"$OUT" -I"$ROOT/freeactors_lib" \
           "$source" -o "$OUT/$name" 2> "$OUT/$name.compile.log"; then
        "$OUT/$name" --no-intro || status=1
    else
        echo "FAIL  $name does not compile (first errors below, full log: tests/build/$name.compile.log)"
        grep -m 8 'error' "$OUT/$name.compile.log"
        status=1
    fi
}

build_and_run frame_test "$ROOT/tests/frame_test.cpp"
build_and_run spsc_test "$ROOT/tests/spsc_test.cpp" -O2 -pthread
build_and_run spsc_test_tsan "$ROOT/tests/spsc_test.cpp" -O1 -g -pthread -fsanitize=thread
build_and_run engine_test "$ROOT/tests/engine_test.cpp"
build_and_run actor_test "$ROOT/tests/actor_test.cpp"
build_and_run actor_test_fa_trace "$ROOT/tests/actor_test.cpp" -DFA_TRACE

# Designer workflow: each fixture exported as a fresh project, built with CMake, tests run with ctest
for model in timebomb init_action transition_action; do
    project="$OUT/projects/$model"
    echo "== exported project: $model"
    node "$ROOT/tests/gen.js" --project "$ROOT/tests/fixtures/$model.hsm.json" "$project" || { status=1; continue; }
    if cmake -S "$project" -B "$project/build" > "$project/cmake.log" 2>&1 &&
       cmake --build "$project/build" -j >> "$project/cmake.log" 2>&1; then
        if ctest --test-dir "$project/build" --output-on-failure > "$project/ctest.log" 2>&1; then
            grep -E "tests passed" "$project/ctest.log"
        else
            echo "FAIL  ctest failed for exported $model project (log: tests/build/projects/$model/ctest.log)"
            grep -E "tests failed|\*\*\*Failed|ERROR" "$project/ctest.log"
            status=1
        fi
    else
        echo "FAIL  exported $model project does not build (log: tests/build/projects/$model/cmake.log)"
        grep -m 8 -E 'error' "$project/cmake.log"
        status=1
    fi
done

# The generated hardware contract must reject a BSP that lacks a declared driver function
# (a copy of the generated TestBsp without set_led() shadows the real one on the include path)
project="$OUT/projects/timebomb"
violation="$OUT/contract_violation"
mkdir -p "$violation"
grep -v 'static void set_led' "$project/timebomb_test_bsp.hpp" > "$violation/timebomb_test_bsp.hpp"
if g++ -std=c++17 -fsyntax-only -I"$violation" -I"$project" -I"$project/freeactors" \
       "$project/tests/timebomb_actor_test.cpp" 2> "$OUT/contract_violation.log"; then
    echo "FAIL  hardware contract accepted a BSP without set_led()"
    status=1
elif grep -q "Contract Violation.*set_led" "$OUT/contract_violation.log"; then
    echo "PASS  hardware contract rejects a BSP without set_led()"
else
    echo "FAIL  BSP without set_led() failed to compile, but not with the contract message (log: tests/build/contract_violation.log)"
    status=1
fi

# Target compile check: the firmware code path built for Cortex-M4 with arm-none-eabi-g++ and real FreeRTOS
# headers, with and without FPU. Compiled, not linked. Needs FREERTOS_KERNEL_PATH (a FreeRTOS kernel
# "Source" folder, containing include/ and portable/); skipped if it or the toolchain is missing.
# target_compile <label> <FreeRTOS port dir> <float flags...>
target_compile() {
    local label="$1" port="$2"
    shift 2
    local obj="$OUT/target_$label.o"
    if arm-none-eabi-g++ -std=c++17 -mcpu=cortex-m4 -mthumb "$@" -Os -fno-exceptions -fno-rtti \
           -ffunction-sections -fdata-sections -Wall -Wextra \
           -I"$ROOT/tests/target" -I"$FREERTOS_KERNEL_PATH/include" -I"$FREERTOS_KERNEL_PATH/portable/GCC/$port" \
           -I"$OUT" -I"$ROOT/tests/fixtures" -I"$ROOT/freeactors_lib" \
           -c "$ROOT/tests/target/target_app.cpp" -o "$obj" 2> "$OUT/target_$label.compile.log"; then
        # text = code + constants (flash), data + bss = RAM
        arm-none-eabi-size "$obj" | awk -v l="$label" 'NR==2 { printf "PASS  target compile (%s): flash %d B, RAM %d B (object only, before linking)\n", l, $1+$2, $2+$3 }'
    else
        echo "FAIL  target compile ($label) (first errors below, full log: tests/build/target_$label.compile.log)"
        grep -m 8 'error' "$OUT/target_$label.compile.log"
        status=1
    fi
}

if ! command -v arm-none-eabi-g++ > /dev/null; then
    echo "SKIP  target compile: arm-none-eabi-g++ not found"
elif [ -z "${FREERTOS_KERNEL_PATH:-}" ] || [ ! -f "$FREERTOS_KERNEL_PATH/include/FreeRTOS.h" ]; then
    echo "SKIP  target compile: set FREERTOS_KERNEL_PATH to a FreeRTOS kernel 'Source' folder"
else
    target_compile m4-fpu ARM_CM4F -mfpu=fpv4-sp-d16 -mfloat-abi=hard
    target_compile m4-nofpu ARM_CM3 -mfloat-abi=soft
    target_compile m4-fpu-trace ARM_CM4F -mfpu=fpv4-sp-d16 -mfloat-abi=hard -DFA_TRACE
fi

# Runtime integration: a real Fa::Application on the FreeRTOS POSIX port (tasks = Linux threads, real tick).
posix_run() {
    local k="$FREERTOS_KERNEL_PATH" posix="$FREERTOS_KERNEL_PATH/portable/ThirdParty/GCC/Posix"
    local dir="$OUT/posix"
    local inc=(-I"$ROOT/tests/posix" -I"$k/include" -I"$posix" -I"$posix/utils" -I"$OUT" -I"$ROOT/tests/fixtures" -I"$ROOT/freeactors_lib")
    mkdir -p "$dir"
    local objs=()
    for src in "$k/tasks.c" "$k/queue.c" "$k/list.c" "$posix/port.c" "$posix/utils/wait_for_event.c"; do
        local obj="$dir/$(basename "$src" .c).o"
        gcc -O1 -pthread "${inc[@]}" -c "$src" -o "$obj" 2>> "$dir/build.log" || { echo "FAIL  posix: kernel build (log: tests/build/posix/build.log)"; status=1; return; }
        objs+=("$obj")
    done
    # posix_app with FreeActors assertions: must pass every check, then stop at the queue-full assertion (exit 3)
    # posix_app_noassert (-DFA_NO_ASSERT): a full queue drops and counts events; must pass every check (exit 0)
    for variant in posix_app posix_app_noassert; do
        local flags=()
        [ "$variant" = posix_app_noassert ] && flags=(-DFA_NO_ASSERT)
        flags+=(-DFA_TRACE)
        if ! g++ -std=c++17 -O1 -pthread -Wall -Wextra "${flags[@]}" "${inc[@]}" "$ROOT/tests/posix/posix_app.cpp" \
                 "${objs[@]}" -o "$dir/$variant" 2>> "$dir/build.log"; then
            echo "FAIL  posix: $variant build (first errors below, full log: tests/build/posix/build.log)"
            grep -m 8 'error' "$dir/build.log"
            status=1
            continue
        fi
        echo "== $variant"
        FA_TRACE_OUT="$dir/$variant.trace" timeout 30 "$dir/$variant" > "$dir/$variant.out" 2>&1
        local code=$?
        cat "$dir/$variant.out"
        if [ "$variant" = posix_app ]; then
            if [ $code -eq 3 ] && grep -q "ASSERT .*fa_freertos.hpp" "$dir/$variant.out" && ! grep -q "^FAIL" "$dir/$variant.out"; then
                echo "PASS  posix: full queue stops at the queue-full assertion when assertions are enabled"
            else
                echo "FAIL  posix: expected every check to pass, then the queue-full assertion (exit 3), got exit $code"
                status=1
            fi
        elif [ $code -ne 0 ]; then
            status=1
        fi
    done

    # The trace of the drop-and-count run, decoded by tools/fa-trace.js with the fixtures' dictionaries
    local trace="$dir/posix_app_noassert.trace.txt"
    node "$ROOT/tools/fa-trace.js" --dict "$OUT" --file "$dir/posix_app_noassert.trace" > "$trace" 2> "$trace.stats"
    echo "== trace ($(cat "$trace.stats"))"
    expect_trace "$trace" "HELLO: protocol 1, clock 1000000 Hz, actors: 0=Timebomb, 1=Counter"
    expect_trace "$trace" \
        "task +\\[POST\\] ButtonPressed -> Timebomb" \
        "Timebomb +\\[EVENT\\] ButtonPressed +\\(from task, " \
        "Timebomb +\\[TRANSITION\\] DISARMED ===> ARMED" \
        "Timebomb +\\[ACTION\\] Entry_ARMED"
    expect_trace "$trace" \
        "Timebomb +\\[SCHEDULE\\] Tick -> Timebomb" \
        "timer +\\[POST\\] Tick -> Timebomb" \
        "Timebomb +\\[EVENT\\] Tick +\\(from timer, " \
        "Timebomb +\\[GUARD\\] TimeUp -> PASSED" \
        "Timebomb +\\[TRANSITION\\] LEDOFF ===> BOOM" \
        "Timebomb +\\[CANCEL\\] Tick -> Timebomb"
    expect_trace "$trace" \
        "timer +\\[POST\\] Go -> Counter" \
        "Counter +\\[EVENT\\] Go +\\(from timer, " \
        "Counter +\\[ACTION\\] Count"
    expect_trace "$trace" \
        "task +\\[DROPPED\\] ButtonPressed -> Timebomb \\(queue full\\)" \
        "timer +\\[DROPPED\\] Tick -> Timebomb \\(queue full\\)"
    if grep -q "warning:" "$trace" || ! grep -q " 0 bad frames" "$trace.stats"; then
        echo "FAIL  trace: decoder warnings or bad frames (see tests/build/posix/posix_app_noassert.trace.txt)"
        grep "warning:" "$trace" | head -3
        status=1
    else
        echo "PASS  trace: no decoder warnings (model hashes match), no bad frames"
    fi
}

# expect_trace <file> <regex>...: the patterns appear in this order (not necessarily adjacent)
expect_trace() {
    local file="$1"
    shift
    local from=1 pattern found
    for pattern in "$@"; do
        found=$(tail -n +"$from" "$file" | grep -n -m1 -E "$pattern" | cut -d: -f1)
        if [ -z "$found" ]; then
            echo "FAIL  trace: missing (in order) '$pattern' (see tests/build/posix/$(basename "$file"))"
            status=1
            return
        fi
        from=$((from + found))
    done
    echo "PASS  trace: $# expected line(s) in order, first: '$1'"
}

if [ -z "${FREERTOS_KERNEL_PATH:-}" ] || [ ! -f "$FREERTOS_KERNEL_PATH/include/FreeRTOS.h" ]; then
    echo "SKIP  posix runtime test: set FREERTOS_KERNEL_PATH to a FreeRTOS kernel 'Source' folder"
else
    posix_run
fi

exit $status
