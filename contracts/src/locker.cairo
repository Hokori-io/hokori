/// Graduation into Ekubo (contract v2). One per factory, deployed by the factory. It is both
/// the Ekubo extension named in every Hokori pool key and the holder of every graduated coin's liquidity.
///
/// - Pools: a coin's pool (coin/currency, the factory's trading fee, tick spacing 20000, this extension) can only be created by
///   `graduate`, called by that coin's own curve when its last tokens sell, once. Core never calls an extension's
///   hooks when the extension itself is the caller, and `before_initialize_pool` always refuses, so nobody else can
///   create the pool first at a skewed price.
/// - Liquidity: the curve's reserve goes in as one full-range position owned by this contract. Nothing here can
///   remove it, and `before_update_position` refuses everyone else's positions, so the locked position is the
///   pool's only liquidity.
/// - Fees: anyone can `collect_fees`. The currency side goes to the fee vault, credited to the coin and split like the
///   curve's fees by the vault's protocol share (15% Hokori / 85% payees on mainnet, read 31 Oct; an earlier plan had
///   29% / 71%); the coin side is burned. The liquidity is held in Core directly, not through Ekubo's
///   Positions contract, so Ekubo takes no share of these fees.
/// - Swaps: no hook at all. Ekubo routes through an extension's pools only when it has no swap
///   hooks, so Hokori's pools trade like plain pools in Ekubo's routing and aggregators; the market data reads
///   Ekubo Core's own `Swapped` event, which names the pool (this extension in its key).
/// - No admin, no upgrade, and `set_call_points` is called only in the constructor.
///
/// Prices come from Ekubo's MathLib class (library-called; nothing of Ekubo's is compiled in). Ekubo Core itself
/// can be upgraded by Ekubo's governance; "locked forever" holds as long as Core is not changed against its
/// liquidity providers.
#[starknet::contract]
pub mod GradLocker {
    use core::num::traits::{Sqrt, Zero};
    use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin_security::ReentrancyGuardComponent;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use crate::ekubo::{
        Bounds, CallPoints, Delta, ICoreDispatcher, ICoreDispatcherTrait, IExtension,
        ILocker, IMathLibDispatcherTrait, MAX_TICK_MAGNITUDE, PoolKey, SwapParameters, TICK_SPACING,
        UpdatePositionParameters, i129, mathlib,
    };
    use crate::interfaces::{
        IBurnableDispatcher, IBurnableDispatcherTrait, IFeeVaultDispatcher, IFeeVaultDispatcherTrait,
        IGradLocker, ILaunchFactoryDispatcher, ILaunchFactoryDispatcherTrait,
    };

    component!(
        path: ReentrancyGuardComponent, storage: reentrancy_guard, event: ReentrancyGuardEvent,
    );
    impl ReentrancyGuardInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        reentrancy_guard: ReentrancyGuardComponent::Storage,
        core: ContractAddress,
        currency: ContractAddress,
        fee_vault: ContractAddress,
        factory: ContractAddress,
        pool_fee: u128, // every pool's fee: the curve's fee (ekubo::pool_fee_for), fixed per factory
        graduated: Map<ContractAddress, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        Graduated: Graduated,
        FeesCollected: FeesCollected,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Graduated {
        #[key]
        pub token: ContractAddress,
        pub tokens: u256, // into the pool
        pub currency: u256, // into the pool
        pub liquidity: u128,
        pub sqrt_ratio: u256, // the pool's opening price
        pub burned: u256, // token dust left from rounding the price to a tick, burned
    }

    #[derive(Drop, starknet::Event)]
    pub struct FeesCollected {
        #[key]
        pub token: ContractAddress,
        pub currency: u256, // to the fee vault
        pub burned: u256, // the coin side, burned
    }

    #[derive(Copy, Drop, Serde)]
    struct GraduateData {
        pool_key: PoolKey,
        initial_tick: i129,
        amount0: u128,
        amount1: u128,
    }

