//! The BTC launchpad: the same factory, curve, vault and locker with strkBTC, Bitcoin on Starknet,
//! as the currency, graduating at 0.12 BTC raised, on the STRK and ZEC launchpads' curve shape and with Hokori's fees.
//!
//! strkBTC has 8 decimals, like ZEC, so a BTC curve's reserve is small: 0.12 BTC is 12,000,000 base units against about
//! 2.05e26 units of tokens for the pool, and the pool's opening price must stay within the 2^-64..2^64 the curve checks
//! allow. That puts the smallest raise on this shape at about 0.1122 BTC. Checked here:
//! - the settings are accepted, every curve closes at exactly 0.12 BTC raised, and a raise just under the bound is
//!   refused;
//! - the smallest trade, and round trips that leave the curve's reserve exactly as before, at that scale;
//! - on a mainnet fork, with the real strkBTC and the real Ekubo, the whole life cycle in both token orders: a dev buy,
//!   graduation at the curve's price, pool trades, fee collection and every claim. The token is minted for the test, in
//!   the fork only, by its permitted minter (StarkGate's mintable token, read from its storage).
use launchpad::ekubo::ICoreDispatcherTrait;
use launchpad::interfaces::{
    IBondingCurveDispatcher, IBondingCurveDispatcherTrait, IBondingCurveSafeDispatcher,
    IBondingCurveSafeDispatcherTrait, IFeeVaultDispatcherTrait, IGradLockerDispatcherTrait,
    ILaunchFactoryDispatcherTrait,
};
use launchpad::math::graduation_seed;
use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{load, start_cheat_caller_address, stop_cheat_caller_address, test_address};
use starknet::ContractAddress;
use crate::common::*;
use crate::test_graduation::{MAINNET_CORE, MAINNET_ROUTER, check_opening_price, launched_in, router_trade};

/// One BTC in base units (8 decimals).
pub(crate) const BTC: u256 = 100_000_000;
/// strkBTC on Starknet mainnet.
const STRKBTC_TOKEN: felt252 = 0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135;
/// Hokori's settings for the BTC launchpad, the STRK and ZEC launchpads': a 15% protocol share, no launch fee, no dev
/// buy cap.
const PROTOCOL_BPS: u16 = 1500;
const LAUNCH_FEE: u256 = 0;
const MAX_DEV_BPS: u16 = 10_000;

/// StarkGate's mintable token: only its permitted minter (the bridge) mints.
#[starknet::interface]
trait IMintableToken<T> {
    fn permissioned_mint(ref self: T, account: ContractAddress, amount: u256);
}

/// The STRK launchpad's curve shape with v0 = 4,235,027 base units, which raises exactly 0.12 BTC (v0 = 0.12 BTC x
/// 2,799 / 7,931, rounded to the unit that closes at 0.12 BTC, as for ZEC); 0.9% fee, 1% graduation fee, 99% for two
/// blocks; a minimum trade of 0.00001 BTC.
pub(crate) fn btc_params() -> launchpad::interfaces::CurveParams {
    let mut p = pump_params();
    p.v0 = 4_235_027;
    p.x_reserve = 0; // the factory computes it
    p.min_trade = 1_000;
    p.fee_bps = 90;
    p
}

#[test]
fn the_btc_settings_close_every_curve_at_exactly_twelve_hundredths_of_a_btc() {
    let seed = graduation_seed(@btc_params());
    assert_eq!(seed.real, 12 * BTC / 100);
    assert_eq!(seed.grad_fee, 12 * BTC / 100 / 100);
    // The pool gets 0.1188 BTC, about 7% over the 0.1110 its opening price needs, and the factory accepts them.
    assert_eq!(seed.y, 11_880_000);
    let s = try_setup_factory_capped(btc_params(), PROTOCOL_BPS, 0, 0, LAUNCH_FEE, mock_core(), MAX_DEV_BPS).unwrap();
    assert_eq!(s.factory.launch_fee(), LAUNCH_FEE);
    let p = s.factory.curve_params();
    assert!(p.x_reserve >= seed.x, "the pool's tokens are reserved");
}

