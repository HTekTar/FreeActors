#ifndef FA_SIM_HPP
#define FA_SIM_HPP

#include <iostream>
#include <string>
#include <array>
#include <cstdint>
#include <sstream>
#include <type_traits>

#include "fa_repl.hpp" 

#include "fa_util.hpp"
#include "fa_core.hpp"

namespace Fa {

    // =========================================================================
    //  MetaRegistry
    //  Compile-time static string/ID reflection for Events and Guards
    // =========================================================================

    struct MetaItem {
        uint16_t id;
        const char* name;
    };

    template <typename TypeListType>
    struct MetaRegistry;

    template <typename... Items>
    struct MetaRegistry<TypeList<Items...>> {
        using List = TypeList<Items...>;
        static constexpr size_t count = sizeof...(Items);

        static constexpr std::array<MetaItem, count> items = {{
            { Fa::type_id_v<Items, List>, EventDescriptor<Items>::name }...
        }};

        static constexpr const char* name_of(uint16_t id) {
            for (const auto& item : items) {
                if (item.id == id) return item.name;
            }
            return "Unknown";
        }
    };

    template <typename T>
    struct MetaRegistryGuard;

    template <typename... Guards>
    struct MetaRegistryGuard<TypeList<Guards...>> {
        using List = TypeList<Guards...>;
        static constexpr size_t count = sizeof...(Guards);

        static constexpr std::array<MetaItem, count> items = {{
            { Fa::type_id_v<Guards, List>, GuardDescriptor<Guards>::name }...
        }};
    };

    template <typename StateList>
    struct StateTable;

    template <typename... States>
    struct StateTable<Fa::TypeList<States...>> {
        static constexpr size_t count = sizeof...(States);
        
        static constexpr std::array<const char*, sizeof...(States)> names = {
            Fa::StateDescriptor<States>::name...
        };

        static constexpr const char* get_name(uint16_t state_id) noexcept {
            if (state_id < names.size()) {
                return names[state_id];
            }
            return "UNKNOWN_STATE";
        }
    };

    // =========================================================================
    //  MockMachine
    //  CRTP Base for Host Model Simulation (Zero Hardware Drivers)
    // =========================================================================

    template <typename AppEvents, typename GuardList, typename ActionList>
    class MockMachine;

    template <typename AppEvents, typename... Guards, typename... Actions>
    class MockMachine<AppEvents, TypeList<Guards...>, TypeList<Actions...>> 
        : public Hsm<MockMachine<AppEvents, TypeList<Guards...>, TypeList<Actions...>>, AppEvents> 
    {
    public:
        using Self           = MockMachine<AppEvents, TypeList<Guards...>, TypeList<Actions...>>;
        using EventVariant   = AppEvents;
        using GuardTypeList  = TypeList<Guards...>;
        using ActionTypeList = TypeList<Actions...>;
        using EventTypeList  = variant_to_type_list_t<AppEvents>;

        static constexpr size_t GuardCount  = sizeof...(Guards);
        static constexpr size_t ActionCount = sizeof...(Actions);

    private:
        std::array<bool, GuardCount> guard_states_;

    public:
        MockMachine() {
            if constexpr (GuardCount > 0) {
                // Fold expression guarantees explicit static ID mapping
                ( (guard_states_[Fa::type_id_v<Guards, GuardTypeList>] = false), ... );
            }
        }

        // --- Interoperability with Guard<P>::eval(m) in fa_ops.hpp ---
        template <typename P>
        bool eval_guard() const {
            constexpr uint16_t id = Fa::type_id_v<P, GuardTypeList>;
            return guard_states_[id];
        }

        // --- Toggled directly by SimRunner set_guard_table_ ---
        template <typename P>
        void set_guard(bool value) {
            constexpr uint16_t id = Fa::type_id_v<P, GuardTypeList>;
            guard_states_[id] = value;
        }

        // --- Interoperability with Action<P>::execute(m) in fa_ops.hpp ---
        template <typename P>
        void execute_action() {
            // Simulation default is a clean non-blocking no-op.
            // Tracing is handled inside fa_ops.hpp prior to execution.
        }
    };

    // =========================================================================
    //  SimRunner
    //  Interactive Linenoise REPL and Event Dispatch Engine for Host Simulation
    // =========================================================================

    template <typename MachineType>
    class SimRunner {
    public:
        using AppEvents     = typename MachineType::EventVariant;
        using EventTypeList = typename MachineType::EventTypeList;
        using GuardTypeList = typename MachineType::GuardTypeList;
        using StateTypeList = typename HsmTraits<MachineType>::StateCatalog;

        using PostFn     = void (*)(MachineType&);
        using SetGuardFn = void (*)(MachineType&, bool);

    private:
        template <typename T>
        struct type_tag {
            using type = T;
        };

        MachineType& machine_;
        ReplEngine repl_;

        static inline SimRunner* active_runner_ = nullptr;

        // --- 1. O(1) Event Post Function Table ---
        template <typename EventType>
        static void post_impl(MachineType& m) {
            m.postFromTask(EventType{});
        }

        template <typename... Events>
        static constexpr std::array<PostFn, sizeof...(Events)> make_post_table(TypeList<Events...>) {
            return {{ &post_impl<Events>... }};
        }

        static constexpr auto post_table_ = make_post_table(EventTypeList{});

        // --- 2. O(1) Guard Setter Function Table ---
        template <typename GuardPolicy>
        static void set_guard_impl(MachineType& m, bool value) {
            m.template set_guard<GuardPolicy>(value);
        }

