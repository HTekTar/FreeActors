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
build_and_run dma_test "$ROOT/tests/dma_test.cpp" -O2 -pthread
build_and_run dma_test_tsan "$ROOT/tests/dma_test.cpp" -O1 -g -pthread -fsanitize=thread
build_and_run health_test "$ROOT/tests/health_test.cpp"
# Event payloads: fa-trace encodes field values from the dictionary; the C++ side rebuilds the events from them
node "$ROOT/tests/gen.js" "$ROOT/tests/fixtures/sensor.hsm.json" "$OUT" || status=1
node "$ROOT/tools/fa-trace.js" --dict "$OUT/sensor_trace.json" --actors Sensor \
    --encode "post Sensor Temperature celsius=-5" \
    --encode "post Sensor Reading 7 -100000 0.5" \
    --encode "post Sensor Frame length=3 data=1,2,3 last=true" \
    --encode "post Sensor Status" \
    --encode "post Sensor Custom 34 12" > "$OUT/payload_frames.bin" || { echo "FAIL  fa-trace: payload encoding"; status=1; }
FA_PAYLOAD_FRAMES="$OUT/payload_frames.bin" build_and_run payload_test "$ROOT/tests/payload_test.cpp"
# values fa-trace must refuse, with a message naming the problem
expect_refused() {
    local message
    message=$(node "$ROOT/tools/fa-trace.js" --dict "$OUT/sensor_trace.json" --actors Sensor --encode "$1" 2>&1 >/dev/null)
    if [ $? -ne 0 ] && echo "$message" | grep -q "$2"; then
        echo "PASS  fa-trace refuses '$1' ($2)"
    else
        echo "FAIL  fa-trace accepted '$1' or gave '$message', expected '$2'"; status=1
    fi
}
expect_refused "post Sensor Temperature celsius=40000" "out of range for int16_t"
expect_refused "post Sensor Temperature hot=1" "no field 'hot'"
expect_refused "post Sensor Frame data=1,2,3,4,5,6" "data holds 5 value"
expect_refused "post Sensor Frame last=maybe" "not a bool"
expect_refused "post Sensor Status 1" "too many values"
# a struct changed after the export (a field added) must fail the build with the "export again" message
stale="$OUT/stale_events"
mkdir -p "$stale"
sed 's/struct Temperature { int16_t celsius = 0; };/struct Temperature { int16_t celsius = 0; int16_t offset = 0; };/' \
    "$ROOT/tests/fixtures/sensor.events.hpp" > "$stale/sensor_events.hpp"
printf '#include "sensor_event_list.hpp"\nint main() {}\n' > "$stale/main.cpp"
cp "$OUT/sensor_event_list.hpp" "$stale/"
if g++ -std=c++17 -fsyntax-only -I"$stale" -I"$ROOT/freeactors_lib" "$stale/main.cpp" 2> "$stale/build.log"; then
    echo "FAIL  a struct changed after the export compiled without the layout check firing"; status=1
elif grep -q "Temperature changed since the last export: export again" "$stale/build.log"; then
    echo "PASS  a struct changed after the export fails the build: 'Temperature changed since the last export: export again'"
else
    echo "FAIL  a struct changed after the export failed for another reason (log: tests/build/stale_events/build.log)"; status=1
fi

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

# Hardware requirements of periodic and interrupt modules (functions and struct Irq), the application-wide
# contract, conflicts between modules; a board missing an interrupt or a function fails with a named message
req="$OUT/requirements"
if node "$ROOT/tests/requirements/gen_requirements.js" "$req"; then
    OUT_SAVED="$OUT"; OUT="$req"
    build_and_run requirements_test "$ROOT/tests/requirements/requirements_test.cpp"
    OUT="$OUT_SAVED"
    for case in "MISSING_IRQ|CommandRxIsr Contract Violation\] the board must define its interrupt: struct Irq { static constexpr IRQn_Type command_rx_dma" \
                "MISSING_ACK|CommandRxIsr Contract Violation\] the board must define: static size_t command_rx_uart_ack()" \
                "WRONG_RETURN|CommandRxIsr Contract Violation\] the board's command_rx_dma_ack must return size_t"; do
        flag="${case%%|*}"; expected="${case#*|}"
        if g++ -std=c++17 -fsyntax-only -D"$flag" -I"$req" -I"$ROOT/freeactors_lib" "$ROOT/tests/requirements/requirements_test.cpp" 2> "$req/$flag.log"; then
            echo "FAIL  requirements: a board with $flag compiled"; status=1
        elif grep -q "$expected" "$req/$flag.log"; then
            echo "PASS  requirements: a board with $flag fails with the module's contract message"
        else
            echo "FAIL  requirements: $flag failed without the expected message (log: tests/build/requirements/$flag.log)"; status=1
        fi
    done
