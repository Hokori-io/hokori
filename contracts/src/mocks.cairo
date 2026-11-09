//! Test support only; never deployed. A stand-in for Ekubo Core that accepts an extension's registration (the
//! locker registers in its constructor) and refuses everything else, so tests that never graduate a coin can run
//! without a forked network. Tests that graduate run against the real Core on a fork (tests/test_graduation.cairo).
#[starknet::contract]
pub mod MockEkuboCore {
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use crate::ekubo::CallPoints;

    #[storage]
    struct Storage {
        registered: Map<ContractAddress, bool>,
    }

    #[starknet::interface]
    pub trait IMockEkuboCore<T> {
        fn set_call_points(ref self: T, call_points: CallPoints);
        fn is_registered(self: @T, extension: ContractAddress) -> bool;
        fn lock(ref self: T, data: Span<felt252>) -> Span<felt252>;
    }

    #[abi(embed_v0)]
    impl MockImpl of IMockEkuboCore<ContractState> {
        fn set_call_points(ref self: ContractState, call_points: CallPoints) {
            self.registered.write(get_caller_address(), true);
        }

        fn is_registered(self: @ContractState, extension: ContractAddress) -> bool {
            self.registered.read(extension)
        }

        fn lock(ref self: ContractState, data: Span<felt252>) -> Span<felt252> {
            core::panic_with_felt252('mock core: no Ekubo here')
        }
    }
}

/// Test support only; never deployed. Stands in for the Ekubo locker in tests of the curve on its own: accepts a
/// graduation and keeps what the curve sent it, so tests check the amounts against the reference model.
#[starknet::contract]
pub mod MockGradLocker {
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use crate::ekubo::PoolKey;

    #[storage]
    struct Storage {
        graduations: u32,
    }

    #[abi(embed_v0)]
    impl MockImpl of crate::interfaces::IGradLocker<ContractState> {
        fn graduate(ref self: ContractState, token: ContractAddress, tokens: u256, currency: u256) -> u128 {
            self.graduations.write(self.graduations.read() + 1);
            0
        }

        fn collect_fees(ref self: ContractState, token: ContractAddress) -> (u256, u256) {
            (0, 0)
        }

        fn pool_key(self: @ContractState, token: ContractAddress) -> PoolKey {
            core::panic_with_felt252('mock locker: no pools')
        }

        fn graduated(self: @ContractState, token: ContractAddress) -> bool {
            self.graduations.read() > 0
        }

        fn check_deadline(self: @ContractState, deadline: u64) {}

        fn core(self: @ContractState) -> ContractAddress {
            0.try_into().unwrap()
        }

        fn factory(self: @ContractState) -> ContractAddress {
            0.try_into().unwrap()
        }
    }
}

/// Test support only; never deployed. An outside liquidity provider: locks Ekubo Core and tries to add a position
/// to a pool, as Ekubo's Positions contract would. Hokori pools must refuse it.
#[starknet::contract]
pub mod MockOutsideProvider {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use crate::ekubo::{
        Bounds, ICoreDispatcher, ICoreDispatcherTrait, ILocker, PoolKey, UpdatePositionParameters, i129,
    };

    #[storage]
    struct Storage {
        core: ContractAddress,
    }

    #[starknet::interface]
    pub trait IMockOutsideProvider<T> {
        fn add(ref self: T, core: ContractAddress, pool_key: PoolKey, bounds: Bounds, liquidity: u128);
    }

    #[abi(embed_v0)]
    impl ProviderImpl of IMockOutsideProvider<ContractState> {
        fn add(ref self: ContractState, core: ContractAddress, pool_key: PoolKey, bounds: Bounds, liquidity: u128) {
            self.core.write(core);
            let mut data = array![];
            (pool_key, bounds, liquidity).serialize(ref data);
            ICoreDispatcher { contract_address: core }.lock(data.span());
        }
    }

    #[abi(embed_v0)]
    impl LockerImpl of ILocker<ContractState> {
        fn locked(ref self: ContractState, id: u32, data: Span<felt252>) -> Span<felt252> {
            assert(get_caller_address() == self.core.read(), 'provider: core only');
            let mut data = data;
            let (pool_key, bounds, liquidity): (PoolKey, Bounds, u128) = Serde::deserialize(ref data).unwrap();
            ICoreDispatcher { contract_address: self.core.read() }
                .update_position(
                    pool_key,
                    UpdatePositionParameters { salt: 0, bounds, liquidity_delta: i129 { mag: liquidity, sign: false } },
                );
            array![].span()
        }
    }
}
