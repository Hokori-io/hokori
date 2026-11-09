//! Public interfaces and the plain data they return. "Currency" is the token people pay with (STRK on
//! Starknet); "token" is the launched coin.

use starknet::{ClassHash, ContractAddress};
use crate::ekubo::PoolKey;

/// A buy on the bonding curve, as it would execute now.
#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct CurveBuy {
    pub out: u256, // tokens received
    pub spent: u256, // currency taken (a last buy at the cap takes less than offered)
    pub refund: u256, // offered minus spent (never pulled, so nothing to return)
    pub fee: u256, // part of `spent` that goes to the fee vault
    pub net: u256, // part of `spent` added to the curve's reserve
    pub new_q: u256,
    pub new_t: u256,
}

/// A sell on the bonding curve, as it would execute now.
#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct CurveSell {
    pub gross: u256, // currency leaving the reserve
    pub fee: u256, // part of `gross` that goes to the fee vault
    pub paid: u256, // part of `gross` the seller receives
    pub new_q: u256,
    pub new_t: u256,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct CurveState {
    pub q: u256, // virtual currency reserve
    pub t: u256, // virtual token reserve
    pub sold: u256, // tokens out of the curve, net
    pub real: u256, // currency held for redemptions (excludes fees)
    pub fees: u256, // fees not yet sent to the vault
    pub open: bool,
    pub graduated: bool,
    pub locker: ContractAddress, // where graduation sends the reserve: the factory's Ekubo locker
}

/// Locked at creation; see PROTOCOL-SPEC §3.
#[derive(Copy, Drop, Serde, starknet::Store, Debug, PartialEq)]
pub struct CurveParams {
    pub v0: u256, // virtual currency at launch: pricing only, never withdrawable
    pub t0: u256, // virtual tokens at launch; must exceed curve_tokens
    pub curve_tokens: u256, // tokens the curve sells
    pub x_reserve: u256, // tokens set aside for the pool; any not needed are burned at graduation
    pub min_trade: u256, // smallest currency amount accepted
    pub fee_bps: u16, // trading fee, both directions, on the currency side
    pub grad_fee_bps: u16, // fee on the reserve at graduation
    pub sniper_fee_bps: u16, // fee on buys in the launch window, instead of fee_bps (not on the creator's dev buy)
    pub sniper_blocks: u64 // the launch window: the launch block and the next sniper_blocks - 1 (0: none)
}

#[starknet::interface]
pub trait IBondingCurve<TState> {
    /// A buy as it would execute now, by anyone but the factory (so with the launch-window fee, inside it).
    fn quote_buy(self: @TState, gross: u256) -> CurveBuy;
    fn quote_sell(self: @TState, tokens: u256) -> CurveSell;
    /// Never graduates: a buy that takes the last curve tokens just closes the curve (see `graduate`).
    fn buy(ref self: TState, gross: u256, min_out: u256, deadline: u64) -> CurveBuy;
    /// The last buy: it must take the curve's last tokens (else it reverts, "curve: not the last buy"), and it
    /// graduates the coin in the same call. So its fee estimate always includes the graduation.
    fn buy_and_graduate(ref self: TState, gross: u256, min_out: u256, deadline: u64) -> CurveBuy;
    fn sell(ref self: TState, tokens: u256, min_paid: u256, deadline: u64) -> CurveSell;
    /// Graduates a closed curve (anyone may call; Hokori's graduation service does within seconds): sends the
    /// reserve to the factory's Ekubo locker, which opens the coin's pool at the curve's final price with liquidity
    /// locked forever. Returns the locker.
    fn graduate(ref self: TState) -> ContractAddress;
    /// Anyone: sends accrued fees to the fee vault.
    fn flush_fees(ref self: TState) -> u256;
    fn state(self: @TState) -> CurveState;
    fn params(self: @TState) -> CurveParams;
    fn token(self: @TState) -> ContractAddress;
    fn currency(self: @TState) -> ContractAddress;
    /// The block the curve was created in: the launch's block.
    fn launch_block(self: @TState) -> u64;
    /// The fee a buy pays now (anyone but the factory): sniper_fee_bps inside the launch window, else fee_bps.
    fn buy_fee_bps(self: @TState) -> u16;
}

/// The factory's Ekubo locker (contract v2): the extension of every Hokori pool and the holder of its liquidity.
#[starknet::interface]
pub trait IGradLocker<TState> {
    /// By `token`'s own curve only, once, after sending this contract `tokens` and `currency`: creates the coin's
    /// Ekubo pool at the curve's closing price and adds them as one full-range position that nothing can remove.
    /// The token dust from rounding the price to a tick is burned. Returns the position's liquidity.
    fn graduate(ref self: TState, token: ContractAddress, tokens: u256, currency: u256) -> u128;
    /// Anyone: collects the locked position's trading fees: the currency side to the fee vault (credited to the
    /// coin), the coin side burned. Returns (currency, burned).
    fn collect_fees(ref self: TState, token: ContractAddress) -> (u256, u256);
    /// The coin's pool on Ekubo (whether or not it exists yet).
    fn pool_key(self: @TState, token: ContractAddress) -> PoolKey;
    fn graduated(self: @TState, token: ContractAddress) -> bool;
    /// Refuses once the block timestamp is past `deadline`. Ekubo's Router has no deadline, so the site sends this
    /// first in every pool trade's multicall: a trade that reaches the chain late reverts whole.
    fn check_deadline(self: @TState, deadline: u64);
    fn core(self: @TState) -> ContractAddress;
    fn factory(self: @TState) -> ContractAddress;
}