        template <typename... Guards>
        static constexpr std::array<SetGuardFn, sizeof...(Guards)> make_guard_table(TypeList<Guards...>) {
            return {{ &set_guard_impl<Guards>... }};
        }

        static constexpr auto set_guard_table_ = make_guard_table(GuardTypeList{});

        // --- Tab Completion Helpers ---
        template <typename... Events>
        std::vector<std::string> complete_events_impl(const std::string &prefix, TypeList<Events...>) {
            std::vector<std::string> ans;
            auto check_complete = [&](auto tag) {
                using EventType = typename decltype(tag)::type;
                std::string name = EventDescriptor<EventType>::name;
                if (name.rfind(prefix, 0) == 0) {
                    std::string match = "send " + name;
                    ans.push_back(match);
                }
            };

            ( check_complete(type_tag<Events>{}), ... );
            return ans;
        }

        std::vector<std::string> complete_events(const std::string &prefix) {
            return complete_events_impl(prefix, EventTypeList{});
        }

        std::vector<std::string> complete_guards(const std::string &prefix) {
            std::vector<std::string> ans;
            for (const auto& item : MetaRegistryGuard<GuardTypeList>::items) {
                std::string name = item.name;
                if (name.rfind(prefix, 0) == 0) {
                    std::string match = "set " + name + " ";
                    ans.push_back(match);
                }
            }
            return ans;
        }

        static std::vector<std::string> completion_callback(const std::string &input) {
            if (!active_runner_) return std::vector<std::string>{};

            std::vector<std::string> matches;

            if (input.rfind("send ", 0) == 0) {
                return active_runner_->complete_events(input.substr(5).c_str());
            } else if (input.rfind("set ", 0) == 0) {
                return active_runner_->complete_guards(input.substr(4).c_str());
            } else {
                if (std::string("send").rfind(input, 0) == 0) return {"send "};
                if (std::string("set").rfind(input, 0) == 0)  return {"set "};
                if (std::string("help").rfind(input, 0) == 0) return {"help"};
                if (std::string("exit").rfind(input, 0) == 0) return {"exit"};
            }
            return std::vector<std::string>{};
        }

    public:
        explicit SimRunner(MachineType& machine) : machine_(machine) {
            repl_.set_completion_callback(completion_callback);
        }

        void init() {
            machine_.postFromTask(AppEvents{Init_sig{}});
        }

        // --- Fast O(1) Operations ---
        bool post_by_id(uint16_t event_id) {
            if (event_id < post_table_.size()) {
                post_table_[event_id](machine_);
                return true;
            }
            return false;
        }

        bool set_guard_by_id(uint16_t guard_id, bool state) {
            if (guard_id < set_guard_table_.size()) {
                set_guard_table_[guard_id](machine_, state);
                return true;
            }
            return false;
        }

        // --- String Name Lookups at CLI Boundary ---
        bool post_by_name(const std::string& name) {
            for (const auto& item : MetaRegistry<EventTypeList>::items) {
                if (name == item.name) {
                    return post_by_id(item.id);
                }
            }
            return false;
        }

        bool set_guard_by_name(const std::string& name, bool state) {
            for (const auto& item : MetaRegistryGuard<GuardTypeList>::items) {
                if (name == item.name) {
                    return set_guard_by_id(item.id, state);
                }
            }
            return false;
        }

        // --- Interactive Linenoise REPL Loop ---
        void run_repl() {
            active_runner_ = this;

            std::cout << "\n============================================\n";
            std::cout << "  FreeActors Interactive Simulator (REPL)   \n";
            std::cout << "  Press <TAB> for completion & history     \n";
            std::cout << "  Type 'help' for available commands.       \n";
            std::cout << "============================================\n\n";

            init();
            while (true) {
                std::string line = repl_.readline("fa_sim> ");  
                if (line == "quit" || line == "exit") break;
                if (line.empty()) continue;

                std::stringstream ss(line);
                std::string cmd;
                ss >> cmd;

                if (cmd == "help") {
                    std::cout << "  send <EventName>      - Post event onto Active Object queue\n";
                    std::cout << "  set <Guard> <0|1>     - Override mock guard policy state\n";
                    std::cout << "  exit                  - Terminate simulation run\n";
                } 
                else if (cmd == "send") {
                    std::string evt_name;
                    if (ss >> evt_name) {
                        if (!post_by_name(evt_name)) {
                            std::cout << "  \033[1;31mError:\033[0m Unknown event '" << evt_name << "'\n";
                        } 
                    } else {
                        std::cout << "  Usage: send <EventName>\n";
                    }
                } 
                else if (cmd == "set") {
                    std::string guard_name;
                    bool state;
                    if (ss >> guard_name >> state) {
                        if (set_guard_by_name(guard_name, state)) {
                            std::cout << "  Guard '" << guard_name << "' set to " << (state ? "PASS (1)" : "FAIL (0)") << "\n";
                        } else {
                            std::cout << "  \033[1;31mError:\033[0m Unknown guard policy '" << guard_name << "'\n";
                        }
                    } else {
                        std::cout << "  Usage: set <GuardName> <0|1>\n";
                    }
                } 
                else if (cmd == "state") {
                    using Catalog = typename HsmTraits<MachineType>::StateCatalog;
                    uint16_t id = machine_.state_id;
                    const char* name = StateTable<StateTypeList>::get_name(id);
                    
                    std::cout << "\033[1;35m[Machine]\033[0m State: " << name << " (ID: " << id << ")\n";
                }
                else {
                    std::cout << "  Unknown command. Type 'help'.\n";
                }
            }

            active_runner_ = nullptr;
        }
    };

} // namespace Fa

#endif // FA_SIM_HPP