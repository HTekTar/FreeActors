#pragma once
#ifndef FA_COMMON_HPP
#define FA_COMMON_HPP

#include "fa_util.hpp"

namespace Fa{
    struct Enter_sig {};
    struct Exit_sig  {};
    struct Init_sig  {};
    struct ExitToParent_sig {};

    template <typename E>
    struct EventDescriptor;

    template <> struct EventDescriptor<Enter_sig> { static constexpr const char* name = "Enter_sig"; };
    template <> struct EventDescriptor<Exit_sig> { static constexpr const char* name = "Exit_sig"; };
    template <> struct EventDescriptor<Init_sig> { static constexpr const char* name = "Init_sig"; };
    template <> struct EventDescriptor<ExitToParent_sig> { static constexpr const char* name = "ExitToParent_sig"; };

    template<typename M>
    struct HsmTraits;

    template <typename E>
    struct StateDescriptor;

    template <typename E>
    struct GuardDescriptor;

    template <typename E>
    struct ActionDescriptor;
}
#ifdef FA_SIM
#include <string>

namespace Fa{
    template < template <typename> class DescriptorPolicy, typename container>
    struct MetaTable;

    template < template <typename> class DescriptorPolicy, typename... Items>
    struct MetaTable<DescriptorPolicy, TypeList<Items...>> {
        using List = TypeList<Items...>;
        static constexpr size_t count = sizeof...(Items);
        static constexpr uint16_t invalid_id = 0xFFFF;

        static constexpr std::array<const char*, count> names = {
            DescriptorPolicy<Items>::name...
        };

        static constexpr const char* get_name(uint16_t id) noexcept {
            if (id < count) {
                return names[id];
            }
            return "UNKNOWN";
        }

        static uint16_t get_id(std::string const &name) noexcept{
            for(size_t i=0; i < count; ++i){
                if(names[i]==name){
                    return static_cast<uint16_t>(i);
                }
            }
            return invalid_id;
        } 
    };

    template<template <typename> class DescriptorPolicy, typename ...Events>
    struct MetaTable<DescriptorPolicy, std::variant<Events ...>> : MetaTable<DescriptorPolicy, TypeList<Events ...>>{};
}
#endif //FA_SIM

#endif