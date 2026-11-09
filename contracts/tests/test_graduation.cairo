//! Contract v2, graduation into Ekubo, against the real Ekubo Core, Router and MathLib on forks of Sepolia and
//! mainnet at pinned blocks (Scarb.toml). A factory is deployed on the fork with its own stand-in currency; a coin
//! sells out its curve and its last buy (`buy_and_graduate`) opens the coin's Ekubo pool through the factory's
//! locker; a plain last buy only closes the curve, and anyone then graduates it.
//! Covered: the opening price and locked liquidity (both token orders), nobody else creating the pool or adding
//! liquidity, the locker's gates, no swap hooks (so Ekubo routes the pools as plain ones), trades through Ekubo's
//! Router reported by Core's own Swapped event, fee collection (currency to the vault, the coin side burned;
//! Sepolia's Core keeps 20%, mainnet's none), a dev buy that graduates inside the launch, and the whole life cycle
//! through payees' claims.
use launchpad::ekubo::{
    Bounds, ICoreDispatcher, ICoreDispatcherTrait, ICoreSafeDispatcher, ICoreSafeDispatcherTrait,
    IExtensionSafeDispatcher, IExtensionSafeDispatcherTrait, IRouterDispatcher, IRouterDispatcherTrait,
    MAX_SQRT_RATIO, MIN_SQRT_RATIO, PoolKey, RouteNode, SwapParameters, TokenAmount, i129,
};
use launchpad::interfaces::{
    IBondingCurveDispatcher, IBondingCurveDispatcherTrait, IFeeVaultDispatcherTrait, IGradLockerDispatcher,
    IGradLockerDispatcherTrait, IGradLockerSafeDispatcher, IGradLockerSafeDispatcherTrait,
    ILaunchFactoryDispatcherTrait, Launch,
};
use launchpad::math::{graduation_seed, mul_div, product_ge};
use launchpad::mocks::MockOutsideProvider::{
    IMockOutsideProviderSafeDispatcher, IMockOutsideProviderSafeDispatcherTrait,
};
use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, EventSpyTrait, EventsFilterTrait, cheat_caller_address,
    declare, spy_events, start_cheat_account_contract_address_global, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use crate::common::*;

const SEPOLIA_CORE: felt252 = 0x0444a09d96389aa7148f1aada508e30b71299ffe650d9c97fdaae38cb9a23384;
const SEPOLIA_ROUTER: felt252 = 0x0045f933adf0607292468ad1c1dedaa74d5ad166392590e72676a34d01d7b763;
pub(crate) const MAINNET_CORE: felt252 = 0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b;
pub(crate) const MAINNET_ROUTER: felt252 = 0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e;
const TWO_128: u256 = 0x100000000000000000000000000000000;

#[derive(Copy, Drop)]
pub(crate) struct Graduated {
    pub(crate) s: FactorySetup,
    pub(crate) launch: Launch,
    pub(crate) locker: IGradLockerDispatcher,
    pub(crate) core: ICoreDispatcher,
    pub(crate) router: IRouterDispatcher,
    pub(crate) key: PoolKey,
    pub(crate) token: IERC20Dispatcher,
}

/// A factory on the fork against `core`, and a launch whose coin sits below or above the currency's address
/// (Ekubo orders a pool's tokens by address), after its launch window.
fn launched(core: felt252, router: felt252, coin_below_currency: bool, dev_buy: u256) -> Graduated {
    launched_in(setup_factory_on(addr(core), 2900), core, router, coin_below_currency, dev_buy)
}

pub(crate) fn launched_in(s: FactorySetup, core: felt252, router: felt252, coin_below_currency: bool, dev_buy: u256) -> Graduated {
    let factory = s.factory;
    let currency = s.currency.contract_address;
    let mut salt: felt252 = 0;
    while (factory.token_address_for(alice(), salt, "Quantum Cat", "QCAT") < currency) != coin_below_currency {
        salt += 1;
    }
    start_cheat_caller_address(factory.contract_address, alice());
    let launch = factory
        .launch(
            "Quantum Cat",
            "QCAT",
            meta_uri(),
            META_SHA256,
            array![payee(), bob()],
            array![7_000, 3_000],
            dev_buy,
            0,
            salt,
            FAR,
        );
    stop_cheat_caller_address(factory.contract_address);
    past_launch_window(@s, @launch);
    let locker = IGradLockerDispatcher { contract_address: factory.locker() };
    Graduated {
        s,
        launch,
        locker,
        core: ICoreDispatcher { contract_address: addr(core) },
        router: IRouterDispatcher { contract_address: addr(router) },
        key: locker.pool_key(launch.token),
        token: IERC20Dispatcher { contract_address: launch.token },
    }
}