#[starknet::interface]
pub trait IFeeVault<TState> {
    /// Once per coin, by the registrar (the launch factory): up to 10 payees whose shares sum to 10,000.
    fn register(
        ref self: TState, coin: ContractAddress, payees: Array<ContractAddress>, shares_bps: Array<u16>,
    );
    /// Pulls `amount` of currency from the caller and credits the coin's protocol share and payees.
    fn deposit(ref self: TState, coin: ContractAddress, amount: u256);
    /// Sends the caller everything credited to them for `coin` (balances are kept per coin, so every payout
    /// is attributable to the coin that earned it).
    fn claim(ref self: TState, coin: ContractAddress) -> u256;
    fn balance_of(self: @TState, coin: ContractAddress, account: ContractAddress) -> u256;
    fn protocol(self: @TState) -> ContractAddress;
    /// The protocol's share of every deposit, in basis points (fixed at creation, at most 5,000).
    fn protocol_bps(self: @TState) -> u16;
    fn payee_count(self: @TState, coin: ContractAddress) -> u32;
    fn payee_at(self: @TState, coin: ContractAddress, index: u32) -> (ContractAddress, u16);
}

/// The launched coin: a fixed-supply ERC-20 whose holders can burn their own tokens.
#[starknet::interface]
pub trait IBurnable<TState> {
    fn burn(ref self: TState, amount: u256);
}

/// One launch, as the factory records it.
#[derive(Copy, Drop, Serde, starknet::Store, Debug, PartialEq)]
pub struct Launch {
    pub token: ContractAddress,
    pub curve: ContractAddress,
    pub creator: ContractAddress,
    pub dev_tokens: u256, // tokens the creator's dev buy received in the launch transaction (0 if none)
    pub metadata_sha256: u256, // SHA-256 of the exact metadata bytes; consumers check downloads against it
}

#[starknet::interface]
pub trait ILaunchFactory<TState> {
    /// Creates a coin and its curve in one transaction: deploys the token (whole supply to the curve), registers
    /// the payees, and, if `dev_buy` > 0, makes the creator's first buy before anyone else can trade. The
    /// creator must have approved the factory for `dev_buy` of currency (ideally exactly that, in the same
    /// transaction: the factory can't reset an approval the creator gave it).
    ///
    /// Metadata is committed by content: `metadata_sha256` is the SHA-256 of the exact metadata bytes, and
    /// `metadata_uri` is content-addressed: `ar://` + a canonical 43-character Arweave id, or `ipfs://` + a raw
    /// CIDv1 ("bafkrei…", sha2-256) whose digest must equal `metadata_sha256`.
    /// Indexers and the site must check what any gateway returns against that hash and show nothing on a
    /// mismatch.
    ///
    /// `deadline` (block timestamp): a launch that reaches the chain later is refused, so a launch request that was
    /// never answered or was lost can be known to have failed once it passes.
    fn launch(
        ref self: TState,
        name: ByteArray,
        symbol: ByteArray,
        metadata_uri: ByteArray,
        metadata_sha256: u256,
        payees: Array<ContractAddress>,
        shares_bps: Array<u16>,
        dev_buy: u256,
        min_dev_tokens: u256,
        salt: felt252,
        deadline: u64,
    ) -> Launch;
    /// The coin's address ending this factory requires: the last `digits` hex digits must equal `suffix` (0 digits:
    /// no requirement). Creators search for a `salt` that gives such an address (`token_address_for`).
    fn address_rule(self: @TState) -> (felt252, u8);
    /// Where `creator`'s coin with this name, ticker and salt would be deployed. The salt is mixed with the
    /// creator's address, so nobody else can take a creator's address by copying their salt.
    fn token_address_for(
        self: @TState, creator: ContractAddress, salt: felt252, name: ByteArray, symbol: ByteArray,
    ) -> ContractAddress;
    fn token_class(self: @TState) -> ClassHash;
    /// What a launch costs in currency, paid by the creator to the protocol (Hokori: nothing, owner 15 Oct; fixed per
    /// factory). Approve the factory for `launch_fee() + dev_buy`.
    fn launch_fee(self: @TState) -> u256;
    /// Who receives launch fees and the protocol's share of trading fees.
    fn protocol(self: @TState) -> ContractAddress;
    /// The most a launch's dev buy may take, in tokens (a share of the supply fixed per factory; Hokori 9.99%).
    /// A launch whose dev buy would take more reverts.
    fn max_dev_tokens(self: @TState) -> u256;
    fn launch_count(self: @TState) -> u64;
    fn launch_at(self: @TState, index: u64) -> Launch;
    fn launch_of(self: @TState, token: ContractAddress) -> Launch;
    /// The curve of a coin this factory created (set as soon as the curve exists, inside the launch); zero for any
    /// other address. The locker checks graduation calls against it.
    fn curve_of(self: @TState, token: ContractAddress) -> ContractAddress;
    /// The factory's Ekubo locker: every coin of this factory graduates into it.
    fn locker(self: @TState) -> ContractAddress;
    fn metadata_uri(self: @TState, token: ContractAddress) -> ByteArray;
    fn curve_params(self: @TState) -> CurveParams;
    /// Tokens per coin: the curve's tokens plus the pool reserve.
    fn supply(self: @TState) -> u256;
    fn fee_vault(self: @TState) -> ContractAddress;
    fn currency(self: @TState) -> ContractAddress;
}