    #[derive(Copy, Drop, Serde)]
    enum Callback {
        Graduate: GraduateData,
        Collect: PoolKey,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        core: ContractAddress,
        currency: ContractAddress,
        fee_vault: ContractAddress,
        factory: ContractAddress,
        pool_fee: u128,
    ) {
        self.core.write(core);
        self.pool_fee.write(pool_fee);
        self.currency.write(currency);
        self.fee_vault.write(fee_vault);
        self.factory.write(factory);
        // Registers this contract as an extension, here and nowhere else: pool creation and position changes by
        // anyone but this contract are refused. Swaps never call it (no swap hooks: Ekubo's routing then treats the
        // pools as plain pools).
        ICoreDispatcher { contract_address: core }
            .set_call_points(
                CallPoints {
                    before_initialize_pool: true,
                    after_initialize_pool: false,
                    before_swap: false,
                    after_swap: false,
                    before_update_position: true,
                    after_update_position: false,
                    before_collect_fees: false,
                    after_collect_fees: false,
                },
            );
    }

    fn full_range() -> Bounds {
        let mag = (MAX_TICK_MAGNITUDE / TICK_SPACING) * TICK_SPACING;
        Bounds { lower: i129 { mag, sign: true }, upper: i129 { mag, sign: false } }
    }

    /// tick + 1
    fn next_tick(t: i129) -> i129 {
        if t.sign && t.mag > 0 {
            let mag = t.mag - 1;
            i129 { mag, sign: mag != 0 }
        } else {
            i129 { mag: t.mag + 1, sign: false }
        }
    }

    fn pay(core: ICoreDispatcher, token: ContractAddress, amount: u128) {
        if amount.is_non_zero() {
            // Core pulls the whole allowance: approve exactly what is owed.
            assert(
                IERC20Dispatcher { contract_address: token }.approve(core.contract_address, amount.into()),
                'locker: approve failed',
            );
            core.pay(token);
        }
    }

    fn to_u128(v: u256) -> u128 {
        v.try_into().expect('locker: amount too large')
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _core(self: @ContractState) -> ICoreDispatcher {
            ICoreDispatcher { contract_address: self.core.read() }
        }

        fn _pool_key(self: @ContractState, token: ContractAddress) -> PoolKey {
            let currency = self.currency.read();
            let (token0, token1) = if token < currency {
                (token, currency)
            } else {
                (currency, token)
            };
            PoolKey { token0, token1, fee: self.pool_fee.read(), tick_spacing: TICK_SPACING, extension: get_contract_address() }
        }

        /// The tick the pool opens at: the curve's closing price (currency per token = currency / tokens), rounded
        /// so the pool never opens below it, by at most one tick (about 1e-6). Ekubo's price is token1 per token0.
        fn _initial_tick(self: @ContractState, token: ContractAddress, tokens: u128, currency: u128) -> i129 {
            let token_is_token0 = token < self.currency.read();
            let (num, den) = if token_is_token0 {
                (currency, tokens)
            } else {
                (tokens, currency)
            };
            // price in 128.128 fixed point (num < 2^128, so num * 2^128 fits); sqrt_ratio = sqrt(price) * 2^128.
            // The curve's parameters keep the price within 2^-64..2^64, so the root keeps at least 32 bits.
            let price_x128: u256 = u256 { low: 0, high: num } / den.into();
            let root: u128 = price_x128.sqrt();
            let sqrt_ratio: u256 = root.into() * 0x10000000000000000_u256;
            let m = mathlib();
            let tick = m.sqrt_ratio_to_tick(sqrt_ratio); // the largest tick at or below
            if token_is_token0 && m.tick_to_sqrt_ratio(tick) < sqrt_ratio {
                next_tick(tick) // currency per token is token1 per token0: round up
            } else {
                tick // token per currency is token1 per token0: rounding down raises currency per token
            }
        }

    }