/// Carol's buy far beyond what the curve has left: it takes the last tokens and graduates in the same call.
fn sell_out(g: @Graduated) {
    approve_as((*g.s).currency, carol(), (*g.launch).curve);
    start_cheat_caller_address((*g.launch).curve, carol());
    IBondingCurveDispatcher { contract_address: (*g.launch).curve }.buy_and_graduate(200 * ONE, 0, FAR);
    stop_cheat_caller_address((*g.launch).curve);
}

fn graduated(core: felt252, router: felt252, coin_below_currency: bool) -> Graduated {
    let g = launched(core, router, coin_below_currency, 2 * ONE);
    sell_out(@g);
    g
}

/// The price limit for selling `token` into the pool (selling token1 raises token1 per token0).
fn limit_selling(key: @PoolKey, token: ContractAddress) -> u256 {
    if *key.token1 == token {
        MAX_SQRT_RATIO
    } else {
        MIN_SQRT_RATIO
    }
}

/// `who` sells `amount` of `input` for the other token through Ekubo's Router; returns what they received.
pub(crate) fn router_trade(g: @Graduated, who: ContractAddress, input: IERC20Dispatcher, amount: u256) -> u256 {
    let router = *g.router;
    let output = if input.contract_address == (*g.token).contract_address {
        (*g.s).currency.contract_address
    } else {
        (*g.token).contract_address
    };
    transfer_as(input, who, router.contract_address, amount);
    // Only the next call is cheated: Core's callback into the Router must still come from Core.
    cheat_caller_address(router.contract_address, who, CheatSpan::TargetCalls(1));
    router
        .swap(
            RouteNode {
                pool_key: *g.key, sqrt_ratio_limit: limit_selling(g.key, input.contract_address), skip_ahead: 0,
            },
            TokenAmount {
                token: input.contract_address, amount: i129 { mag: amount.try_into().unwrap(), sign: false },
            },
        );
    cheat_caller_address(router.contract_address, who, CheatSpan::TargetCalls(1));
    router.clear(output)
}

/// The pool's price, checked against the curve's closing state: currency per token never below y / x, and at most
/// about one tick (1e-6) above it.
pub(crate) fn check_opening_price(g: @Graduated) {
    let seed = graduation_seed(@(*g.s).factory.curve_params());
    let sqrt_ratio = (*g.core).get_pool_price(*g.key).sqrt_ratio;
    let p = mul_div(sqrt_ratio, sqrt_ratio, TWO_128); // token1 per token0, in 128.128
    if *g.key.token0 == (*g.token).contract_address {
        // p is currency per token: p >= y / x, and p <= (y / x)(1 + 2e-6).
        assert!(product_ge(p, seed.x, seed.y, TWO_128), "the pool opened below the curve's price");
        assert!(product_ge(seed.y * 1_000_002, TWO_128, p * 1_000_000, seed.x), "the pool opened too high");
    } else {
        // p is tokens per currency: x / y >= p, and p >= (x / y)(1 - 2e-6).
        assert!(product_ge(seed.x, TWO_128, p, seed.y), "the pool opened below the curve's price");
        assert!(product_ge(p * 1_000_000, seed.y, seed.x * 999_998, TWO_128), "the pool opened too high");
    }
}

fn full_range() -> Bounds {
    let mag = 88720000;
    Bounds { lower: i129 { mag, sign: true }, upper: i129 { mag, sign: false } }
}

fn has(err: Span<felt252>, what: felt252) -> bool {
    for e in err {
        if *e == what {
            return true;
        }
    }
    false
}

// --- The pool opens at the curve's price, with liquidity nobody can take -------------------------------------

