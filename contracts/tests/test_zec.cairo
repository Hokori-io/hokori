//! The ZEC launchpad: the same factory, curve, vault and locker with
//! NEAR's bridged ZEC on Starknet as the currency, graduating at 4 ZEC raised, with Hokori's fees.
//!
//! The contracts never read a currency's decimals: what changes is the size of the amounts. ZEC has 8 decimals, so a ZEC
//! curve's reserve is about 1.4e8 to 5.4e8 base units, against about 3.5e22 to 1.4e23 for STRK. Checked here:
//! - the settings are accepted, and every curve closes at exactly 4 ZEC raised;
//! - the smallest trade, and round trips that leave the curve's reserve exactly as before, at that scale;
//! - on a mainnet fork, with the real ZEC token and the real Ekubo, the whole life cycle in both token orders: the launch
//!   fee and a dev buy, graduation at the curve's price, pool trades, fee collection and every claim. The token is minted
//!   for the test by its owner, the Omni Bridge.
use launchpad::ekubo::ICoreDispatcherTrait;
use launchpad::interfaces::{
    IBondingCurveDispatcher, IBondingCurveDispatcherTrait, IBondingCurveSafeDispatcher,
    IBondingCurveSafeDispatcherTrait, IFeeVaultDispatcherTrait, IGradLockerDispatcherTrait,
    ILaunchFactoryDispatcherTrait,
};
use launchpad::math::graduation_seed;
use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address, test_address};
use starknet::ContractAddress;
use crate::common::*;
use crate::test_graduation::{MAINNET_CORE, MAINNET_ROUTER, check_opening_price, launched_in, router_trade};

/// One ZEC in base units (8 decimals).
pub(crate) const ZEC: u256 = 100_000_000;
/// NEAR's bridged ZEC on Starknet mainnet, and the Omni Bridge contract that owns it and mints it.
const ZEC_TOKEN: felt252 = 0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841;
const OMNI_BRIDGE: felt252 = 0x05f9a4a841dfb7bb3cde33073b2450fe45dcd407fb6c0985a274b0e943ad8598;
/// Hokori's settings for the ZEC launchpad, the STRK launchpad's: a 15% protocol share, no launch fee,
/// no dev buy cap.
const PROTOCOL_BPS: u16 = 1500;
const LAUNCH_FEE: u256 = 0;
const MAX_DEV_BPS: u16 = 10_000;

#[starknet::interface]
trait IBridgedToken<T> {
    fn mint(ref self: T, recipient: ContractAddress, amount: u256);
}

/// The STRK launchpad's curve shape with v0 = 141,167,570 base units, which raises exactly 4 ZEC (v0 = 4 ZEC x
/// 2,799 / 7,931, rounded to the nearest unit that closes at 4 ZEC); 0.9% fee, 1% graduation fee, 99% for two blocks;
/// a minimum trade of 0.00001 ZEC.
pub(crate) fn zec_params() -> launchpad::interfaces::CurveParams {
    let mut p = pump_params();
    p.v0 = 141_167_570;
    p.x_reserve = 0; // the factory computes it
    p.min_trade = 1_000;
    p.fee_bps = 90;
    p
}

#[test]
fn the_zec_settings_close_every_curve_at_exactly_four_zec() {
    let seed = graduation_seed(@zec_params());
    assert_eq!(seed.real, 4 * ZEC);
    assert_eq!(seed.grad_fee, 4 * ZEC / 100);
    // The factory accepts them (the pool's opening price is inside the 2^-64..2^64 the curve checks requires).
    let s = try_setup_factory_capped(zec_params(), PROTOCOL_BPS, 0, 0, LAUNCH_FEE, mock_core(), MAX_DEV_BPS).unwrap();
    assert_eq!(s.factory.launch_fee(), LAUNCH_FEE);
    let p = s.factory.curve_params();
    assert!(p.x_reserve >= seed.x, "the pool's tokens are reserved");
}