else
    status=1
fi

# An actor written before the API block: the patcher adds it once, and the actor still compiles and
# passes the generated actor test (tests/patcher_test.js); FA_IDE (clangd's view) must parse as well
patched="$OUT/patched_actor"
rm -rf "$patched" && mkdir -p "$patched"
if node "$ROOT/tests/patcher_test.js" "$ROOT/tests/fixtures/timebomb.hsm.json" "$patched/timebomb_actor.hpp"; then
    # a copy of the exported project with the patched actor and the converted events in place
    cp -r "$OUT/projects/timebomb" "$patched/project"
    cp "$patched/timebomb_actor.hpp" "$patched/timebomb_events.hpp" "$patched/timebomb_event_list.hpp" "$patched/project/"
    p="$patched/project"
    if g++ -std=c++17 -I"$p" -I"$p/freeactors" "$p/tests/timebomb_actor_test.cpp" \
           -o "$patched/actor_test" 2> "$patched/build.log" && "$patched/actor_test" > "$patched/run.log" 2>&1; then
        echo "PASS  patcher: the patched actor and converted events build and pass the generated actor test"
    else
        echo "FAIL  patcher: the patched actor does not build or its test fails (logs: tests/build/patched_actor/)"
        status=1
    fi
    if g++ -std=c++17 -fsyntax-only -DFA_IDE -I"$p" -I"$p/freeactors" \
           "$p/tests/timebomb_actor_test.cpp" 2> "$patched/ide.log"; then
        echo "PASS  patcher: the IDE view (-DFA_IDE) of the actor parses"
    else
        echo "FAIL  patcher: the IDE view (-DFA_IDE) does not parse (log: tests/build/patched_actor/ide.log)"
        status=1
    fi
else
    status=1
fi

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

# Application checks (checkAppModel): the fixture is clean, each rule's variation is reported
node "$ROOT/tests/app_check_test.js" || status=1

# The editors' providers end to end over real files (tests/fake_vscode.js): top-down creation of state machines,
# one source of truth for events across *.app.json and *.hsm.json
node "$ROOT/tests/provider_test.js" "$OUT/provider" || status=1

# Editors: the real web views (media/) headless in Chrome, driven by scripted mouse events, checked through the DOM
chrome=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)
if [ -z "$chrome" ]; then
    echo "SKIP  editor tests: no Chrome or Chromium found"
else
    echo "== editor tests"
    python3 "$ROOT/tests/editor/editor_test.py" "$chrome" "$OUT/editor" || status=1
fi

