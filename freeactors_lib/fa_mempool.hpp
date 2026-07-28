#ifndef MEM_POOL_HPP
#define MEM_POOL_HPP

#include <atomic>

template<typename Mp, typename T>
struct PoolPtr{
    PoolPtr() noexcept: pool(nullptr), ptr(nullptr){}
    PoolPtr(Mp *pool, T *ptr) noexcept: pool(pool), ptr(ptr){}
    PoolPtr(PoolPtr &&other): pool(other.pool), ptr(other.ptr){
        other.pool = nullptr;
        other.ptr = nullptr;
    }
    ~PoolPtr(){
        if(pool && ptr){
            ptr->~T();
            pool->free(ptr);
        }
    }

    PoolPtr(PoolPtr const &) = delete;
    PoolPtr& operator=(PoolPtr const &) = delete;

    PoolPtr& operator=(PoolPtr&& other)noexcept{
        if(this != &other){
            reset();
            ptr = other.ptr;
            pool = other.pool;
            other.ptr = nullptr;
            other.pool = nullptr;
        }
        return *this;
    }

    T& operator*()const{return ptr;}
    T* operator->()const{return ptr;}
    explicit operator bool()const{return ptr != nullptr;}
private:
    void reset(){
        if(pool && ptr){
            pool->free(ptr);
            ptr->~T();
        }
    }

    Mp *pool;
    T* ptr;
};

template<typename T, uint32_t sz>
struct MemPool{
    MemPool(){
        for(size_t i=0; i<sz-1; ++i){
            blocks[i].next = &blocks[i+1];
               
        }
        blocks[sz-1].next = nullptr;
        head.store(TaggedPtr{&blocks[0]}, std::memory_order_relaxed);
    }

    T* allocate(){
        TaggedPtr old_head = head.load(std::memory_order_acquire);

        while(old_head.node && !head.compare_exchange_weak(
                                    old_head, 
                                    TaggedPtr{old_head.node->next, old_head.ctr + 1}, 
                                    std::memory_order_release, 
                                    std::memory_order_acquire));
        if(!old_head.node){
            return nullptr;
        }
        return reinterpret_cast<T*>(old_head.node->storage);
    }

    void free(T *block){
        if(!block)return;

        TaggedPtr current = head.load(std::memory_order_acquire);
        Node *newNode = reinterpret_cast<Node*>(block);
        
        do{
            newNode->next = current.node;
        }while(!head.compare_exchange_weak(
                current, 
                TaggedPtr{newNode, current->ctr+1}, 
                std::memory_order_release, 
                std::memory_order_acquire));
    }

    template<typename ...Args>
    PoolPtr<MemPool<T,sz>, T> make(Args&& ...args){
        T* raw_ptr = allocate();
        if(!raw_ptr){
            return PoolPtr<MemPool<T,sz>, T>(this, nullptr);
        }
        ::new(static_cast<void*>(raw_ptr)) T(std::forward<Args>(args)...);
        return PoolPtr<MemPool<T,sz>,T>(this, raw_ptr);
    }

private:
    union Node{
        Node* next;
        alignas(T) uint8_t storage[sizeof(T)];
    };
                            
    struct alignas(8) TaggedPtr{
        Node* node;
        uint32_t ctr;

        TaggedPtr() noexcept : node(nullptr), ctr(0){}
        TaggedPtr(Node* pNode, uint32_t n) noexcept : node(pNode), ctr(n){}
    };

    std::atomic<TaggedPtr> head;
    std::array<Node, sz> blocks;
};


#endif