    #[abi(embed_v0)]
    impl GradLockerImpl of IGradLocker<ContractState> {
        fn graduate(ref self: ContractState, token: ContractAddress, tokens: u256, currency: u256) -> u128 {
            self.reentrancy_guard.start();
            let curve = ILaunchFactoryDispatcher { contract_address: self.factory.read() }.curve_of(token);
            assert(curve.is_non_zero() && get_caller_address() == curve, 'locker: only the coin curve');
            assert(!self.graduated.read(token), 'locker: already graduated');
            self.graduated.write(token, true);
            let (x, y) = (to_u128(tokens), to_u128(currency));
            let pool_key = self._pool_key(token);
            let initial_tick = self._initial_tick(token, x, y);
            let (amount0, amount1) = if pool_key.token0 == token {
                (x, y)
            } else {
                (y, x)
            };
            let mut data = array![];
            Callback::Graduate(GraduateData { pool_key, initial_tick, amount0, amount1 }).serialize(ref data);
            let mut out = self._core().lock(data.span());
            let (liquidity, sqrt_ratio, paid0, paid1): (u128, u256, u128, u128) = Serde::deserialize(ref out)
                .expect('locker: bad lock result');
            let (paid_tokens, paid_currency) = if pool_key.token0 == token {
                (paid0, paid1)
            } else {
                (paid1, paid0)
            };
            // What rounding the price to a tick leaves over: the coin is burned; any currency (none in practice)
            // is a fee like any other.
            let burned: u256 = (x - paid_tokens).into();
            if burned > 0 {
                IBurnableDispatcher { contract_address: token }.burn(burned);
            }
            let spare: u256 = (y - paid_currency).into();
            if spare > 0 {
                let vault = self.fee_vault.read();
                assert(
                    IERC20Dispatcher { contract_address: self.currency.read() }.approve(vault, spare),
                    'locker: approve failed',
                );
                IFeeVaultDispatcher { contract_address: vault }.deposit(token, spare);
            }
            self
                .emit(
                    Graduated {
                        token, tokens: paid_tokens.into(), currency: paid_currency.into(), liquidity, sqrt_ratio, burned,
                    },
                );
            self.reentrancy_guard.end();
            liquidity
        }

        fn collect_fees(ref self: ContractState, token: ContractAddress) -> (u256, u256) {
            self.reentrancy_guard.start();
            assert(self.graduated.read(token), 'locker: not graduated');
            let pool_key = self._pool_key(token);
            let mut data = array![];
            Callback::Collect(pool_key).serialize(ref data);
            let mut out = self._core().lock(data.span());
            let (fee0, fee1): (u128, u128) = Serde::deserialize(ref out).expect('locker: bad lock result');
            let (coin_fee, currency_fee): (u256, u256) = if pool_key.token0 == token {
                (fee0.into(), fee1.into())
            } else {
                (fee1.into(), fee0.into())
            };
            if currency_fee > 0 {
                let vault = self.fee_vault.read();
                assert(
                    IERC20Dispatcher { contract_address: self.currency.read() }.approve(vault, currency_fee),
                    'locker: approve failed',
                );
                IFeeVaultDispatcher { contract_address: vault }.deposit(token, currency_fee);
            }
            if coin_fee > 0 {
                IBurnableDispatcher { contract_address: token }.burn(coin_fee);
            }
            self.emit(FeesCollected { token, currency: currency_fee, burned: coin_fee });
            self.reentrancy_guard.end();
            (currency_fee, coin_fee)
        }

        fn pool_key(self: @ContractState, token: ContractAddress) -> PoolKey {
            self._pool_key(token)
        }

        fn graduated(self: @ContractState, token: ContractAddress) -> bool {
            self.graduated.read(token)
        }

        fn check_deadline(self: @ContractState, deadline: u64) {
            assert(get_block_timestamp() <= deadline, 'locker: expired');
        }

        fn core(self: @ContractState) -> ContractAddress {
            self.core.read()
        }

        fn factory(self: @ContractState) -> ContractAddress {
            self.factory.read()
        }
    }