# Target compile check: the firmware code path built for Cortex-M4 with arm-none-eabi-g++ and real FreeRTOS
# headers, with and without FPU. Compiled, not linked. Needs FREERTOS_KERNEL_PATH (a FreeRTOS kernel
# "Source" folder, containing include/ and portable/); skipped if it or the toolchain is missing.
# Any function frame over 256 bytes fails the build (-Werror=stack-usage): framework tasks have small stacks
# (e.g. the trace task: 256 words), and the POSIX port, with its large thread stacks, cannot show an overflow.
# target_compile <label> <FreeRTOS port dir> <float flags...>
target_compile() {
    local label="$1" port="$2"
    shift 2
    local obj="$OUT/target_$label.o"
    if arm-none-eabi-g++ -std=c++17 -mcpu=cortex-m4 -mthumb "$@" -Os -fno-exceptions -fno-rtti \
           -ffunction-sections -fdata-sections -Wall -Wextra -Werror=stack-usage=256 \
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

# Application generation: the Minimal application (tests/fixtures/app) generated as Export Application would,
# compiled for Cortex-M4; the diagram's values must arrive in the code; a board missing an interrupt fails
app_generation_checks() {
    local app="$OUT/app" k="$FREERTOS_KERNEL_PATH" f
    local flags=(-std=c++17 -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard -Os -fno-exceptions -fno-rtti -Wall -Wextra
                 -Werror=stack-usage=256 -I"$ROOT/tests/target" -I"$k/include" -I"$k/portable/GCC/ARM_CM4F" -I"$app" -I"$ROOT/freeactors_lib")
    if ! node "$ROOT/tests/app_gen_test.js" "$app" || ! node "$ROOT/tests/gen.js" "$ROOT/tests/fixtures/timebomb.hsm.json" "$app"; then
        status=1; return
    fi
    for f in minimal_app.cpp minimal_main.cpp; do
        if arm-none-eabi-g++ "${flags[@]}" -c "$app/$f" -o "$app/${f%.cpp}.o" 2> "$app/${f%.cpp}.log"; then
            echo "PASS  app generation: $f compiles for Cortex-M4"
        else
            echo "FAIL  app generation: $f does not compile (log: tests/build/app/${f%.cpp}.log)"; grep -m 5 error "$app/${f%.cpp}.log"; status=1
        fi
    done
    # The board blueprint: generated from the requirements, the same application must compile against it as is
    node "$ROOT/tests/board_test.js" "$app" || status=1
    if arm-none-eabi-g++ "${flags[@]}" -I"$app/on_board" -c "$app/on_board/minimal_app.cpp" -o "$app/on_board/minimal_app.o" 2> "$app/on_board/app.log"; then
        echo "PASS  app generation: the application compiles against its generated board blueprint"
    else
        echo "FAIL  app generation: the application against the generated board (log: tests/build/app/on_board/app.log)"
        grep -m 5 error "$app/on_board/app.log"; status=1
    fi
    if arm-none-eabi-g++ "${flags[@]}" -fsyntax-only "$ROOT/tests/app_values_test.cpp" 2> "$app/values.log"; then
        echo "PASS  app generation: the diagram's features, task settings, period, interrupt priority and settings reach the code"
    else
        echo "FAIL  app generation: values from the diagram (log: tests/build/app/values.log)"; grep -m 5 error "$app/values.log"; status=1
    fi
    if arm-none-eabi-g++ "${flags[@]}" -fsyntax-only -DMISSING_TAP_IRQ "$app/minimal_app.cpp" 2> "$app/missing.log"; then
        echo "FAIL  app generation: a board without the Tap interrupt compiled"; status=1
    elif grep -q "Tap Contract Violation\] the board must define its interrupt" "$app/missing.log"; then
        echo "PASS  app generation: a board without the Tap interrupt fails the application contract, naming the module"
    else
        echo "FAIL  app generation: missing interrupt without the contract message (log: tests/build/app/missing.log)"; status=1
    fi
}

# The vector table built from the interrupt modules (fa_interrupt.hpp): read-only, aligned for VTOR, each
# module's handle() in its slot; invalid modules rejected at compile time with a clear message
vector_table_checks() {
    local obj="$OUT/target_m4-fpu-trace-commands-health.o" sec
    sec=$(arm-none-eabi-objdump -h "$obj" | grep -o '\.rodata\._ZN2Fa6detail11VectorTable[^ ]*' | head -1)
    local info relocs
    info=$(arm-none-eabi-objdump -h "$obj" | grep -A1 -F "$sec ")
    relocs=$(arm-none-eabi-objdump -r -j "$sec" "$obj" | c++filt)
    if [ -n "$sec" ] && echo "$info" | grep -q "READONLY" && echo "$info" | grep -q "000001c4.*2\*\*9" &&
       echo "$relocs" | grep -q "^00000088 .*run_interrupt<AdcIsr" && echo "$relocs" | grep -q "^000000dc .*run_interrupt<CommandRxIsr" &&
       echo "$relocs" | grep -q "^0000002c .*vPortSVCHandler" && echo "$relocs" | grep -q "^00000038 .*xPortPendSVHandler" &&
       echo "$relocs" | grep -q "^00000000 .*_estack" &&
       [ "$(echo "$relocs" | grep -c unexpected_interrupt)" -eq 95 ]; then
        echo "PASS  vector table: in flash (read-only), 113 entries aligned to 512 for VTOR, entry 0 the initial stack (FreeRTOS reads it), ADC and USART3 slots run their modules (through run_interrupt)"
    else
        echo "FAIL  vector table: section, alignment or slots not as expected (object: tests/build/target_m4-fpu-trace-commands-health.o)"
        status=1
    fi
    # FA_NO_VECTOR_TABLE: the vendor's table stays; FA_BIND_ISR defines the handlers by vector name, an
    # unbound module is an undefined reference naming it; no table is built
    local fallback="$OUT/no_vector_table" syms
    mkdir -p "$fallback"
    nvt_compile() {
        arm-none-eabi-g++ -std=c++17 -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard -Os -fno-exceptions -fno-rtti \
            -DFA_NO_VECTOR_TABLE "$@" -I"$ROOT/tests/target" -I"$FREERTOS_KERNEL_PATH/include" \
            -I"$FREERTOS_KERNEL_PATH/portable/GCC/ARM_CM4F" -I"$OUT" -I"$ROOT/tests/fixtures" -I"$ROOT/freeactors_lib" \
            -c "$ROOT/tests/target/target_app.cpp" 2>> "$fallback/build.log"
    }
    if nvt_compile -DFA_TEST_BIND -o "$fallback/bound.o" && nvt_compile -o "$fallback/unbound.o"; then
        syms=$(arm-none-eabi-nm -C "$fallback/bound.o")
        if echo "$syms" | grep -q " T USART3_IRQHandler" && echo "$syms" | grep -q " T ADC_IRQHandler" &&
           ! arm-none-eabi-objdump -h "$fallback/bound.o" | grep -q VectorTable &&
           [ "$(arm-none-eabi-nm -C "$fallback/unbound.o" | grep -c " U .*interrupt_module_bound_by_FA_BIND_ISR")" -eq 2 ]; then
            echo "PASS  FA_NO_VECTOR_TABLE: no table; FA_BIND_ISR defines USART3_IRQHandler and ADC_IRQHandler; unbound modules fail to link, named"
        else
            echo "FAIL  FA_NO_VECTOR_TABLE: bindings or link-time check not as expected (objects: tests/build/no_vector_table/)"; status=1
        fi
    else
        echo "FAIL  FA_NO_VECTOR_TABLE builds do not compile (log: tests/build/no_vector_table/build.log)"; status=1
    fi
    if arm-none-eabi-g++ -std=c++17 -mcpu=cortex-m0 -mthumb -fno-exceptions -fno-rtti -fsyntax-only \
           -I"$ROOT/tests/target" -I"$FREERTOS_KERNEL_PATH/include" -I"$FREERTOS_KERNEL_PATH/portable/GCC/ARM_CM0" \
           -I"$OUT" -I"$ROOT/tests/fixtures" -I"$ROOT/freeactors_lib" "$ROOT/tests/target/target_app.cpp" 2> "$OUT/cortex_m0.log"; then
        echo "FAIL  interrupt modules compiled for a Cortex-M0"; status=1
    elif grep -q "Interrupt modules need a Cortex-M with ARMv7-M or later" "$OUT/cortex_m0.log"; then
        echo "PASS  interrupt modules on a Cortex-M0 rejected: 'Interrupt modules need a Cortex-M with ARMv7-M or later'"
    else
        echo "FAIL  Cortex-M0 build failed without the ARMv7-M message (log: tests/build/cortex_m0.log)"; status=1
    fi

    local flag expected
    for case in "FA_TEST_BAD_PRIORITY|PRI is more urgent than configMAX_SYSCALL_INTERRUPT_PRIORITY" \
                "FA_TEST_DUPLICATE_IRQ|Two interrupt modules use the same IRQNum"; do
        flag="${case%%|*}"; expected="${case#*|}"
        if arm-none-eabi-g++ -std=c++17 -mcpu=cortex-m4 -mthumb -fno-exceptions -fno-rtti -fsyntax-only -D"$flag" \
               -I"$ROOT/tests/target" -I"$FREERTOS_KERNEL_PATH/include" -I"$FREERTOS_KERNEL_PATH/portable/GCC/ARM_CM4F" \
               -I"$OUT" -I"$ROOT/tests/fixtures" -I"$ROOT/freeactors_lib" "$ROOT/tests/target/target_app.cpp" 2> "$OUT/$flag.log"; then
            echo "FAIL  interrupt modules: $flag compiled"; status=1
        elif grep -q "$expected" "$OUT/$flag.log"; then
            echo "PASS  interrupt modules: $flag rejected: '$expected'"
        else
            echo "FAIL  interrupt modules: $flag failed without '$expected' (log: tests/build/$flag.log)"; status=1
        fi
    done
}

# A firmware project from its application alone (tests/fixtures/target, drawn top-down with the board's Target):
# Export Application and Generate Board through the editors' providers, then the generated CMake presets must
# configure, compile and link it as is, for each supported core
target_build_checks() {
    local core dir
    if ! command -v cmake > /dev/null; then echo "SKIP  target build: cmake not found"; return; fi
    for core in cortex-m4f cortex-m3 cortex-m4 cortex-m7 cortex-m33; do
        dir="$OUT/target_$core"
        node "$ROOT/tests/target_build_test.js" "$dir" "$core" || { status=1; continue; }
        if (cd "$dir" && cmake --preset firmware > configure.log 2>&1 && cmake --build --preset firmware > build.log 2>&1); then
            echo "PASS  target build ($core): configures, compiles and links with the generated build and board ($(grep -o 'FLASH: *[0-9]* B' "$dir/build.log" | tr -s ' '))"
        else
            echo "FAIL  target build ($core) (log: tests/build/target_$core/build.log)"; grep -m 5 -E 'error|Error' "$dir/configure.log" "$dir/build.log"; status=1
        fi
    done
}

# The STM32F4 + HAL flavour from an empty folder: Apply flavour, Export Application, Generate Board through the
# providers, then the generated build with ST's startup, system file and HAL. Needs STM32_SDK_PATH: a folder with
# ST's repositories cmsis_core, cmsis_device_f4 and stm32f4xx_hal_driver (github.com/STMicroelectronics)
flavour_checks() {
    local dir="$OUT/flavour"
    if [ -z "${STM32_SDK_PATH:-}" ] || [ ! -d "$STM32_SDK_PATH/stm32f4xx_hal_driver" ]; then
        echo "SKIP  flavour build: set STM32_SDK_PATH to a folder with cmsis_core, cmsis_device_f4, stm32f4xx_hal_driver"; return
    fi
    node "$ROOT/tests/flavour_test.js" "$dir" "$STM32_SDK_PATH" || { status=1; return; }
    if (cd "$dir" && cmake --preset firmware > configure.log 2>&1 && cmake --build --preset firmware > build.log 2>&1); then
        echo "PASS  flavour build (STM32F4 + HAL): configures, compiles and links with ST's files and the generated board ($(grep -o 'FLASH: *[0-9]* B' "$dir/build.log" | tr -s ' '))"
    else
        echo "FAIL  flavour build (log: tests/build/flavour/build.log)"; grep -m 5 -E 'error|Error' "$dir/configure.log" "$dir/build.log"; status=1
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
    target_compile m4-fpu-trace-commands ARM_CM4F -mfpu=fpv4-sp-d16 -mfloat-abi=hard -DFA_TRACE -DFA_TRACE_COMMANDS
    target_compile m4-fpu-trace-commands-health ARM_CM4F -mfpu=fpv4-sp-d16 -mfloat-abi=hard -DFA_TRACE -DFA_TRACE_COMMANDS -DFA_HEALTH -DFA_DEBUG_COMMANDS
    vector_table_checks
    app_generation_checks
    target_build_checks
    flavour_checks
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
    # Commands as the PC tool encodes them; the target runs them after its own command checks
    node "$ROOT/tools/fa-trace.js" --dict "$OUT" --actors Timebomb,Counter \
        --encode "post Timebomb ButtonPressed" \
        --encode "filter transition Timebomb" \
        --encode "post 0 ButtonPressed" \
        --encode "filter all" \
        --encode "post Timebomb 5" \
        --encode "states" > "$dir/commands.bin" || { echo "FAIL  fa-trace --encode"; status=1; }
    for variant in posix_app posix_app_noassert; do
        local flags=()
        [ "$variant" = posix_app_noassert ] && flags=(-DFA_NO_ASSERT)
        flags+=(-DFA_TRACE -DFA_TRACE_COMMANDS -DFA_HEALTH -DFA_DEBUG_COMMANDS)
        if ! g++ -std=c++17 -O1 -pthread -Wall -Wextra "${flags[@]}" "${inc[@]}" "$ROOT/tests/posix/posix_app.cpp" \
                 "${objs[@]}" -o "$dir/$variant" 2>> "$dir/build.log"; then
            echo "FAIL  posix: $variant build (first errors below, full log: tests/build/posix/build.log)"
            grep -m 8 'error' "$dir/build.log"
            status=1
            continue
        fi
        echo "== $variant"
        FA_TRACE_OUT="$dir/$variant.trace" FA_COMMANDS_IN="$dir/commands.bin" timeout 30 "$dir/$variant" > "$dir/$variant.out" 2>&1
        local code=$?
        cat "$dir/$variant.out"
        if [ "$variant" = posix_app ]; then
            # the assertion must be the queue-full one: the line right after the test's announcement
            if [ $code -eq 3 ] && grep -A1 "^INFO  posix: queue full, expecting the queue-full assertion next" "$dir/$variant.out" \
                    | grep -q "^ASSERT .*fa_freertos.hpp" && ! grep -q "^FAIL" "$dir/$variant.out"; then
                echo "PASS  posix: full queue stops at the queue-full assertion when assertions are enabled"
            else
                echo "FAIL  posix: expected every check to pass, then the queue-full assertion (exit 3), got exit $code" \
                     "after: $(grep -v '^PASS' "$dir/$variant.out" | tail -2 | tr '\n' ' ')"
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
    expect_trace "$trace" \
        "PC +\\[POST\\] ButtonPressed -> Timebomb" \
        "Timebomb +\\[EVENT\\] ButtonPressed +\\(from PC, " \
        "ACK #1: ok" \
        "ACK #2: payload size mismatch" \
        "ACK #3: unknown event" \
        "ACK #4: unknown actor" \
        "STATES #5: Timebomb=WAIT, Counter=INNER" \
        "ACK #6: not supported" \
        "ACK #8: ok" \
        "Timebomb +\\[TRANSITION\\] ARMED ===> DISARMED" \
        "ACK #9: ok" \
        "ACK #10: ok" \
        "ACK #11: ok"
    # the fa-trace --encode script: sequence numbers restart at 1 after the target's own checks (#11)
    expect_trace "$trace" \
        "ACK #11: ok" \
        "ACK #1: ok" \
        "ACK #2: ok" \
        "Timebomb +\\[TRANSITION\\] WAIT ===> LEDON" \
        "ACK #3: ok" \
        "ACK #4: ok" \
        "PC +\\[POST\\] ButtonPressed -> Timebomb" \
        "ACK #5: ok" \
        "STATES #6: Timebomb=DISARMED, Counter=INNER"
    local filtered
    filtered=$(sed -n '/ACK #2: ok/,/ACK #4: ok/p' "$trace" | grep -v -e "ACK #" -e "TRANSITION" || true)
    if [ -n "$filtered" ]; then
        echo "FAIL  trace: 'filter transition Timebomb' let other records through:"
        echo "$filtered" | head -3
        status=1
    else
        echo "PASS  trace: 'filter transition Timebomb' passes Timebomb's transitions only"
    fi
    # health monitor (FA_HEALTH): start-up report of the pre-loaded "previous run", then the injected faults
    expect_trace "$trace" \
        "health monitor watches: 0=Timebomb, 1=Counter, 2=Button, 3=SeqSink, 4=UartRx, 5=Worker, 6=FaTrace, 7=FaCmd" \
        "health +\\[RESET\\] started after: watchdog" \
        "health +\\[HEALTH\\] Button no progress for 750 ms with work waiting +\\(previous run"
    expect_trace "$trace" \
        "health +\\[HEALTH\\] Worker stuck: busy 3[0-9][0-9] ms in one step" \
        "health +\\[HEALTH\\] Timebomb no progress for 3[0-9][0-9] ms with work waiting" \
        "health +\\[HEALTH\\] SeqSink idle: no input for 2[0-9][0-9] ms" \
        "HEALTH #12: started after watchdog, up [0-9.]+ s, watchdog no longer fed" \
        "^ +Timebomb +ok +[0-9]+ ms +[0-9]+ words" \
        "^ +SeqSink +IDLE" \
        "^ +Worker +ok +4[0-9][0-9] ms"
    # pause / resume / health test (FA_DEBUG_COMMANDS)
    expect_trace "$trace" \
        "ACK #20: ok" \
        "ACK #21: not allowed" \
        "ACK #22: unknown actor" \
        "HEALTH #23: " \
        "^ +Timebomb +PAUSED" \
        "ACK #24: ok" \
        "ACK #25: ok" \
        "ACK #26: ok"
    expect_trace "$trace" \
        "ACK #13: ok" \
        "health +\\[HEALTH\\] Counter no progress for 3[0-9][0-9] ms with work waiting"
    # interrupt modules: named in the trace, a storm reported
    expect_trace "$trace" \
        "interrupt modules: UartRxIrq \\(IRQ 3\\), SeqIrq \\(IRQ 4\\), TapIrq \\(IRQ 5\\), StormIrq \\(IRQ 6\\)" \
        "TapIrq +\\[POST\\] Go -> Counter" \
        "Counter +\\[EVENT\\] Go +\\(from TapIrq, "
    expect_trace "$trace" "health +\\[HEALTH\\] StormIrq interrupt storm: 11 calls in one tick, interrupt disabled"
    if grep -q "ACK #7" "$trace"; then
        echo "FAIL  trace: the damaged command #7 was answered"
        status=1
    fi
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