/// A ZEC factory on a stand-in currency (the contracts never read decimals), its coin launched by alice, past the
/// launch window, with every trader allowed to trade it on the curve.
fn zec_curve() -> (FactorySetup, IBondingCurveDispatcher, IERC20Dispatcher) {
    let s = try_setup_factory_capped(zec_params(), PROTOCOL_BPS, 0, 0, LAUNCH_FEE, mock_core(), MAX_DEV_BPS).unwrap();
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
fn the_smallest_zec_trade_is_a_thousand_base_units() {
    let (_, curve, token) = zec_curve();
    let safe = IBondingCurveSafeDispatcher { contract_address: curve.contract_address };
    start_cheat_caller_address(curve.contract_address, bob());
    match safe.buy(999, 0, FAR) {
        Result::Ok(_) => panic!("a buy under the minimum went through"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: below minimum trade'),
    }
    stop_cheat_caller_address(curve.contract_address);
    // 0.00001 ZEC (about 1.2 US cents) buys about 7,600 whole tokens at the opening price, and sells back for something.
    let got = buy(curve, bob(), 1_000);
    assert!(got > 7_000_000_000_000_000_000_000 && got < 8_000_000_000_000_000_000_000, "about 7,600 tokens");
    let back = sell(curve, bob(), token.balance_of(bob()));
    assert!(back > 0 && back < 1_000);
}

#[test]
fn zec_round_trips_leave_the_reserve_exactly_as_it_was() {
    let (s, curve, token) = zec_curve();
    let held = || s.currency.balance_of(alice()) + s.currency.balance_of(bob());
    let before = held();
    buy(curve, alice(), ZEC / 2);
    buy(curve, bob(), 12 * ZEC / 10);
    buy(curve, alice(), 3 * ZEC / 10);
    let st = curve.state();
    assert!(st.real > 0 && st.fees > 0);
    // Bob sells first, after Alice's second buy raised the price, so one trader can come out ahead of another.
    sell(curve, bob(), token.balance_of(bob()));
    sell(curve, alice(), token.balance_of(alice()));
    // Selling every outstanding token pays out exactly the reserve: nothing is left over, nothing is short.
    let st = curve.state();
    assert_eq!(st.real, 0);
    assert_eq!(st.sold, 0);
    // Between them they lost exactly the fees, about 0.9% each way on 2 ZEC bought and sold back.
    assert_eq!(before - held(), st.fees, "every base unit lost went to fees");
    assert!(st.fees > 2 * ZEC * 17 / 1000 && st.fees < 2 * ZEC * 19 / 1000, "about 1.8% of 2 ZEC");
}

// --- The real ZEC token and the real Ekubo, on a mainnet fork ------------------------------------------------------

/// A ZEC factory on the fork against mainnet's Ekubo Core, with the real ZEC token as its currency. The bridge mints
/// the test account enough to fund every trader as the shared setup does.
pub(crate) fn real_zec_factory() -> FactorySetup {
    let zec = IERC20Dispatcher { contract_address: addr(ZEC_TOKEN) };
    start_cheat_caller_address(zec.contract_address, addr(OMNI_BRIDGE));
    IBridgedTokenDispatcher { contract_address: zec.contract_address }.mint(test_address(), 10_000_000 * ONE);
    stop_cheat_caller_address(zec.contract_address);
    try_setup_factory_as(zec_params(), PROTOCOL_BPS, 0, 0, LAUNCH_FEE, addr(MAINNET_CORE), MAX_DEV_BPS, protocol(), zec).unwrap()
}

/// What one deposit credits under the vault's rule: Hokori's 15% first, then the payees' 70 / 30, the remainder to the
/// last.
fn split(amount: u256) -> (u256, u256, u256) {
    let hokori = amount * PROTOCOL_BPS.into() / 10_000;
    let rest = amount - hokori;
    let first = rest * 7_000 / 10_000;
    (hokori, first, rest - first)
}

fn real_zec_life_cycle(coin_below_zec: bool) {
    let s = real_zec_factory();
    let zec = s.currency;
    let protocol_before = zec.balance_of(protocol());
    // Alice launches with a dev buy of 0.1 ZEC; there is no launch fee.
    let g = launched_in(s, MAINNET_CORE, MAINNET_ROUTER, coin_below_zec, ZEC / 10);
    assert_eq!(zec.balance_of(protocol()), protocol_before + LAUNCH_FEE);
    let curve = IBondingCurveDispatcher { contract_address: g.launch.curve };
    assert!(curve.state().real > 9 * ZEC / 100, "the dev buy is in the curve");
    // Carol offers 6 ZEC for the rest: about 3.94 ZEC closes the curve at exactly 4 ZEC raised, and the pool opens.
    approve_as(zec, carol(), g.launch.curve);
    let carol_before = zec.balance_of(carol());
    start_cheat_caller_address(g.launch.curve, carol());
    curve.buy_and_graduate(6 * ZEC, 0, FAR);
    stop_cheat_caller_address(g.launch.curve);
    assert!(carol_before - zec.balance_of(carol()) < 4 * ZEC, "the unused offer stays Carol's");
    assert!(curve.state().graduated);
    check_opening_price(@g);
    assert!(g.core.get_pool_liquidity(g.key) > 0);
    assert_eq!(g.token.balance_of(g.locker.contract_address), 0);
    assert_eq!(zec.balance_of(g.locker.contract_address), 0);
    // Bob trades in the pool with 0.5 ZEC (the pool holds about 3.96), then sells half back.
    fund(zec, bob(), ZEC);
    let bought = router_trade(@g, bob(), zec, ZEC / 2);
    assert!(bought > 0);
    let paid = router_trade(@g, bob(), g.token, bought / 2);
    assert!(paid > 0 && paid < ZEC / 2);
    // Fees: the curve's (trading and graduation) and the pool's ZEC side reach the vault; the pool's coin side burns.
    let from_curve = curve.flush_fees();
    let supply = g.token.total_supply();
    let (from_pool, burned) = g.locker.collect_fees(g.launch.token);
    assert!(from_curve > 4 * ZEC / 100, "at least the 1% graduation fee");
    assert!(from_pool > 0 && from_pool <= ZEC / 2 * 90 / 10_000, "0.9% of the ZEC that went in, Core keeping nothing");
    assert!(burned > 0 && g.token.total_supply() == supply - burned);
    // Every claim pays ZEC: Hokori's 15%, then the payees' 70 / 30, per deposit.
    let (h1, a1, b1) = split(from_curve);
    let (h2, a2, b2) = split(from_pool);
    assert_eq!(g.s.vault.balance_of(g.launch.token, protocol()), h1 + h2);
    assert_eq!(g.s.vault.balance_of(g.launch.token, payee()), a1 + a2);
    assert_eq!(g.s.vault.balance_of(g.launch.token, bob()), b1 + b2);
    for who in array![payee(), bob(), protocol()] {
        let owed = g.s.vault.balance_of(g.launch.token, who);
        let before = zec.balance_of(who);
        start_cheat_caller_address(g.s.vault.contract_address, who);
        assert_eq!(g.s.vault.claim(g.launch.token), owed);
        stop_cheat_caller_address(g.s.vault.contract_address);
        assert_eq!(zec.balance_of(who), before + owed);
    }
    assert_eq!(zec.balance_of(g.s.vault.contract_address), 0);
}

#[test]
#[fork("MAINNET")]
fn real_zec_life_cycle_with_the_coin_below_zec() {
    real_zec_life_cycle(true);
}

#[test]
#[fork("MAINNET")]
fn real_zec_life_cycle_with_the_coin_above_zec() {
    real_zec_life_cycle(false);
}