fn opens_at_the_curves_price_with_locked_liquidity(core: felt252, router: felt252, coin_below_currency: bool) {
    let g = graduated(core, router, coin_below_currency);
    let st = IBondingCurveDispatcher { contract_address: g.launch.curve }.state();
    assert!(st.graduated && !st.open);
    assert!(g.locker.graduated(g.launch.token));
    check_opening_price(@g);
    assert!(g.core.get_pool_liquidity(g.key) > 0);
    // The locker keeps nothing loose: the reserve is in the pool and the rounding dust was burned.
    assert_eq!(g.token.balance_of(g.locker.contract_address), 0);
    assert_eq!(g.s.currency.balance_of(g.locker.contract_address), 0);
    // Registered call points: pool creation and outside positions refused; no swap hooks at all.
    let cp = g.core.get_call_points(g.locker.contract_address);
    assert!(cp.before_initialize_pool && cp.before_update_position);
    assert!(!cp.after_initialize_pool && !cp.before_swap && !cp.after_swap && !cp.after_update_position);
    assert!(!cp.before_collect_fees && !cp.after_collect_fees);
    // Ekubo's indexer marks an extension routable when (call_points & 96) == 0, with before_swap 64 and after_swap 32
    // (EkuboProtocol/indexer, migrations/00129 and src/starknet/core.ts). This one encodes as 1 + 16 = 17.
    let encoded: u32 = (if cp.before_initialize_pool { 1 } else { 0 }) + (if cp.after_initialize_pool { 128 } else { 0 })
        + (if cp.before_swap { 64 } else { 0 }) + (if cp.after_swap { 32 } else { 0 })
        + (if cp.before_update_position { 16 } else { 0 }) + (if cp.after_update_position { 8 } else { 0 })
        + (if cp.before_collect_fees { 4 } else { 0 }) + (if cp.after_collect_fees { 2 } else { 0 });
    assert_eq!(encoded, 17);
    assert_eq!(encoded & 96, 0);
}

/// A plain last buy, as when others bought first: the curve closes without graduating, and anyone (Hokori's
/// graduation service, in practice) then opens the pool exactly as the atomic path does.
fn a_plain_last_buy_then_anyone_graduates(core: felt252, router: felt252, coin_below_currency: bool) {
    let g = launched(core, router, coin_below_currency, 2 * ONE);
    let curve = IBondingCurveDispatcher { contract_address: g.launch.curve };
    approve_as(g.s.currency, carol(), g.launch.curve);
    start_cheat_caller_address(g.launch.curve, carol());
    curve.buy(200 * ONE, 0, FAR);
    stop_cheat_caller_address(g.launch.curve);
    let st = curve.state();
    assert!(!st.open && !st.graduated, "closed, waiting");
    assert!(!g.locker.graduated(g.launch.token));
    start_cheat_caller_address(g.launch.curve, bob());
    curve.graduate();
    stop_cheat_caller_address(g.launch.curve);
    assert!(curve.state().graduated);
    assert!(g.locker.graduated(g.launch.token));
    check_opening_price(@g);
    assert!(g.core.get_pool_liquidity(g.key) > 0);
}

#[test]
#[fork("SEPOLIA")]
fn sepolia_a_plain_last_buy_then_anyone_graduates() {
    a_plain_last_buy_then_anyone_graduates(SEPOLIA_CORE, SEPOLIA_ROUTER, true);
}

#[test]
#[fork("MAINNET")]
fn mainnet_a_plain_last_buy_then_anyone_graduates() {
    a_plain_last_buy_then_anyone_graduates(MAINNET_CORE, MAINNET_ROUTER, false);
}

#[test]
#[fork("SEPOLIA")]
fn sepolia_coin_below_the_currency_opens_at_the_curves_price() {
    opens_at_the_curves_price_with_locked_liquidity(SEPOLIA_CORE, SEPOLIA_ROUTER, true);
}

#[test]
#[fork("SEPOLIA")]
fn sepolia_coin_above_the_currency_opens_at_the_curves_price() {
    opens_at_the_curves_price_with_locked_liquidity(SEPOLIA_CORE, SEPOLIA_ROUTER, false);
}

#[test]
#[fork("MAINNET")]
fn mainnet_graduation_opens_at_the_curves_price() {
    opens_at_the_curves_price_with_locked_liquidity(MAINNET_CORE, MAINNET_ROUTER, true);
}