    #[abi(embed_v0)]
    impl LockerImpl of ILocker<ContractState> {
        fn locked(ref self: ContractState, id: u32, data: Span<felt252>) -> Span<felt252> {
            let core = self._core();
            assert(get_caller_address() == core.contract_address, 'locker: core only');
            let mut data = data;
            let callback: Callback = Serde::deserialize(ref data).expect('locker: bad callback');
            let mut out = array![];
            match callback {
                Callback::Graduate(g) => {
                    // This contract is the extension, so Core skips the hooks; initialize_pool (not maybe_) also
                    // refuses a pool that somehow exists already.
                    let sqrt_ratio = core.initialize_pool(g.pool_key, g.initial_tick);
                    let bounds = full_range();
                    let m = mathlib();
                    let liquidity = m
                        .max_liquidity(
                            sqrt_ratio,
                            m.tick_to_sqrt_ratio(bounds.lower),
                            m.tick_to_sqrt_ratio(bounds.upper),
                            g.amount0,
                            g.amount1,
                        );
                    let delta = core
                        .update_position(
                            g.pool_key,
                            UpdatePositionParameters {
                                salt: 0, bounds, liquidity_delta: i129 { mag: liquidity, sign: false },
                            },
                        );
                    assert(!delta.amount0.sign && !delta.amount1.sign, 'locker: delta sign');
                    assert(
                        delta.amount0.mag <= g.amount0 && delta.amount1.mag <= g.amount1, 'locker: delta too large',
                    );
                    pay(core, g.pool_key.token0, delta.amount0.mag);
                    pay(core, g.pool_key.token1, delta.amount1.mag);
                    (liquidity, sqrt_ratio, delta.amount0.mag, delta.amount1.mag).serialize(ref out);
                },
                Callback::Collect(pool_key) => {
                    let delta = core.collect_fees(pool_key, 0, full_range());
                    let me = get_contract_address();
                    if delta.amount0.mag.is_non_zero() {
                        core.withdraw(pool_key.token0, me, delta.amount0.mag);
                    }
                    if delta.amount1.mag.is_non_zero() {
                        core.withdraw(pool_key.token1, me, delta.amount1.mag);
                    }
                    (delta.amount0.mag, delta.amount1.mag).serialize(ref out);
                },
            }
            out.span()
        }
    }

    /// Core calls these for callers other than this contract, and only at the registered call points.
    #[abi(embed_v0)]
    impl ExtensionImpl of IExtension<ContractState> {
        fn before_initialize_pool(
            ref self: ContractState, caller: ContractAddress, pool_key: PoolKey, initial_tick: i129,
        ) {
            core::panic_with_felt252('locker: graduation only');
        }

        fn after_initialize_pool(
            ref self: ContractState, caller: ContractAddress, pool_key: PoolKey, initial_tick: i129,
        ) {
            core::panic_with_felt252('locker: not used');
        }

        fn before_swap(ref self: ContractState, caller: ContractAddress, pool_key: PoolKey, params: SwapParameters) {
            core::panic_with_felt252('locker: not used');
        }

        fn after_swap(
            ref self: ContractState,
            caller: ContractAddress,
            pool_key: PoolKey,
            params: SwapParameters,
            delta: Delta,
        ) {
            core::panic_with_felt252('locker: not used');
        }

        fn before_update_position(
            ref self: ContractState, caller: ContractAddress, pool_key: PoolKey, params: UpdatePositionParameters,
        ) {
            core::panic_with_felt252('locker: locked position only');
        }

        fn after_update_position(
            ref self: ContractState,
            caller: ContractAddress,
            pool_key: PoolKey,
            params: UpdatePositionParameters,
            delta: Delta,
        ) {
            core::panic_with_felt252('locker: not used');
        }

        fn before_collect_fees(
            ref self: ContractState, caller: ContractAddress, pool_key: PoolKey, salt: felt252, bounds: Bounds,
        ) {
            core::panic_with_felt252('locker: not used');
        }

        fn after_collect_fees(
            ref self: ContractState,
            caller: ContractAddress,
            pool_key: PoolKey,
            salt: felt252,
            bounds: Bounds,
            delta: Delta,
        ) {
            core::panic_with_felt252('locker: not used');
        }
    }
}
