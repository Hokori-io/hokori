//! Behaviour the spec requires, checked directly rather than against the reference model (so a mistake shared
//! by both can't hide): exits of any size, refusals, configurations that must graduate, interleaved trading with
//! every balance checked, rollback of failed calls, graduation's handover to the locker and the fee vault. The
//! curve here graduates into a stand-in locker; graduation into Ekubo itself is tested on forks
//! (test_graduation.cairo).
use launchpad::interfaces::{
    CurveParams, IBondingCurveDispatcherTrait, IBondingCurveSafeDispatcher,
    IBondingCurveSafeDispatcherTrait, IFeeVaultDispatcherTrait,
};
use launchpad::math::graduation_seed;
use openzeppelin_interfaces::erc20::IERC20DispatcherTrait;
use snforge_std::{
    start_cheat_block_timestamp_global, start_cheat_caller_address, stop_cheat_caller_address,
};
use crate::common::*;

fn params() -> CurveParams {
    pump_params()
}

const TWO_40: u256 = 0x10000000000;
const TWO_96: u256 = 0x1000000000000000000000000; // the largest accepted v0
const TWO_128: u256 = 0x100000000000000000000000000000000; // the largest accepted t0 / x_reserve
const TWO_97: u256 = 0x2000000000000000000000000;
const TWO_120: u256 = 0x1000000000000000000000000000000;
const TWO_150: u256 = 0x40000000000000000000000000000000000000;
/// Currency per trader in the large-number tests: more than any accepted curve can cost (< 2^225 with fees).
const BIG_FUNDS: u256 = 0x4000000000000000000000000000000000000000000000000000000000; // 2^230

// --- Exits (review R1) ----------------------------------------------------------------------------------------

#[test]
fn a_minimum_size_buy_can_be_sold_back() {
    // Review R1: the 1% fee left a minimum buy's proceeds below the old sell minimum.
    let s = setup_curve(params());
    buy_as(@s, alice(), params().min_trade);
    assert!(try_sell_all(@s, alice()));
    assert_eq!(s.curve.state().real, 0);
    check_curve_balances(@s);
}

#[test]
fn small_split_holdings_can_each_be_sold() {
    let s = setup_curve(params());
    let out = buy_as(@s, alice(), params().min_trade).out;
    // Alice splits her minimum-size position three ways.
    transfer_as(s.token, alice(), bob(), out / 3);
    transfer_as(s.token, alice(), carol(), out / 3);
    for who in traders() {
        assert!(try_sell_all(@s, who));
    }
    let st = s.curve.state();
    assert_eq!(st.sold, 0);
    assert!(st.real <= 1);
    check_curve_balances(@s);
}

#[test]
#[should_panic(expected: 'curve: sell pays nothing')]
fn a_sell_worth_nothing_after_its_fee_is_refused() {
    let s = setup_curve(params());
    buy_as(@s, alice(), ONE);
    s.curve.quote_sell(1); // one token base unit is worth far less than one currency base unit
}

#[test]
fn everyone_can_exit_and_the_reserve_ends_at_exactly_zero() {
    let s = setup_curve(params());
    buy_as(@s, alice(), 3 * ONE);
    buy_as(@s, bob(), 7 * ONE + 123_456_789);
    buy_as(@s, alice(), ONE / 3);
    buy_as(@s, bob(), 11 * ONE);
    check_curve_balances(@s);
    assert!(try_sell_all(@s, alice()));
    assert!(try_sell_all(@s, bob()));
    let st = s.curve.state();
    // Payouts telescope to exactly the real reserve: nothing left over, nothing short.
    assert_eq!(st.real, 0);
    assert_eq!(st.sold, 0);
    assert_eq!(st.q, params().v0);
    assert_eq!(st.t, params().t0);
    check_curve_balances(@s);
}

#[test]
#[fuzzer(runs: 40, seed: 7)]
fn fuzz_any_buys_then_full_exit(a: u64, b: u64, c: u64) {
    let s = setup_curve(params());
    // From the minimum trade (0.000001) up to 18 currency.
    let min = params().min_trade;
    buy_as(@s, alice(), (a % 18_000_000 + 1).into() * min);
    buy_as(@s, bob(), (b % 18_000_000 + 1).into() * min);
    buy_as(@s, carol(), (c % 18_000_000 + 1).into() * min);
    check_curve_balances(@s);
    if c % 2 == 0 {
        for who in traders() {
            try_sell_all(@s, who);
        }
    } else {
        for who in array![carol(), alice(), bob()] {
            try_sell_all(@s, who);
        }
    }
    let st = s.curve.state();
    assert!(st.real <= 1);
    check_curve_balances(@s);
}

