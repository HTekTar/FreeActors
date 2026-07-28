#ifndef FA_TIMEEVENT
#define FA_TIMEEVENT

#include <cstdint>

enum class MachineId: size_t{
    MaxMachines //last-entry
};

template<typename E>
struct TimeEvent{
    MachineId target_id;
    E payload;
};

template<typename T>struct EventTraits;

template <typename E>
struct TimeEventBuilder{
    template <typename T>
    static constexpr TimeEvent make(T cons & e){
        using Traits = EventTraits<T>;

        typename Traits::SubVariant sub_variant{e};

        return TimeEvent{
            Traits::id,
            E{sub_variant}
        };
    }
};

using TEHandler = void (*) (TimeEvent const &);

template<typename M, typename E, M *inst>
struct Target{
    MachineId id;
    static void callback(TimeEvent const &e){
        auto const &payload = std::get<E>(e.payload);
        M::dispatch(inst, payload);
    }

    constexpr TEHandler = get_handler()const{return &callback;}
};

template<auto ...targets>
struct TEDispatcher{
private:
    static constexpr std::array<TEHandler, static_cast<size_t>(MachineId::MaxMachines)>build_lookup(){
        std::array<TEHandler, static_cast<size_t>(MachineId::MaxMachines)> table{};
        ((table[static_cast<size_t>(targets.id)] = targets.get_handler()), ...);
        return table;
    }
public:
    static constexpr std::array<TEHandler, static_cast<size_t>(MachineId::MaxMachines)> lookup_table = build_lookup();

    static void dispatch(TimeEvent const &event){
        size_t index = static_cast<size_t>(event.target_id);
        if(index < lookup_table.size() && lookup_table[index] != nullptr){
            lookup_table[index](event);
        }
    }
};

#endif