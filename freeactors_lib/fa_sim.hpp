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
    struct IndexRange {
        uint16_t start;
        uint16_t count;
    };

    struct TransitionEdge {
        uint16_t from_leaf;
        uint16_t to_state;
        uint16_t signal_id;
    };

    
    // =========================================================================
    //  MockMachine
    //  CRTP Base for Host Model Simulation
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
                ( (guard_states_[Fa::type_id_v<Guards, GuardTypeList>] = false), ... );
            }
        }

        template <typename P>
        bool eval_guard() const {
            constexpr uint16_t id = Fa::type_id_v<P, GuardTypeList>;
            return guard_states_[id];
        }

        template <typename P>
        void set_guard(bool value) {
            constexpr uint16_t id = Fa::type_id_v<P, GuardTypeList>;
            guard_states_[id] = value;
        }

        template <typename P>
        void execute_action() {}
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
        using Traits = HsmTraits<MachineType>;
        using StateTypeList = typename Traits::StateCatalog;

        using PostFn     = void (*)(MachineType&);
        using SetGuardFn = void (*)(MachineType&, bool);

        using EventTable = MetaTable<EventDescriptor, AppEvents>;
        using StateTable = MetaTable<StateDescriptor, StateTypeList>;
        using GuardTable = MetaTable<GuardDescriptor, GuardTypeList>;

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

        template <typename GuardPolicy>
        static void set_guard_impl(MachineType& m, bool value) {
            m.template set_guard<GuardPolicy>(value);
        }

        template <typename... Guards>
        static constexpr std::array<SetGuardFn, sizeof...(Guards)> make_guard_table(TypeList<Guards...>) {
            return {{ &set_guard_impl<Guards>... }};
        }

        static constexpr auto set_guard_table_ = make_guard_table(GuardTypeList{});

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
            for (const auto& g_name : GuardTable::names) {
                std::string name{g_name};
                if (name.rfind(prefix, 0) == 0) {
                    std::string match = "set " + name + " ";
                    ans.push_back(match);
                }
            }
            return ans;
        }

        std::vector<std::string> complete_states(const std::string &prefix){
            std::vector<std::string> ans;
            for(const auto &name: StateTable::names){
                std::string sname(name);
                if(sname.rfind(prefix, 0)==0){
                    std::string match = "reach " + sname + " ";
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
            } else if(input.rfind("reach ", 0)==0){
                return active_runner_ ->complete_states(input.substr(6).c_str());
            }else {
                if (std::string("send").rfind(input, 0) == 0) return {"send "};
                if (std::string("set").rfind(input, 0) == 0)  return {"set "};
                if (std::string("help").rfind(input, 0) == 0) return {"help"};
                if (std::string("exit").rfind(input, 0) == 0) return {"exit"};
            }
            return std::vector<std::string>{};
        }

        std::vector<std::vector<uint16_t>> search(uint16_t start_state_id, uint16_t target_state_id) {
            if (start_state_id >= Traits::StateCount || target_state_id >= Traits::StateCount) {
                return {};
            }
            if (!Traits::is_leaf_state[target_state_id]) {
                std::cout << "[SIM] Error: Target state is composite. Targets must be leaf states.\n";
                return {};
            }
            if (start_state_id == target_state_id) {
                return {};
            }

            std::vector<bool> visited_states(Traits::StateCount, false);
            std::vector<uint16_t> current_path;
            std::vector<std::vector<uint16_t>> routes;

            dfs_search(start_state_id, target_state_id, visited_states, current_path, routes);

            return routes;
        }

        void dfs_search(
            uint16_t current_state,
            uint16_t target_state,
            std::vector<bool>& visited,
            std::vector<uint16_t>& current_path,
            std::vector<std::vector<uint16_t>>& routes
        ) {
            if (current_state == target_state) {
                routes.push_back(current_path);
                return;
            }

            visited[current_state] = true;

            const auto& range = Traits::state_transition_ranges[current_state];
            const uint16_t init_sig_idx = Fa::get_index_v<Fa::Init_sig, AppEvents>;
            const bool current_is_composite = !Traits::is_leaf_state[current_state];

            for (uint16_t i = 0; i < range.count; ++i) {
                uint16_t trans_idx = range.start + i;
                const auto& edge = Traits::transitions[trans_idx];
                uint16_t next_state = edge.to_state;

                if (current_is_composite && edge.signal_id != init_sig_idx) {
                    continue;
                }

                if (!visited[next_state]) {
                    current_path.push_back(trans_idx);

                    dfs_search(next_state, target_state, visited, current_path, routes);

                    current_path.pop_back();
                }
            }

            visited[current_state] = false; 
        }

        void print_path(std::vector<uint16_t> &path){
            std::string path_str, dest;
            for(auto ti: path){
                auto t = HsmTraits<MachineType>::transitions[ti];
                auto g = HsmTraits<MachineType>::transition_guards[ti];
                auto src = std::string(StateTable::names[t.from_leaf]);
                dest = std::string(StateTable::names[t.to_state]);
                auto sig = EventTable::names[t.signal_id];

                std::string guard_str;
                for(size_t i=0; i< g.size(); ++i){
                    if(g[i]==0){
                        guard_str += " !"+std::string(GuardTable::names[i]);
                    }else if(g[i]==1){
                        guard_str += " " + std::string(GuardTable::names[i]);
                    }
                }

                path_str += " \033[1;33m" + src + "\033[0m[\033[1;32m" + sig+ "\033[0m: \033[1;36m" + guard_str + "\033[0m]" + " -> ";
            }
            std::cout<<path_str<<"\033[1;35m"<<dest<<"\033[0m"<<"\n";
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
            auto id = EventTable::get_id(name);
            if(id != EventTable::invalid_id){
                return post_by_id(id);
            }
            return false;
        }

        bool set_guard_by_name(const std::string& name, bool state) {
            auto id = GuardTable::get_id(name);
            if(id != GuardTable::invalid_id){
                return set_guard_by_id(id, state);
            }
            return false;
        }

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
                    const char* name = StateTable::get_name(id);
                    
                    std::cout << "\033[1;35m[Machine]\033[0m State: " << name << " (ID: " << id << ")\n";
                }
                else if(cmd == "reach"){
                    std::string state_name;
                    if(ss >> state_name){
                        auto target_id = StateTable::get_id(state_name);
                        if(target_id != StateTable::invalid_id){
                            auto routes = search(machine_.state_id, target_id);
                            std::cout<<"Found "<<routes.size()<<" paths\n";
                            for(auto &path: routes){
                                print_path(path);
                            }
                        }
                            
                    }
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