// --- Interleaved trading with every balance checked ------------------------------------------------------

fn next(r: u64) -> u64 {
    let v: u128 = r.into() * 6364136223846793005 + 1442695040888963407;
    (v % 0x10000000000000000).try_into().unwrap()
}

/// Currency and tokens are conserved across the traders, the curve, the locker and the vault after every step.
fn check_conservation(s: @CurveSetup, currency_total: u256) {
    let st = (*s.curve).state();
    let mut cur: u256 = (*s.currency).balance_of((*s.curve).contract_address)
        + (*s.currency).balance_of((*s.vault).contract_address)
        + (*s.currency).balance_of(st.locker);
    let mut tok: u256 = (*s.token).balance_of((*s.curve).contract_address)
        + (*s.token).balance_of(st.locker);
    for who in traders() {
        cur += (*s.currency).balance_of(who);
        tok += (*s.token).balance_of(who);
    }
    assert_eq!(cur, currency_total);
    assert_eq!(tok, (*s.token).total_supply());
}

#[test]
#[fuzzer(runs: 20, seed: 11)]
#[feature("safe_dispatcher")]
fn fuzz_interleaved_buys_sells_and_transfers_keep_the_books(seed: u64) {
    let s = setup_curve(params());
    let safe = IBondingCurveSafeDispatcher { contract_address: s.curve.contract_address };
    let mut total: u256 = s.currency.balance_of(s.curve.contract_address);
    for who in traders() {
        total += s.currency.balance_of(who);
    }
    let mut r = seed;
    let mut step: u32 = 0;
    while step < 30 && s.curve.state().open {
        r = next(r);
        let who = *traders().at((r % 3).try_into().unwrap());
        let other = *traders().at(((r / 3 + 1) % 3).try_into().unwrap());
        let op = (r / 9) % 4;
        r = next(r);
        if op <= 1 {
            // Buy anything from the minimum trade to about 9 currency.
            let scale: u32 = (r % 8).try_into().unwrap();
            let mut amount = params().min_trade;
            for _ in 0..scale {
                amount *= 10;
            }
            amount *= ((r / 8) % 9 + 1).into();
            start_cheat_caller_address(safe.contract_address, who);
            let result = safe.buy(amount, 0, FAR);
            stop_cheat_caller_address(safe.contract_address);
            assert!(result.is_ok());
        } else if op == 2 {
            // Sell a random share of a holding (1% to 100%).
            let held = s.token.balance_of(who);
            if held > 0 {
                let amount = held * ((r % 100) + 1).into() / 100;
                if amount > 0 {
                    start_cheat_caller_address(safe.contract_address, who);
                    let result = safe.sell(amount, 0, FAR);
                    stop_cheat_caller_address(safe.contract_address);
                    if let Result::Err(err) = result {
                        assert_eq!(reason(err), 'curve: sell pays nothing');
                    }
                }
            }
        } else {
            // Move part of a holding to another trader.
            let held = s.token.balance_of(who);
            if held > 0 {
                transfer_as(s.token, who, other, held * ((r % 100) + 1).into() / 100);
            }
        }
        check_curve_balances(@s);
        check_conservation(@s, total);
        step += 1;
    }
    if s.curve.state().open {
        for who in traders() {
            try_sell_all(@s, who);
        }
        assert!(s.curve.state().real <= 1);
    } else {
        // A plain buy closed the curve without graduating; anyone then graduates it.
        assert!(!s.curve.state().graduated, "a plain buy never graduates");
        s.curve.graduate();
        assert!(s.curve.state().graduated);
    }
    check_curve_balances(@s);
    check_conservation(@s, total);
}