#[test]
#[fork("SEPOLIA")]
fn a_dev_buy_that_sells_out_the_curve_graduates_inside_the_launch() {
    let g = launched(SEPOLIA_CORE, SEPOLIA_ROUTER, true, 200 * ONE);
    assert!(IBondingCurveDispatcher { contract_address: g.launch.curve }.state().graduated);
    assert_eq!(g.launch.dev_tokens, g.s.factory.curve_params().curve_tokens);
    check_opening_price(@g);
    // The creator paid only what the curve cost; the rest of the offer never left them.
    assert_eq!(g.s.currency.balance_of(g.s.factory.contract_address), 0);
}

// --- Nobody else can create the pool, add liquidity, or graduate a coin ---------------------------------------

#[test]
#[fork("SEPOLIA")]
#[feature("safe_dispatcher")]
fn nobody_else_can_create_a_hokori_pool_first() {
    let g = launched(SEPOLIA_CORE, SEPOLIA_ROUTER, true, 0);
    let core = ICoreSafeDispatcher { contract_address: g.core.contract_address };
    // At a skewed price, before graduation: refused by the extension, whichever way it's asked.
    match core.initialize_pool(g.key, i129 { mag: 1_000, sign: false }) {
        Result::Ok(_) => panic!("someone else created a Hokori pool"),
        Result::Err(err) => assert!(has(err.span(), 'locker: graduation only')),
    }
    match core.maybe_initialize_pool(g.key, i129 { mag: 5, sign: true }) {
        Result::Ok(_) => panic!("someone else created a Hokori pool"),
        Result::Err(err) => assert!(has(err.span(), 'locker: graduation only')),
    }
    // Graduation still opens it at the curve's price.
    sell_out(@g);
    check_opening_price(@g);
}

#[test]
#[fork("SEPOLIA")]
#[feature("safe_dispatcher")]
fn nobody_else_can_add_liquidity_to_a_hokori_pool() {
    let g = graduated(SEPOLIA_CORE, SEPOLIA_ROUTER, true);
    let (address, _) = declare("MockOutsideProvider").unwrap().contract_class().deploy(@array![]).unwrap();
    let provider = IMockOutsideProviderSafeDispatcher { contract_address: address };
    let narrow = Bounds { lower: i129 { mag: 20_000, sign: true }, upper: i129 { mag: 20_000, sign: false } };
    for bounds in array![full_range(), narrow] {
        match provider.add(g.core.contract_address, g.key, bounds, 1_000_000) {
            Result::Ok(_) => panic!("an outside position was added"),
            Result::Err(err) => assert!(has(err.span(), 'locker: locked position only')),
        }
    }
}