#[test]
fn a_raise_under_the_pool_price_bound_is_refused() {
    // 0.112 BTC: the pool would get about 0.1109 BTC, under the 0.1110 its opening price needs.
    let mut p = btc_params();
    p.v0 = 3_952_692;
    let seed = graduation_seed(@p);
    assert!(seed.real > 111 * BTC / 1000 && seed.real < 113 * BTC / 1000, "about 0.112 BTC raised");
    match try_setup_factory_capped(p, PROTOCOL_BPS, 0, 0, LAUNCH_FEE, mock_core(), MAX_DEV_BPS) {
        Result::Ok(_) => panic!("a BTC curve under the pool price bound was accepted"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: pool price out of range'),
    }
}

/// A BTC factory on a stand-in currency (the contracts never read decimals), its coin launched by alice, past the
/// launch window, with every trader allowed to trade it on the curve.
fn btc_curve() -> (FactorySetup, IBondingCurveDispatcher, IERC20Dispatcher) {
    let s = try_setup_factory_capped(btc_params(), PROTOCOL_BPS, 0, 0, LAUNCH_FEE, mock_core(), MAX_DEV_BPS).unwrap();
    let launch = launch_as(@s, alice(), array![payee()], array![10_000], 0, 0);
    let token = IERC20Dispatcher { contract_address: launch.token };
    for who in traders() {
        approve_as(s.currency, who, launch.curve);
        approve_as(token, who, launch.curve);
    }
    (s, IBondingCurveDispatcher { contract_address: launch.curve }, token)
}

fn buy(curve: IBondingCurveDispatcher, who: ContractAddress, gross: u256) -> u256 {
    start_cheat_caller_address(curve.contract_address, who);
    let r = curve.buy(gross, 0, FAR);
    stop_cheat_caller_address(curve.contract_address);
    r.out
}

fn sell(curve: IBondingCurveDispatcher, who: ContractAddress, tokens: u256) -> u256 {
    start_cheat_caller_address(curve.contract_address, who);
    let r = curve.sell(tokens, 0, FAR);
    stop_cheat_caller_address(curve.contract_address);
    r.paid
}

#[test]
#[feature("safe_dispatcher")]
fn the_smallest_btc_trade_is_a_thousand_base_units() {
    let (_, curve, token) = btc_curve();
    let safe = IBondingCurveSafeDispatcher { contract_address: curve.contract_address };
    start_cheat_caller_address(curve.contract_address, bob());
    match safe.buy(999, 0, FAR) {
        Result::Ok(_) => panic!("a buy under the minimum went through"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: below minimum trade'),
    }
    stop_cheat_caller_address(curve.contract_address);
    // 0.00001 BTC (about 76 US cents) buys about 251,000 whole tokens at the opening price, and sells back for 982 units.
    let got = buy(curve, bob(), 1_000);
    assert!(got > 240_000 * ONE && got < 260_000 * ONE, "about 251,000 tokens");
    let back = sell(curve, bob(), token.balance_of(bob()));
    assert!(back > 0 && back < 1_000);
}

#[test]
fn btc_round_trips_leave_the_reserve_exactly_as_it_was() {
    let (s, curve, token) = btc_curve();
    let held = || s.currency.balance_of(alice()) + s.currency.balance_of(bob());
    let before = held();
    buy(curve, alice(), 15 * BTC / 1000);
    buy(curve, bob(), 36 * BTC / 1000);
    buy(curve, alice(), 9 * BTC / 1000);
    let st = curve.state();
    assert!(st.real > 0 && st.fees > 0);
    // Bob sells first, after Alice's second buy raised the price, so one trader can come out ahead of another.
    sell(curve, bob(), token.balance_of(bob()));
    sell(curve, alice(), token.balance_of(alice()));
    // Selling every outstanding token pays out exactly the reserve: nothing is left over, nothing is short.
    let st = curve.state();
    assert_eq!(st.real, 0);
    assert_eq!(st.sold, 0);
    // Between them they lost exactly the fees, about 0.9% each way on 0.06 BTC bought and sold back.
    assert_eq!(before - held(), st.fees, "every base unit lost went to fees");
    assert!(st.fees > 6 * BTC / 100 * 17 / 1000 && st.fees < 6 * BTC / 100 * 19 / 1000, "about 1.8% of 0.06 BTC");
}

// --- The real strkBTC and the real Ekubo, on a mainnet fork -------------------------------------------------------

/// A BTC factory on the fork against mainnet's Ekubo Core, with the real strkBTC as its currency. Its permitted minter,
/// read from the token's storage, mints the test account enough to fund every trader as the shared setup does (in the
/// fork only).
fn real_btc_factory() -> FactorySetup {
    let btc = IERC20Dispatcher { contract_address: addr(STRKBTC_TOKEN) };
    let minter = addr(*load(btc.contract_address, selector!("permitted_minter"), 1).at(0));
    start_cheat_caller_address(btc.contract_address, minter);
    IMintableTokenDispatcher { contract_address: btc.contract_address }.permissioned_mint(test_address(), 10_000_000 * ONE);
    stop_cheat_caller_address(btc.contract_address);
    try_setup_factory_as(btc_params(), PROTOCOL_BPS, 0, 0, LAUNCH_FEE, addr(MAINNET_CORE), MAX_DEV_BPS, protocol(), btc).unwrap()
}

/// What one deposit credits under the vault's rule: Hokori's 15% first, then the payees' 70 / 30, the remainder to the
/// last.
fn split(amount: u256) -> (u256, u256, u256) {
    let hokori = amount * PROTOCOL_BPS.into() / 10_000;
    let rest = amount - hokori;
    let first = rest * 7_000 / 10_000;
    (hokori, first, rest - first)
}

fn real_btc_life_cycle(coin_below_btc: bool) {
    let s = real_btc_factory();
    let btc = s.currency;
    let protocol_before = btc.balance_of(protocol());
    // Alice launches with a dev buy of 0.003 BTC; there is no launch fee.
    let g = launched_in(s, MAINNET_CORE, MAINNET_ROUTER, coin_below_btc, 3 * BTC / 1000);
    assert_eq!(btc.balance_of(protocol()), protocol_before + LAUNCH_FEE);
    let curve = IBondingCurveDispatcher { contract_address: g.launch.curve };
    assert!(curve.state().real > 27 * BTC / 10_000, "the dev buy is in the curve");
    // Carol offers 0.18 BTC for the rest: about 0.118 BTC closes the curve at exactly 0.12 BTC raised, and the pool opens.
    approve_as(btc, carol(), g.launch.curve);
    let carol_before = btc.balance_of(carol());
    start_cheat_caller_address(g.launch.curve, carol());
    curve.buy_and_graduate(18 * BTC / 100, 0, FAR);
    stop_cheat_caller_address(g.launch.curve);
    assert!(carol_before - btc.balance_of(carol()) < 12 * BTC / 100, "the unused offer stays Carol's");
    assert!(curve.state().graduated);
    check_opening_price(@g);
    assert!(g.core.get_pool_liquidity(g.key) > 0);
    assert_eq!(g.token.balance_of(g.locker.contract_address), 0);
    assert_eq!(btc.balance_of(g.locker.contract_address), 0);
    // Bob trades in the pool with 0.015 BTC (the pool holds about 0.1188), then sells half back.
    fund(btc, bob(), 3 * BTC / 100);
    let bought = router_trade(@g, bob(), btc, 15 * BTC / 1000);
    assert!(bought > 0);
    let paid = router_trade(@g, bob(), g.token, bought / 2);
    assert!(paid > 0 && paid < 15 * BTC / 1000);
    // Fees: the curve's (trading and graduation) and the pool's BTC side reach the vault; the pool's coin side burns.
    let from_curve = curve.flush_fees();
    let supply = g.token.total_supply();
    let (from_pool, burned) = g.locker.collect_fees(g.launch.token);
    assert!(from_curve > 12 * BTC / 10_000, "at least the 1% graduation fee");
    assert!(from_pool > 0 && from_pool <= 15 * BTC / 1000 * 90 / 10_000, "0.9% of the BTC that went in, Core keeping nothing");
    assert!(burned > 0 && g.token.total_supply() == supply - burned);
    // Every claim pays strkBTC: Hokori's 15%, then the payees' 70 / 30, per deposit.
    let (h1, a1, b1) = split(from_curve);
    let (h2, a2, b2) = split(from_pool);
    assert_eq!(g.s.vault.balance_of(g.launch.token, protocol()), h1 + h2);
    assert_eq!(g.s.vault.balance_of(g.launch.token, payee()), a1 + a2);
    assert_eq!(g.s.vault.balance_of(g.launch.token, bob()), b1 + b2);
    for who in array![payee(), bob(), protocol()] {
        let owed = g.s.vault.balance_of(g.launch.token, who);
        let before = btc.balance_of(who);
        start_cheat_caller_address(g.s.vault.contract_address, who);
        assert_eq!(g.s.vault.claim(g.launch.token), owed);
        stop_cheat_caller_address(g.s.vault.contract_address);
        assert_eq!(btc.balance_of(who), before + owed);
    }
    assert_eq!(btc.balance_of(g.s.vault.contract_address), 0);
}

#[test]
#[fork("MAINNET")]
fn real_btc_life_cycle_with_the_coin_below_strkbtc() {
    real_btc_life_cycle(true);
}

#[test]
#[fork("MAINNET")]
fn real_btc_life_cycle_with_the_coin_above_strkbtc() {
    real_btc_life_cycle(false);
}

