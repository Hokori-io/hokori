//! The parts of Ekubo (Starknet's main exchange) that graduation uses, written from the ABI of the deployed Core
//! class (mainnet v5.0.2, Sepolia v4.0.1). None of Ekubo's source is copied: its licence is proprietary. Field
//! order matters, because calls are Serde-encoded.
use starknet::ContractAddress;

/// A signed 129-bit integer: `sign` true means negative.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct i129 {
    pub mag: u128,
    pub sign: bool,
}

/// A pool: token0 is the lower address; `fee` is a 0.128 fixed-point fraction; `extension` is called at the
/// call points it registered.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct PoolKey {
    pub token0: ContractAddress,
    pub token1: ContractAddress,
    pub fee: u128,
    pub tick_spacing: u128,
    pub extension: ContractAddress,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Bounds {
    pub lower: i129,
    pub upper: i129,
}

/// Token amounts from Core's side: positive is owed to Core, negative is owed by Core.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Delta {
    pub amount0: i129,
    pub amount1: i129,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct PoolPrice {
    pub sqrt_ratio: u256,
    pub tick: i129,
}

#[derive(Copy, Drop, Serde, Debug)]
pub struct UpdatePositionParameters {
    pub salt: felt252,
    pub bounds: Bounds,
    pub liquidity_delta: i129,
}

#[derive(Copy, Drop, Serde, Debug)]
pub struct SwapParameters {
    pub amount: i129,
    pub is_token1: bool,
    pub sqrt_ratio_limit: u256,
    pub skip_ahead: u128,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct CallPoints {
    pub before_initialize_pool: bool,
    pub after_initialize_pool: bool,
    pub before_swap: bool,
    pub after_swap: bool,
    pub before_update_position: bool,
    pub after_update_position: bool,
    pub before_collect_fees: bool,
    pub after_collect_fees: bool,
}

#[starknet::interface]
pub trait ICore<T> {
    fn get_pool_price(self: @T, pool_key: PoolKey) -> PoolPrice;
    fn get_pool_liquidity(self: @T, pool_key: PoolKey) -> u128;
    fn get_call_points(self: @T, extension: ContractAddress) -> CallPoints;
    fn lock(ref self: T, data: Span<felt252>) -> Span<felt252>;
    fn withdraw(ref self: T, token_address: ContractAddress, recipient: ContractAddress, amount: u128);
    /// Pulls the caller's whole allowance of `token_address` to Core: approve exactly what is owed first.
    fn pay(ref self: T, token_address: ContractAddress);
    fn initialize_pool(ref self: T, pool_key: PoolKey, initial_tick: i129) -> u256;
    fn maybe_initialize_pool(ref self: T, pool_key: PoolKey, initial_tick: i129) -> Option<u256>;
    fn update_position(ref self: T, pool_key: PoolKey, params: UpdatePositionParameters) -> Delta;
    fn collect_fees(ref self: T, pool_key: PoolKey, salt: felt252, bounds: Bounds) -> Delta;
    fn set_call_points(ref self: T, call_points: CallPoints);
}

/// What Core calls back on whoever called `lock`.
#[starknet::interface]
pub trait ILocker<T> {
    fn locked(ref self: T, id: u32, data: Span<felt252>) -> Span<felt252>;
}

/// What Core calls on a pool's extension, at the call points it registered (never when the extension itself is
/// the caller).
#[starknet::interface]
pub trait IExtension<T> {
    fn before_initialize_pool(ref self: T, caller: ContractAddress, pool_key: PoolKey, initial_tick: i129);
    fn after_initialize_pool(ref self: T, caller: ContractAddress, pool_key: PoolKey, initial_tick: i129);
    fn before_swap(ref self: T, caller: ContractAddress, pool_key: PoolKey, params: SwapParameters);
    fn after_swap(
        ref self: T, caller: ContractAddress, pool_key: PoolKey, params: SwapParameters, delta: Delta,
    );
    fn before_update_position(
        ref self: T, caller: ContractAddress, pool_key: PoolKey, params: UpdatePositionParameters,
    );
    fn after_update_position(
        ref self: T,
        caller: ContractAddress,
        pool_key: PoolKey,
        params: UpdatePositionParameters,
        delta: Delta,
    );
    fn before_collect_fees(
        ref self: T, caller: ContractAddress, pool_key: PoolKey, salt: felt252, bounds: Bounds,
    );
    fn after_collect_fees(
        ref self: T, caller: ContractAddress, pool_key: PoolKey, salt: felt252, bounds: Bounds, delta: Delta,
    );
}

/// Ekubo's MathLib class, declared on mainnet and Sepolia (and so on a devnet forked from either). Library-called:
/// its code runs in the caller's context and none of it is compiled into this package.
pub const MATHLIB_CLASS_HASH: felt252 = 0x037d63129281c4c42cba74218c809ffc9e6f87ca74e0bdabb757a7f236ca59c3;

#[starknet::interface]
pub trait IMathLib<T> {
    fn max_liquidity(
        self: @T, sqrt_ratio: u256, sqrt_ratio_lower: u256, sqrt_ratio_upper: u256, amount0: u128, amount1: u128,
    ) -> u128;
    fn tick_to_sqrt_ratio(self: @T, tick: i129) -> u256;
    fn sqrt_ratio_to_tick(self: @T, sqrt_ratio: u256) -> i129;
}

pub fn mathlib() -> IMathLibLibraryDispatcher {
    IMathLibLibraryDispatcher { class_hash: MATHLIB_CLASS_HASH.try_into().unwrap() }
}

/// Ekubo's Router (V3.0.13, the same class on mainnet and Sepolia): send it the input token, `swap`, then `clear`
/// the output to yourself (or `clear_minimum` to require at least an amount).
#[derive(Copy, Drop, Serde)]
pub struct RouteNode {
    pub pool_key: PoolKey,
    pub sqrt_ratio_limit: u256,
    pub skip_ahead: u128,
}

#[derive(Copy, Drop, Serde)]
pub struct TokenAmount {
    pub token: ContractAddress,
    pub amount: i129,
}

#[starknet::interface]
pub trait IRouter<T> {
    fn swap(ref self: T, node: RouteNode, token_amount: TokenAmount) -> Delta;
    fn clear(self: @T, token: ContractAddress) -> u256;
    fn clear_minimum(self: @T, token: ContractAddress, minimum: u256) -> u256;
}

pub const MIN_SQRT_RATIO: u256 = 18446748437148339061;
pub const MAX_SQRT_RATIO: u256 = 6277100250585753475930931601400621808602321654880405518632;
pub const MAX_TICK_MAGNITUDE: u128 = 88722883;
/// Hokori pools use tick spacing 20000 (the convention for Starknet launch pools; with one full-range position it only
/// sets where others could place liquidity, which the locker refuses anyway).
pub const TICK_SPACING: u128 = 20000;

/// A pool fee equal to a curve fee in basis points, as Ekubo encodes it: floor(fee_bps * 2^128 / 10000), a 0.128
/// fraction (1% gives floor(2^128 / 100), the value routers expect). A trade then pays the same before and after
/// graduation.
pub fn pool_fee_for(fee_bps: u16) -> u128 {
    let fee: u256 = fee_bps.into() * 0x100000000000000000000000000000000_u256 / 10000;
    fee.try_into().unwrap() // fee_bps <= 10000, so it fits
}
