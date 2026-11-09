//! Security pass: attack paths the other tests didn't already exercise. Each test names the
//! threat it guards. Graduation into the real Ekubo is in test_graduation.cairo (forks).
use launchpad::ekubo::{ILockerSafeDispatcher, ILockerSafeDispatcherTrait};
use launchpad::interfaces::{
    IBondingCurveDispatcherTrait, IFeeVaultDispatcherTrait, IGradLockerSafeDispatcher,
    IGradLockerSafeDispatcherTrait, ILaunchFactoryDispatcherTrait,
};
use openzeppelin_interfaces::erc20::IERC20DispatcherTrait;
use snforge_std::{start_cheat_block_timestamp_global, start_cheat_caller_address, stop_cheat_caller_address};
use crate::common::*;

// --- D2: a round trip on the curve never returns more than it paid ----------------------------------------------

#[test]
#[fuzzer(runs: 60, seed: 23)]
fn fuzz_a_round_trip_never_returns_more_than_it_paid(a: u64, b: u64) {
    let s = setup_curve(pump_params());
    let min = pump_params().min_trade;
    // Others have traded first (the curve can be anywhere along its path), then Alice buys and sells it all back.
    buy_as(@s, carol(), (a % 20_000_000 + 1).into() * min);
    let before = s.currency.balance_of(alice());
    buy_as(@s, alice(), (b % 20_000_000 + 1).into() * min);
    try_sell_all(@s, alice());
    assert!(s.currency.balance_of(alice()) <= before, "a buy-then-sell round trip made a profit");
    check_curve_balances(@s);
}

// --- P2: sells carry a minimum received and a deadline ------------------------------------------------------------

#[test]
#[should_panic(expected: 'curve: slippage')]
fn sell_respects_its_minimum_received() {
    let s = setup_curve(pump_params());
    let tokens = buy_as(@s, alice(), ONE).out;
    let q = s.curve.quote_sell(tokens);
    start_cheat_caller_address(s.curve.contract_address, alice());
    s.curve.sell(tokens, q.paid + 1, FAR);
}

#[test]
#[should_panic(expected: 'curve: expired')]
fn sell_respects_its_deadline() {
    let s = setup_curve(pump_params());
    let tokens = buy_as(@s, alice(), ONE).out;
    start_cheat_block_timestamp_global(5_000);
    start_cheat_caller_address(s.curve.contract_address, alice());
    s.curve.sell(tokens, 0, 4_999);
}

// --- D4: only a payee's own balance, once ---------------------------------------------------------------------------

#[test]
fn a_claim_pays_only_the_callers_own_balance_and_only_once() {
    let s = setup_curve(pump_params());
    let coin = s.token.contract_address;
    buy_as(@s, alice(), 10 * ONE);
    let fees = s.curve.flush_fees();
    assert!(fees > 0);
    // Someone who isn't a payee claims: nothing moves.
    let bob_before = s.currency.balance_of(bob());
    start_cheat_caller_address(s.vault.contract_address, bob());
    assert_eq!(s.vault.claim(coin), 0);
    stop_cheat_caller_address(s.vault.contract_address);
    assert_eq!(s.currency.balance_of(bob()), bob_before);
    assert_eq!(s.vault.balance_of(coin, payee()), fees);
    // The payee claims, then claims again: the second pays nothing.
    start_cheat_caller_address(s.vault.contract_address, payee());
    assert_eq!(s.vault.claim(coin), fees);
    assert_eq!(s.vault.claim(coin), 0);
    stop_cheat_caller_address(s.vault.contract_address);
    assert_eq!(s.currency.balance_of(payee()), fees);
    assert_eq!(s.currency.balance_of(s.vault.contract_address), 0);
}

// --- D6 / D9: the locker's gates that refuse before any call to Ekubo -------------------------------------------------

#[test]
#[feature("safe_dispatcher")]
fn the_lockers_callback_refuses_anyone_but_core() {
    let s = setup_factory(0);
    let locker = ILockerSafeDispatcher { contract_address: s.factory.locker() };
    // A crafted "collect" callback, sent directly, would otherwise withdraw tokens to the locker.
    start_cheat_caller_address(locker.contract_address, carol());
    match locker.locked(1, array![1, 0, 0, 0, 0, 0].span()) {
        Result::Ok(_) => panic!("the locker ran a callback that didn't come from Core"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: core only'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn fees_cant_be_collected_before_graduation_and_unknown_coins_cant_graduate() {
    let s = setup_factory(0);
    let l = launch_as(@s, alice(), array![payee()], array![10_000], 0, 0);
    let locker = IGradLockerSafeDispatcher { contract_address: s.factory.locker() };
    match locker.collect_fees(l.token) {
        Result::Ok(_) => panic!("collected fees for a coin that hasn't graduated"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: not graduated'),
    }
    // A token the factory never launched has no curve, so nobody can graduate it, the locker included.
    start_cheat_caller_address(locker.contract_address, carol());
    match locker.graduate(addr('not a coin'), ONE, ONE) {
        Result::Ok(_) => panic!("graduated a token the factory never launched"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: only the coin curve'),
    }
    stop_cheat_caller_address(locker.contract_address);
    // Nor can anyone but its curve graduate a real coin, even with the right token.
    start_cheat_caller_address(locker.contract_address, alice());
    match locker.graduate(l.token, ONE, ONE) {
        Result::Ok(_) => panic!("someone other than the curve graduated a coin"),
        Result::Err(err) => assert_eq!(reason(err), 'locker: only the coin curve'),
    }
}