#[test]
#[feature("safe_dispatcher")]
fn a_failed_buy_changes_nothing() {
    let s = setup_curve(params());
    buy_as(@s, alice(), ONE);
    let before = s.curve.state();
    let safe = IBondingCurveSafeDispatcher { contract_address: s.curve.contract_address };
    // Dave has no currency approval, so the payment fails and the whole buy reverts.
    let dave = addr('dave');
    start_cheat_caller_address(safe.contract_address, dave);
    assert!(safe.buy(ONE, 0, FAR).is_err());
    stop_cheat_caller_address(safe.contract_address);
    assert_eq!(s.curve.state(), before);
    assert_eq!(s.token.balance_of(dave), 0);
    check_curve_balances(@s);
}

// --- Configurations (review R2) --------------------------------------------------------------------------

#[test]
fn a_configuration_whose_pool_would_be_empty_is_refused_at_creation() {
    // Review R2: accepted before, this curve closed and could never graduate.
    let tiny = CurveParams {
        v0: ONE,
        t0: 3,
        curve_tokens: 2,
        x_reserve: 1,
        min_trade: 1,
        fee_bps: 0,
        grad_fee_bps: 0,
        sniper_fee_bps: 0,
        sniper_blocks: 0,
    };
    match try_setup_curve(tiny, true, ONE) {
        Result::Ok(_) => panic!("accepted a curve that cannot graduate"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: pool would be empty'),
    }
}

#[test]
fn a_reserve_too_small_for_graduation_is_refused_at_creation() {
    let mut p = params();
    p.x_reserve = 1_000;
    match try_setup_curve(p, true, ONE) {
        Result::Ok(_) => panic!("accepted an insufficient reserve"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: reserve too small'),
    }
}

#[test]
fn out_of_range_numbers_are_refused_at_creation() {
    let mut p = params();
    p.v0 = 0x1000000000000000000000001; // 2^96 + 1
    match try_setup_curve(p, true, ONE) {
        Result::Ok(_) => panic!("accepted v0 out of range"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: v0 out of range'),
    }
}

#[test]
fn t0_above_the_bound_is_refused_at_creation() {
    let mut p = params();
    p.t0 = TWO_128 + 1;
    match try_setup_curve(p, true, ONE) {
        Result::Ok(_) => panic!("accepted t0 out of range"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: t0 out of range'),
    }
}

#[test]
fn the_largest_accepted_numbers_trade_and_graduate_without_overflow() {
    // v0 and t0 at their maximums and every fee at its 10% maximum, with 2^97 tokens left at the close: the
    // pool's currency (about 2^127) at Ekubo's 128-bit limit, and its price (about 2^30) inside the range.
    let p = CurveParams {
        v0: TWO_96,
        t0: TWO_128,
        curve_tokens: TWO_128 - TWO_97,
        x_reserve: 2 * TWO_97,
        min_trade: 1,
        fee_bps: 1000,
        grad_fee_bps: 1000,
        sniper_fee_bps: 9900,
        sniper_blocks: 2,
    };
    let s = try_setup_curve(p, true, BIG_FUNDS).unwrap();
    buy_as(@s, alice(), TWO_120); // takes most curve tokens
    sell_as(@s, alice(), s.token.balance_of(alice()) / 2); // half straight back on the curve
    buy_and_graduate_as(@s, bob(), TWO_150); // buys out the rest, the remainder refunded, and graduates
    let st = s.curve.state();
    assert!(!st.open && st.graduated);
    let g = graduation_seed(@p);
    assert_eq!(s.token.balance_of(s.locker), g.x);
    assert_eq!(s.currency.balance_of(s.locker), g.y);
    check_curve_balances(@s);
}

#[test]
fn configurations_beyond_ekubo_are_refused_at_creation() {
    // 2^40 tokens left at the close: the pool's currency would be about 2^184, past Ekubo's 128 bits.
    let mut big = pump_params();
    big.v0 = TWO_96;
    big.t0 = TWO_128;
    big.curve_tokens = TWO_128 - TWO_40;
    big.x_reserve = 2 * TWO_40;
    // A curve whose pool would price a token at 2^-97 currency: outside the range the locker prices with care.
    let mut cheap = pump_params();
    cheap.v0 = 1;
    cheap.t0 = 0x10000000000000000000000000; // 2^100
    cheap.curve_tokens = 0x8000000000000000000000000; // half
    cheap.x_reserve = 0x8000000000000000000000000;
    cheap.fee_bps = 0;
    cheap.grad_fee_bps = 0;
    cheap.min_trade = 1;
    for (p, why) in array![(big, 'curve: pool amounts too large'), (cheap, 'curve: pool price out of range')] {
        match try_setup_curve(p, true, ONE) {
            Result::Ok(_) => panic!("accepted a pool Ekubo can't hold"),
            Result::Err(err) => assert_eq!(reason(err), why),
        }
    }
}

#[test]
#[should_panic(expected: 'curve: not funded')]
fn an_unfunded_curve_refuses_buys() {
    let s = try_setup_curve(params(), false, 1_000_000 * ONE).unwrap();
    buy_as(@s, alice(), ONE);
}

#[test]
fn a_small_boundary_configuration_closes_and_graduates() {
    // t_end = 400, q_end = ceil(10^21 / 400) = 2.5e18, real = 1.5e18, pool tokens = 1.5e18 * 400 / 2.5e18 = 240.
    let p = CurveParams {
        v0: ONE,
        t0: 1_000,
        curve_tokens: 600,
        x_reserve: 240,
        min_trade: 1,
        fee_bps: 0,
        grad_fee_bps: 0,
        sniper_fee_bps: 0,
        sniper_blocks: 0,
    };
    let s = setup_curve(p);
    buy_and_graduate_as(@s, alice(), 10 * ONE); // buys out the curve and graduates
    assert!(s.curve.state().graduated);
    assert_eq!(s.token.balance_of(s.locker), 240);
    assert_eq!(s.currency.balance_of(s.locker), 1_500_000_000_000_000_000);
    assert_eq!(s.token.total_supply(), 600 + 240); // nothing burned: the reserve was exact
}

#[test]
#[fuzzer(runs: 150, seed: 5)]
fn fuzz_every_accepted_configuration_can_close_and_graduate(
    a: u64, b: u64, c: u64, d: u16, e: u16, f: u16,
) {
    // Shapes biased toward the edges where rounding bites (tiny supplies; one to three tokens left when the
    // curve closes), plus mid-size and large ones; v0 small or large; every fee level up to the bounds.
    let t0: u256 = if a % 4 == 0 {
        (a / 4 % 20).into() + 2
    } else if a % 4 == 1 {
        (a / 4 % 100_000).into() + 2
    } else if a % 4 == 2 {
        (a / 4 % 1_000_000_000_000).into() + 2
    } else {
        TWO_128 - (a / 4 % 0x100000000).into() // the top of the accepted range
    };
    let mut t_end: u256 = if b % 3 == 0 {
        (b / 3 % 3).into() + 1
    } else if b % 3 == 1 {
        (b / 3).into() % (t0 - 1) + 1
    } else {
        // A power of two up to 2^126: spans tiny to huge closing reserves.
        let mut v: u256 = 1;
        for _ in 0..(b / 3 % 127) {
            v *= 2;
        }
        v
    };
    if t_end >= t0 {
        t_end = t0 - 1;
    }
    let curve_tokens = t0 - t_end;
    let v0: u256 = if c % 3 == 0 {
        (c / 3 % 1_000).into() + 1
    } else if c % 3 == 1 {
        (c / 3 % 1_000_000_000).into() + 1
    } else {
        TWO_96 - (c / 3 % 0x100000000).into() // the top of the accepted range
    };
    let p = CurveParams {
        v0,
        t0,
        curve_tokens,
        x_reserve: t0, // always enough: the pool never needs more tokens than t_end < t0
        min_trade: 1,
        fee_bps: d % 1001,
        grad_fee_bps: e % 1001,
        sniper_fee_bps: 9900,
        sniper_blocks: 2,
    };
    match try_setup_curve(p, true, BIG_FUNDS) {
        Result::Err(err) => {
            // Refusing up front is fine; it must be one of the graduation checks, never a crash.
            let why = reason(err);
            assert!(
                why == 'curve: pool would be empty' || why == 'curve: pool amounts too large'
                    || why == 'curve: pool price out of range',
            );
        },
        Result::Ok(s) => {
            buy_and_graduate_as(@s, alice(), BIG_FUNDS / 2); // buys out the curve, refunds the rest, graduates
            let st = s.curve.state();
            assert!(!st.open && st.graduated);
            let g = graduation_seed(@p);
            assert!(g.x > 0 && g.y > 0);
            assert_eq!(s.token.balance_of(s.locker), g.x);
            assert_eq!(s.currency.balance_of(s.locker), g.y);
            check_curve_balances(@s);
        },
    }
}

// --- Trading rules ------------------------------------------------------------------------------------------

#[test]
#[should_panic(expected: 'curve: sell exceeds sold')]
fn cannot_sell_more_than_the_curve_sold() {
    let s = setup_curve(params());
    buy_as(@s, alice(), ONE);
    s.curve.quote_sell(s.curve.state().sold + 1);
}

#[test]
#[should_panic(expected: 'curve: slippage')]
fn buy_respects_min_out() {
    let s = setup_curve(params());
    let q = s.curve.quote_buy(ONE);
    start_cheat_caller_address(s.curve.contract_address, alice());
    s.curve.buy(ONE, q.out + 1, FAR);
}

#[test]
#[should_panic(expected: 'curve: expired')]
fn buy_respects_deadline() {
    let s = setup_curve(params());
    start_cheat_block_timestamp_global(1_000);
    start_cheat_caller_address(s.curve.contract_address, alice());
    s.curve.buy(ONE, 0, 999);
}

#[test]
#[should_panic(expected: 'curve: below minimum trade')]
fn buys_below_the_minimum_are_refused() {
    let s = setup_curve(params());
    buy_as(@s, alice(), params().min_trade - 1);
}

#[test]
#[should_panic(expected: 'curve: still selling')]
fn cannot_graduate_early() {
    let s = setup_curve(params());
    buy_as(@s, alice(), ONE);
    s.curve.graduate();
}

#[test]
fn last_buy_is_partially_filled_then_the_curve_closes() {
    let s = setup_curve(params());
    let before = s.currency.balance_of(alice());
    let r = buy_and_graduate_as(@s, alice(), 200 * ONE); // far more than the ~86 the whole curve costs
    assert_eq!(r.out, params().curve_tokens);
    assert!(r.refund > 0);
    // Only what the trade cost was taken.
    assert_eq!(s.currency.balance_of(alice()), before - r.spent);
    let st = s.curve.state();
    assert!(!st.open);
    assert!(st.graduated, "asked to, the last buy graduates in the same call");
    assert_eq!(st.sold, params().curve_tokens);
    check_curve_balances(@s);
}

// --- A plain buy never graduates (review d2684e0 R3) ---------------------------------------------
// A buy that ends up taking the last tokens (others bought first) must still fit the gas its wallet allowed, so it
// only closes the curve. Hokori's graduation service then graduates it within seconds; anyone else may too.

#[test]
fn a_plain_last_buy_closes_the_curve_and_anyone_then_graduates_it_the_same_way() {
    let s = setup_curve(params());
    let supply = s.token.total_supply();
    let before = s.currency.balance_of(alice());
    let r = buy_as(@s, alice(), 200 * ONE);
    assert_eq!(r.out, params().curve_tokens);
    assert!(r.refund > 0);
    assert_eq!(s.currency.balance_of(alice()), before - r.spent);
    let st = s.curve.state();
    assert!(!st.open && !st.graduated, "closed, waiting for graduation");
    // Nothing has gone to the locker yet: the curve still holds the pool's reserve tokens and the real reserve.
    assert_eq!(s.token.balance_of(s.locker), 0);
    assert_eq!(s.token.balance_of(s.curve.contract_address), params().x_reserve);
    check_curve_balances(@s);
    // Anyone graduates it, with exactly the atomic path's result.
    start_cheat_caller_address(s.curve.contract_address, carol());
    s.curve.graduate();
    stop_cheat_caller_address(s.curve.contract_address);
    let g = graduation_seed(@params());
    let st = s.curve.state();
    assert!(st.graduated);
    assert_eq!(st.real, 0);
    assert_eq!(s.token.balance_of(s.locker), g.x);
    assert_eq!(s.currency.balance_of(s.locker), g.y);
    assert_eq!(s.token.balance_of(s.curve.contract_address), 0);
    assert_eq!(s.token.total_supply(), supply - (params().x_reserve - g.x));
    check_curve_balances(@s);
}

#[test]
fn both_paths_hand_the_pool_exactly_the_same() {
    let a = setup_curve(params());
    let b = setup_curve(params());
    buy_as(@a, alice(), 50 * ONE);
    buy_as(@b, alice(), 50 * ONE);
    buy_and_graduate_as(@a, bob(), 200 * ONE);
    buy_as(@b, bob(), 200 * ONE);
    b.curve.graduate();
    assert_eq!(a.token.balance_of(a.locker), b.token.balance_of(b.locker));
    assert_eq!(a.currency.balance_of(a.locker), b.currency.balance_of(b.locker));
    assert_eq!(a.curve.state().fees, b.curve.state().fees);
    assert_eq!(a.token.total_supply(), b.token.total_supply());
}

#[test]
#[should_panic(expected: 'curve: not the last buy')]
fn buy_and_graduate_short_of_the_end_reverts() {
    let s = setup_curve(params());
    buy_and_graduate_as(@s, alice(), 3 * ONE);
}

/// Review b37a86c R1: a buy_and_graduate quoted for exactly what's left; someone sells first, so the same call no longer
/// closes the curve (as a wallet would estimate it now): it reverts instead of succeeding as a cheap buy. Bought back,
/// it closes the curve again and graduates. Its estimate can never be the cheap branch while its execution graduates.
#[test]
#[feature("safe_dispatcher")]
fn buy_and_graduate_fails_rather_than_buy_cheaply_when_others_sell_first() {
    let s = setup_curve(params());
    buy_as(@s, carol(), 80 * ONE); // most of the curve
    let left = params().curve_tokens - s.curve.state().sold;
    let offer = s.curve.quote_buy(10 * ONE).spent; // exactly what closing the curve costs now
    assert_eq!(s.curve.quote_buy(offer).out, left);
    sell_as(@s, carol(), ONE); // a holder sells one token
    let safe = IBondingCurveSafeDispatcher { contract_address: s.curve.contract_address };
    start_cheat_caller_address(s.curve.contract_address, alice());
    match safe.buy_and_graduate(offer, 0, FAR) {
        Result::Ok(_) => panic!("it went through as a cheap buy"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: not the last buy'),
    }
    stop_cheat_caller_address(s.curve.contract_address);
    assert!(s.curve.state().open, "nothing changed");
    // A third trade buys that token back: the same call now closes the curve, and graduates.
    buy_as(@s, bob(), s.curve.quote_buy(ONE / 1000).spent);
    let r = buy_and_graduate_as(@s, alice(), 10 * ONE);
    assert!(r.out > 0);
    assert!(s.curve.state().graduated);
}

#[test]
#[should_panic(expected: 'curve: closed')]
fn no_selling_while_the_closed_curve_waits_for_graduation() {
    let s = setup_curve(params());
    buy_as(@s, alice(), 200 * ONE);
    sell_as(@s, alice(), ONE);
}

#[test]
#[should_panic(expected: 'curve: closed')]
fn no_trading_on_the_curve_after_it_closes() {
    let s = setup_curve(params());
    buy_as(@s, alice(), 200 * ONE);
    buy_as(@s, bob(), ONE);
}

#[test]
#[should_panic(expected: 'curve: already graduated')]
fn graduation_happens_once() {
    let s = setup_curve(params());
    buy_and_graduate_as(@s, alice(), 200 * ONE); // graduates
    s.curve.graduate(); // nothing left to do
}

// --- Graduation's handover ------------------------------------------------------------------------------------

#[test]
fn the_last_buy_hands_the_reserve_and_its_tokens_to_the_locker_and_burns_the_rest() {
    let s = setup_curve(params());
    let supply = s.token.total_supply();
    buy_and_graduate_as(@s, alice(), 200 * ONE);
    let g = graduation_seed(@params());
    let st = s.curve.state();
    assert!(st.graduated);
    assert_eq!(st.real, 0);
    assert_eq!(s.token.balance_of(s.locker), g.x);
    assert_eq!(s.currency.balance_of(s.locker), g.y);
    // The curve keeps only fees (trading fees plus the graduation fee) and no tokens; spare reserve is burned.
    assert_eq!(s.currency.balance_of(s.curve.contract_address), st.fees);
    assert_eq!(s.token.balance_of(s.curve.contract_address), 0);
    assert_eq!(s.token.total_supply(), supply - (params().x_reserve - g.x));
}

// --- Fees -------------------------------------------------------------------------------------------------

#[test]
fn fees_reach_the_payee_per_coin_and_are_claimable() {
    let s = setup_curve(params());
    let coin = s.token.contract_address;
    buy_as(@s, alice(), 10 * ONE);
    sell_as(@s, alice(), s.token.balance_of(alice()) / 2);
    let fees = s.curve.state().fees;
    assert!(fees > 0);
    assert_eq!(s.curve.flush_fees(), fees);
    assert_eq!(s.curve.state().fees, 0);
    assert_eq!(s.vault.balance_of(coin, payee()), fees); // this vault's protocol share is 0
    check_curve_balances(@s);
    start_cheat_caller_address(s.vault.contract_address, payee());
    assert_eq!(s.vault.claim(coin), fees);
    stop_cheat_caller_address(s.vault.contract_address);
    assert_eq!(s.currency.balance_of(payee()), fees);
    assert_eq!(s.vault.balance_of(coin, payee()), 0);
}

#[test]
fn vault_splits_protocol_share_then_payees_with_the_remainder_to_the_last() {
    let currency = deploy_token("Stark stand-in", "STRK", 1_000 * ONE, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 499);
    let coin = addr('coin');
    vault.register(coin, array![alice(), bob(), payee()], array![3_333, 3_333, 3_334]);
    approve_as(currency, starknet::get_contract_address(), vault.contract_address);
    vault.deposit(coin, 1_000_001);
    let protocol_cut = 1_000_001 * 499 / 10_000; // 49_900
    let rest = 1_000_001 - protocol_cut;
    assert_eq!(vault.balance_of(coin, protocol()), protocol_cut);
    assert_eq!(vault.balance_of(coin, alice()), rest * 3_333 / 10_000);
    assert_eq!(vault.balance_of(coin, bob()), rest * 3_333 / 10_000);
    assert_eq!(
        vault.balance_of(coin, alice()) + vault.balance_of(coin, bob())
            + vault.balance_of(coin, payee()) + vault.balance_of(coin, protocol()),
        1_000_001,
    );
}

#[test]
fn vault_balances_are_kept_per_coin() {
    let currency = deploy_token("Stark stand-in", "STRK", 1_000 * ONE, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 0);
    vault.register(addr('coin-a'), array![alice()], array![10_000]);
    vault.register(addr('coin-b'), array![alice()], array![10_000]);
    approve_as(currency, starknet::get_contract_address(), vault.contract_address);
    vault.deposit(addr('coin-a'), 700);
    vault.deposit(addr('coin-b'), 300);
    assert_eq!(vault.balance_of(addr('coin-a'), alice()), 700);
    assert_eq!(vault.balance_of(addr('coin-b'), alice()), 300);
    start_cheat_caller_address(vault.contract_address, alice());
    assert_eq!(vault.claim(addr('coin-b')), 300);
    stop_cheat_caller_address(vault.contract_address);
    assert_eq!(vault.balance_of(addr('coin-a'), alice()), 700);
    assert_eq!(vault.balance_of(addr('coin-b'), alice()), 0);
}

#[test]
#[should_panic(expected: 'vault: coin already registered')]
fn payees_are_set_once() {
    let currency = deploy_token("Stark stand-in", "STRK", ONE, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 0);
    vault.register(addr('coin'), array![alice()], array![10_000]);
    vault.register(addr('coin'), array![bob()], array![10_000]);
}

#[test]
#[should_panic(expected: 'vault: shares must sum to 100%')]
fn payee_shares_must_sum_to_100_percent() {
    let currency = deploy_token("Stark stand-in", "STRK", ONE, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 0);
    vault.register(addr('coin'), array![alice(), bob()], array![5_000, 4_999]);
}

#[test]
#[should_panic(expected: 'vault: only the registrar')]
fn only_the_registrar_registers() {
    let currency = deploy_token("Stark stand-in", "STRK", ONE, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 0);
    start_cheat_caller_address(vault.contract_address, alice());
    vault.register(addr('coin'), array![alice()], array![10_000]);
}
