//! Contract v2: the launch window (anti-sniper fee) and the launch deadline. Buys in the launch block and the next
//! pay 99%, anyone's but the creator's dev buy inside the launch; from the third block on, the normal 1%. A launch
//! that reaches the chain after its deadline is refused.
use launchpad::interfaces::{
    CurveParams, IBondingCurveDispatcher, IBondingCurveDispatcherTrait, IFeeVaultDispatcherTrait,
    ILaunchFactoryDispatcherTrait,
};
use launchpad::math::fee_up;
use snforge_std::{
    start_cheat_block_number_global, start_cheat_block_timestamp_global, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use crate::common::*;

#[test]
fn buys_in_the_launch_block_and_the_next_pay_the_window_fee_then_the_normal_fee() {
    let s = setup_curve(pump_params());
    let gross = 10 * ONE;
    for (block, bps) in array![(LAUNCH_BLOCK, 9900_u16), (LAUNCH_BLOCK + 1, 9900), (LAUNCH_BLOCK + 2, 100)] {
        start_cheat_block_number_global(block);
        // Asked as a trader: this test deployed the curve, so to the curve it is the factory (whose dev buy is exempt).
        start_cheat_caller_address(s.curve.contract_address, alice());
        assert_eq!(s.curve.buy_fee_bps(), bps);
        let quoted = s.curve.quote_buy(gross);
        stop_cheat_caller_address(s.curve.contract_address);
        let r = buy_as(@s, alice(), gross);
        assert_eq!(r, quoted);
        assert_eq!(r.fee, fee_up(gross, bps.into()));
    }
    check_curve_balances(@s);
}

#[test]
fn sells_in_the_window_pay_the_normal_fee() {
    let s = setup_curve(pump_params());
    let bought = buy_as(@s, alice(), 10 * ONE).out;
    start_cheat_block_number_global(LAUNCH_BLOCK);
    let r = sell_as(@s, alice(), bought);
    assert_eq!(r.fee, fee_up(r.gross, 100));
    check_curve_balances(@s);
}

#[test]
fn the_window_fee_goes_to_the_vault_like_any_fee() {
    let s = setup_curve(pump_params());
    start_cheat_block_number_global(LAUNCH_BLOCK);
    let r = buy_as(@s, alice(), 100 * ONE);
    assert_eq!(s.curve.state().fees, r.fee);
    s.curve.flush_fees();
    assert_eq!(s.vault.balance_of(s.token.contract_address, payee()), r.fee);
}

#[test]
fn a_curve_without_a_window_charges_the_normal_fee_from_the_launch_block() {
    let mut p = pump_params();
    p.sniper_blocks = 0;
    let s = setup_curve(p);
    start_cheat_block_number_global(LAUNCH_BLOCK);
    assert_eq!(buy_as(@s, alice(), 10 * ONE).fee, fee_up(10 * ONE, 100));
}

#[test]
fn window_settings_out_of_bounds_are_refused_at_creation() {
    let mut cases: Array<(CurveParams, felt252)> = array![];
    let mut p = pump_params();
    p.sniper_blocks = 11;
    cases.append((p, 'curve: sniper window too long'));
    let mut p = pump_params();
    p.sniper_fee_bps = 9901;
    cases.append((p, 'curve: bad sniper fee'));
    let mut p = pump_params();
    p.sniper_fee_bps = 99; // below the normal fee
    cases.append((p, 'curve: bad sniper fee'));
    for (p, why) in cases {
        match try_setup_curve(p, true, 0) {
            Result::Ok(_) => panic!("accepted a bad launch window"),
            Result::Err(err) => assert_eq!(reason(err), why),
        }
    }
}

#[test]
fn the_dev_buy_pays_the_normal_fee_and_a_buy_in_the_same_block_pays_the_window_fee() {
    let s = setup_factory(0);
    let dev_buy = 50 * ONE;
    start_cheat_caller_address(s.factory.contract_address, alice());
    let l = s
        .factory
        .launch(
            "Quantum Cat",
            "QCAT",
            meta_uri(),
            META_SHA256,
            array![payee()],
            array![10_000],
            dev_buy,
            0,
            0,
            FAR,
        );
    stop_cheat_caller_address(s.factory.contract_address);
    let curve = IBondingCurveDispatcher { contract_address: l.curve };
    assert_eq!(curve.launch_block(), LAUNCH_BLOCK);
    let dev_fee = curve.state().fees;
    assert_eq!(dev_fee, fee_up(dev_buy, 100));

    // A bot buying in the launch block, and in the next one.
    approve_as(s.currency, bob(), l.curve);
    for block in array![LAUNCH_BLOCK, LAUNCH_BLOCK + 1] {
        start_cheat_block_number_global(block);
        start_cheat_caller_address(l.curve, bob());
        let r = curve.buy(10 * ONE, 0, FAR);
        stop_cheat_caller_address(l.curve);
        assert_eq!(r.fee, fee_up(10 * ONE, 9900));
    }
    start_cheat_block_number_global(LAUNCH_BLOCK + 2);
    start_cheat_caller_address(l.curve, bob());
    assert_eq!(curve.buy(10 * ONE, 0, FAR).fee, fee_up(10 * ONE, 100));
    stop_cheat_caller_address(l.curve);
}

#[test]
#[should_panic(expected: 'factory: expired')]
fn a_launch_after_its_deadline_is_refused() {
    let s = setup_factory(0);
    start_cheat_block_timestamp_global(2_000);
    start_cheat_caller_address(s.factory.contract_address, alice());
    s
        .factory
        .launch(
            "Quantum Cat",
            "QCAT",
            meta_uri(),
            META_SHA256,
            array![payee()],
            array![10_000],
            0,
            0,
            0,
            1_999,
        );
}

#[test]
fn a_launch_at_its_deadline_goes_through() {
    let s = setup_factory(0);
    start_cheat_block_timestamp_global(2_000);
    start_cheat_caller_address(s.factory.contract_address, alice());
    s
        .factory
        .launch(
            "Quantum Cat",
            "QCAT",
            meta_uri(),
            META_SHA256,
            array![payee()],
            array![10_000],
            0,
            0,
            0,
            2_000,
        );
    assert_eq!(s.factory.launch_count(), 1);
}