#[test]
#[fork("SEPOLIA")]
#[feature("safe_dispatcher")]
fn only_the_coins_own_curve_graduates_it_and_only_once() {
    let g = launched(SEPOLIA_CORE, SEPOLIA_ROUTER, true, 0);
    let locker = IGradLockerSafeDispatcher { contract_address: g.locker.contract_address };
    // Anyone else, even with the right amounts in hand, is refused.
    start_cheat_caller_address(locker.contract_address, carol());
    match locker.graduate(g.launch.token, ONE, ONE) {
        Result::Ok(_) => panic!("someone else graduated a coin"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: only the coin curve'),
    }
    stop_cheat_caller_address(locker.contract_address);
    sell_out(@g);
    // The curve can't graduate twice, and the locker would refuse a second time anyway.
    let curve = launchpad::interfaces::IBondingCurveSafeDispatcher { contract_address: g.launch.curve };
    match launchpad::interfaces::IBondingCurveSafeDispatcherTrait::graduate(curve) {
        Result::Ok(_) => panic!("graduated twice"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: already graduated'),
    }
    cheat_caller_address(locker.contract_address, g.launch.curve, CheatSpan::TargetCalls(1));
    match locker.graduate(g.launch.token, ONE, ONE) {
        Result::Ok(_) => panic!("the locker graduated a coin twice"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: already graduated'),
    }
}

#[test]
#[fork("SEPOLIA")]
#[feature("safe_dispatcher")]
fn the_swap_hooks_are_off_and_refuse_everyone() {
    let g = graduated(SEPOLIA_CORE, SEPOLIA_ROUTER, true);
    let ext = IExtensionSafeDispatcher { contract_address: g.locker.contract_address };
    // Core never calls them (no swap call points); called directly, they refuse.
    let params = SwapParameters {
        amount: i129 { mag: 1, sign: false }, is_token1: false, sqrt_ratio_limit: MIN_SQRT_RATIO, skip_ahead: 0,
    };
    let delta = launchpad::ekubo::Delta { amount0: i129 { mag: 1, sign: false }, amount1: i129 { mag: 1, sign: true } };
    match ext.after_swap(carol(), g.key, params, delta) {
        Result::Ok(_) => panic!("after_swap did something"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: not used'),
    }
    match ext.before_swap(carol(), g.key, params) {
        Result::Ok(_) => panic!("before_swap did something"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: not used'),
    }
}

#[test]
#[fork("SEPOLIA")]
#[feature("safe_dispatcher")]
fn a_pool_trade_past_its_deadline_is_refused() {
    let g = graduated(SEPOLIA_CORE, SEPOLIA_ROUTER, true);
    snforge_std::start_cheat_block_timestamp_global(2_000);
    g.locker.check_deadline(2_000);
    let safe = IGradLockerSafeDispatcher { contract_address: g.locker.contract_address };
    match safe.check_deadline(1_999) {
        Result::Ok(_) => panic!("a late pool trade went through"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: expired'),
    }
}

// --- Trading in the pool, Hokori's trade events, and fees -------------------------------------------------------

fn trades_and_fees(core: felt252, router: felt252, coin_below_currency: bool, core_keeps_bps: u256) {
    let g = graduated(core, router, coin_below_currency);
    let currency = g.s.currency;
    fund(currency, bob(), 1_000 * ONE);
    start_cheat_account_contract_address_global(bob());
    let mut spy = spy_events();

    // Bob buys with 100 currency, then sells half of what he got.
    let spend = 100 * ONE;
    let bought = router_trade(@g, bob(), currency, spend);
    assert!(bought > 0);
    assert_eq!(g.token.balance_of(bob()), bought);
    let sold = bought / 2;
    let paid = router_trade(@g, bob(), g.token, sold);
    // The test pool is small (about 84 currency), so the buy moved the price a lot and the half sold back fetches
    // more than half the spend; a round trip still never profits.
    assert!(paid > 0 && paid < spend);

    // The locker emits nothing for trades now; each is reported by Core's own Swapped event, which the market data
    // reads: data = locker, pool_key (token0, token1, fee, tick_spacing, extension), params (amount { mag, sign },
    // is_token1, sqrt_ratio_limit { low, high }, skip_ahead), delta (amount0 { mag, sign }, amount1 { mag, sign }),
    // sqrt_ratio_after { low, high }, tick_after { mag, sign }, liquidity_after.
    assert_eq!(spy.get_events().emitted_by(g.locker.contract_address).events.len(), 0);
    let mut swaps: Array<Span<felt252>> = array![];
    for (_, e) in spy.get_events().emitted_by(g.core.contract_address).events {
        if *e.keys.at(0) == selector!("Swapped") && *e.data.at(5) == g.locker.contract_address.into() {
            assert_eq!(e.data.len(), 21);
            assert_eq!(*e.data.at(1), g.key.token0.into());
            assert_eq!(*e.data.at(2), g.key.token1.into());
            swaps.append(e.data.span());
        }
    }
    assert_eq!(swaps.len(), 2);
    // The coin's and the currency's deltas, from the pool's side (positive went into the pool).
    let (coin_at, money_at) = if coin_below_currency { (12_usize, 14_usize) } else { (14_usize, 12_usize) };
    let buy = *swaps.at(0);
    assert_eq!((*buy.at(coin_at)).into(), bought); // tokens out of the pool
    assert_eq!(*buy.at(coin_at + 1), 1); // negative
    assert_eq!((*buy.at(money_at)).into(), spend); // currency into the pool
    assert_eq!(*buy.at(money_at + 1), 0);
    let sell = *swaps.at(1);
    assert_eq!((*sell.at(coin_at)).into(), sold);
    assert_eq!(*sell.at(coin_at + 1), 0);
    assert_eq!((*sell.at(money_at)).into(), paid);
    assert_eq!(*sell.at(money_at + 1), 1);
    // The price after each swap is Core's own.
    let after: u256 = u256 { low: (*sell.at(16)).try_into().unwrap(), high: (*sell.at(17)).try_into().unwrap() };
    assert_eq!(after, g.core.get_pool_price(g.key).sqrt_ratio);

    // Anyone collects: the currency side to the vault (credited to the coin, 29% / 71% then 70/30), the coin side
    // burned. Each side's fee is 1% of what went in, less what this network's Core keeps.
    let supply = g.token.total_supply();
    let (to_vault, burned) = g.locker.collect_fees(g.launch.token);
    let keep = 10_000 - core_keeps_bps;
    assert!(to_vault <= spend / 100 && to_vault + 2 >= spend * keep / 1_000_000, "currency fee");
    assert!(burned <= sold / 100 && burned + 2 >= sold * keep / 1_000_000, "coin fee");
    assert_eq!(g.token.total_supply(), supply - burned);
    let protocol_cut = to_vault * 2900 / 10_000;
    assert_eq!(g.s.vault.balance_of(g.launch.token, protocol()) >= protocol_cut, true);
    // Collecting again right away finds nothing.
    assert_eq!(g.locker.collect_fees(g.launch.token), (0, 0));
}

#[test]
#[fork("SEPOLIA")]
fn sepolia_trades_report_events_and_fees_reach_the_vault() {
    // Sepolia's Core (v4.0.1) keeps 20% of collected fees.
    trades_and_fees(SEPOLIA_CORE, SEPOLIA_ROUTER, true, 2_000);
}

#[test]
#[fork("SEPOLIA")]
fn sepolia_trades_with_the_coin_above_the_currency() {
    trades_and_fees(SEPOLIA_CORE, SEPOLIA_ROUTER, false, 2_000);
}

#[test]
#[fork("MAINNET")]
fn mainnet_trades_report_events_and_fees_reach_the_vault() {
    // Mainnet's Core (v5.0.2) keeps nothing from a direct locker.
    trades_and_fees(MAINNET_CORE, MAINNET_ROUTER, true, 0);
}

// --- The whole life cycle --------------------------------------------------------------------------------------

/// What one deposit credits under the vault's rule: protocol share first, then 70/30, remainder to the last.
fn split_70_30(amount: u256, protocol_bps: u256) -> (u256, u256, u256) {
    let protocol = amount * protocol_bps / 10_000;
    let rest = amount - protocol;
    let first = rest * 7_000 / 10_000;
    (protocol, first, rest - first)
}

#[test]
#[fork("SEPOLIA")]
fn full_life_cycle_launch_trade_graduate_and_claim_exact_shares() {
    let g = graduated(SEPOLIA_CORE, SEPOLIA_ROUTER, true);
    let curve = IBondingCurveDispatcher { contract_address: g.launch.curve };
    fund(g.s.currency, alice(), 10 * ONE);
    router_trade(@g, alice(), g.s.currency, 10 * ONE);
    // Three deposits, each split on its own (rounding per deposit): the curve's fees (trading plus the graduation
    // fee), then the pool's.
    let from_curve = curve.flush_fees();
    let (from_pool, _) = g.locker.collect_fees(g.launch.token);
    assert!(from_curve > 0 && from_pool > 0);
    let (p1, a1, b1) = split_70_30(from_curve, 2900);
    let (p2, a2, b2) = split_70_30(from_pool, 2900);
    assert_eq!(g.s.vault.balance_of(g.launch.token, protocol()), p1 + p2);
    assert_eq!(g.s.vault.balance_of(g.launch.token, payee()), a1 + a2);
    assert_eq!(g.s.vault.balance_of(g.launch.token, bob()), b1 + b2);
    for who in array![payee(), bob(), protocol()] {
        let owed = g.s.vault.balance_of(g.launch.token, who);
        let before = g.s.currency.balance_of(who);
        start_cheat_caller_address(g.s.vault.contract_address, who);
        assert_eq!(g.s.vault.claim(g.launch.token), owed);
        stop_cheat_caller_address(g.s.vault.contract_address);
        assert_eq!(g.s.currency.balance_of(who), before + owed);
    }
    assert_eq!(g.s.currency.balance_of(g.s.vault.contract_address), 0);
    // The supply only ever shrank (unused reserve, rounding dust, burned coin-side fees); nothing was minted.
    assert!(g.token.total_supply() < g.s.factory.supply());
}

// --- Quote parity with the SDK (17f1a14 V5) ----------------------------------------------------------------------
// One buy (currency in) and one sell (coin in) through Ekubo's Router, for each token order on Sepolia's Core (v4.0.1)
// and mainnet's (v5.0.2), so token0 and token1 input are both exercised on both versions. The pool state and outputs
// are printed for the SDK's vectors (sdk/test/sdk.test.mjs, "deployed Core parity"), and asserted here.

fn parity(core: felt252, router: felt252, coin_below_currency: bool, label: ByteArray) -> (u256, u256) {
    let g = graduated(core, router, coin_below_currency);
    let p0 = g.core.get_pool_price(g.key);
    let liquidity = g.core.get_pool_liquidity(g.key);
    fund(g.s.currency, bob(), 1_000 * ONE);
    let spend = 7 * ONE + 123_456_789;
    let bought = router_trade(@g, bob(), g.s.currency, spend);
    let p1 = g.core.get_pool_price(g.key);
    let sell = bought / 3;
    let paid = router_trade(@g, bob(), g.token, sell);
    println!(
        "PARITY {} coin_is_token0={} sqrt0={} liquidity={} buy_in={} buy_out={} sqrt1={} sell_in={} sell_out={}",
        label, g.key.token0 == g.launch.token, p0.sqrt_ratio, liquidity, spend, bought, p1.sqrt_ratio, sell, paid,
    );
    (bought, paid)
}

#[test]
#[fork("SEPOLIA")]
fn parity_sepolia_coin_token0() {
    let (bought, paid) = parity(SEPOLIA_CORE, SEPOLIA_ROUTER, true, "sepolia-v4");
    assert_eq!((bought, paid), (15582996923445228700225242, 2409737048598943046));
}

#[test]
#[fork("SEPOLIA")]
fn parity_sepolia_coin_token1() {
    // Token0 (the currency) in: v4.0.1 floors L*2^128 / sqrt first, so this buy gets 798,261 base units less than on v5.
    let (bought, paid) = parity(SEPOLIA_CORE, SEPOLIA_ROUTER, false, "sepolia-v4");
    assert_eq!((bought, paid), (15582996923445228699426981, 2409737048598943046));
}

#[test]
#[fork("MAINNET")]
fn parity_mainnet_coin_token0() {
    let (bought, paid) = parity(MAINNET_CORE, MAINNET_ROUTER, true, "mainnet-v5");
    assert_eq!((bought, paid), (15582996923445228700225242, 2409737048598943046));
}

#[test]
#[fork("MAINNET")]
fn parity_mainnet_coin_token1() {
    let (bought, paid) = parity(MAINNET_CORE, MAINNET_ROUTER, false, "mainnet-v5");
    assert_eq!((bought, paid), (15582996923445228700225242, 2409737048598943046));
}

// --- Hokori's fees: 0.7% per trade, 10% of it to the protocol ------------------------------------

#[test]
#[fork("SEPOLIA")]
fn a_factory_at_seven_tenths_of_a_percent_charges_the_same_in_its_pools_and_gives_the_protocol_ten_percent() {
    let mut p = pump_params();
    p.x_reserve = 0;
    p.fee_bps = 70;
    let s = try_setup_factory_full(p, 1000, 0, 0, 0, addr(SEPOLIA_CORE)).unwrap();
    let g = launched_in(s, SEPOLIA_CORE, SEPOLIA_ROUTER, true, 0);
    // The pool key carries 0.7% as Ekubo encodes it: floor(70 * 2^128 / 10000).
    assert_eq!(g.key.fee, 2381976568446569244243622252022377480);
    sell_out(@g);
    check_opening_price(@g);
    // A trade in the pool pays 0.7% (Sepolia's Core keeps 20% of it when collected); the protocol gets 10% of what
    // reaches the vault, the payees the rest.
    let curve_fees = IBondingCurveDispatcher { contract_address: g.launch.curve }.state().fees;
    fund(g.s.currency, bob(), 1_000 * ONE);
    let spend = 100 * ONE;
    router_trade(@g, bob(), g.s.currency, spend);
    let (to_vault, _) = g.locker.collect_fees(g.launch.token);
    assert!(to_vault <= spend * 70 / 10_000 && to_vault + 2 >= spend * 70 * 8_000 / 100_000_000, "a 0.7% fee, less Core's 20%");
    assert_eq!(g.s.vault.balance_of(g.launch.token, protocol()), to_vault * 1000 / 10_000);
    // The curve's own fees were 0.7% too (plus the graduation fee): nothing flushed yet.
    assert!(curve_fees > 0);
}

// --- Security pass F3/F4: Hokori's own settings always graduate into the real Ekubo ----------------------------------
// If a factory's curves couldn't graduate, every coin's last buy would revert for ever. The deployment settings (the
// 100,000 STRK curve since 26 Oct, 0.9% fee, 1% graduation fee) are checked on both deployed Cores, for both token
// orders; then a fuzz runs across accepted settings.

fn hokori_params() -> launchpad::interfaces::CurveParams {
    let mut p = pump_params();
    p.v0 = 35291892573445971504224; // graduation at 100,000 STRK raised
    p.x_reserve = 0; // the factory computes it
    p.fee_bps = 90;
    p
}

fn buy_out(g: @Graduated, offer: u256) {
    fund((*g.s).currency, carol(), offer);
    approve_as((*g.s).currency, carol(), (*g.launch).curve);
    start_cheat_caller_address((*g.launch).curve, carol());
    IBondingCurveDispatcher { contract_address: (*g.launch).curve }.buy_and_graduate(offer, 0, FAR);
    stop_cheat_caller_address((*g.launch).curve);
}

fn hokori_settings_graduate(core: felt252, router: felt252, coin_below_currency: bool) {
    let s = try_setup_factory_full(hokori_params(), 1000, 0, 0, 0, addr(core)).unwrap();
    let g = launched_in(s, core, router, coin_below_currency, 0);
    buy_out(@g, 150_000 * ONE); // about 101,000 STRK closes the curve; the rest is never taken
    assert!(IBondingCurveDispatcher { contract_address: g.launch.curve }.state().graduated);
    check_opening_price(@g);
    assert!(g.core.get_pool_liquidity(g.key) > 0);
    assert_eq!(g.token.balance_of(g.locker.contract_address), 0);
    assert_eq!(g.s.currency.balance_of(g.locker.contract_address), 0);
}

#[test]
#[fork("SEPOLIA")]
fn hokori_settings_graduate_on_sepolia_coin_token0() {
    hokori_settings_graduate(SEPOLIA_CORE, SEPOLIA_ROUTER, true);
}

#[test]
#[fork("SEPOLIA")]
fn hokori_settings_graduate_on_sepolia_coin_token1() {
    hokori_settings_graduate(SEPOLIA_CORE, SEPOLIA_ROUTER, false);
}

#[test]
#[fork("MAINNET")]
fn hokori_settings_graduate_on_mainnet_coin_token0() {
    hokori_settings_graduate(MAINNET_CORE, MAINNET_ROUTER, true);
}

#[test]
#[fork("MAINNET")]
fn hokori_settings_graduate_on_mainnet_coin_token1() {
    hokori_settings_graduate(MAINNET_CORE, MAINNET_ROUTER, false);
}

#[test]
#[fork("SEPOLIA")]
#[fuzzer(runs: 12, seed: 41)]
fn fuzz_accepted_settings_graduate_into_ekubo(a: u64, b: u64, c: u16, d: u16) {
    // v0 from 0.001 to about 5M STRK; 10% to 95% of t0 sold on the curve; fees up to their 10% bounds.
    let mut p = pump_params();
    p.x_reserve = 0;
    p.v0 = (a % 5_000_000_000_000).into() * 1_000_000_000_000 + 1_000_000_000_000_000;
    p.curve_tokens = p.t0 * ((b % 86) + 10).into() / 100;
    p.fee_bps = c % 1001;
    p.grad_fee_bps = d % 1001;
    let s = match try_setup_factory_full(p, 1000, 0, 0, 0, addr(SEPOLIA_CORE)) {
        Result::Ok(s) => s,
        Result::Err(err) => {
            // Refusing up front is fine: it must be one of the graduation checks, never a crash.
            let why = reason(err);
            assert!(
                why == 'curve: pool would be empty' || why == 'curve: pool amounts too large'
                    || why == 'curve: pool price out of range',
            );
            return;
        },
    };
    let g = launched_in(s, SEPOLIA_CORE, SEPOLIA_ROUTER, a % 2 == 0, 0);
    buy_out(@g, 500_000_000 * ONE);
    assert!(IBondingCurveDispatcher { contract_address: g.launch.curve }.state().graduated);
    check_opening_price(@g);
    assert_eq!(g.token.balance_of(g.locker.contract_address), 0);
}
