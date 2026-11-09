// Generated from the curve's reference vectors. Do not edit by hand.
// The contracts must reproduce the reference model exactly.
use launchpad::interfaces::IBondingCurveDispatcherTrait;
use openzeppelin_interfaces::erc20::IERC20DispatcherTrait;
use crate::common::*;

fn vector_params(x_reserve: u256) -> launchpad::interfaces::CurveParams {
    launchpad::interfaces::CurveParams {
        v0: 30000000000000000000,
        t0: 1073000000000000000000000000,
        curve_tokens: 793100000000000000000000000,
        x_reserve,
        min_trade: 1000000000000,
        fee_bps: 100,
        grad_fee_bps: 100,
        sniper_fee_bps: 9900,
        sniper_blocks: 2,
    }
}

#[test]
fn curve_steps_match_reference() {
    let s = setup_curve(vector_params(206886218069608574091572236));
    // step 1: buy
    let r = buy_as(@s, alice(), 1000000000000000000);
    assert_eq!(r.out, 34277831558567279767666989);
    assert_eq!(r.fee, 10000000000000000);
    assert_eq!(r.refund, 0);
    let st = s.curve.state();
    assert_eq!(st.q, 30990000000000000000);
    assert_eq!(st.t, 1038722168441432720232333011);
    assert_eq!(st.real, 990000000000000000);
    assert_eq!(st.fees, 10000000000000000);
    // step 2: buy
    let r = buy_as(@s, alice(), 3000000000000000007);
    assert_eq!(r.out, 90842309784188904145385989);
    assert_eq!(r.fee, 30000000000000001);
    assert_eq!(r.refund, 0);
    let st = s.curve.state();
    assert_eq!(st.q, 33960000000000000006);
    assert_eq!(st.t, 947879858657243816086947022);
    assert_eq!(st.real, 3960000000000000006);
    assert_eq!(st.fees, 40000000000000001);
    // step 3: sell
    let r = sell_as(@s, alice(), 41706713780918727971017659);
    assert_eq!(r.gross, 1431264367816091956);
    assert_eq!(r.fee, 14312643678160920);
    assert_eq!(r.paid, 1416951724137931036);
    let st = s.curve.state();
    assert_eq!(st.q, 32528735632183908050);
    assert_eq!(st.t, 989586572438162544057964681);
    assert_eq!(st.real, 2528735632183908050);
    assert_eq!(st.fees, 54312643678160921);
    // step 4: buy
    let r = buy_as(@s, alice(), 25000000000000000000);
    assert_eq!(r.out, 427597910420403049791511268);
    assert_eq!(r.fee, 250000000000000000);
    assert_eq!(r.refund, 0);
    let st = s.curve.state();
    assert_eq!(st.q, 57278735632183908050);
    assert_eq!(st.t, 561988662017759494266453413);
    assert_eq!(st.real, 27278735632183908050);
    assert_eq!(st.fees, 304312643678160921);
    // step 5: sell
    let r = sell_as(@s, alice(), 170337112660746835244515529);
    assert_eq!(r.gross, 13322888230620680645);
    assert_eq!(r.fee, 133228882306206807);
    assert_eq!(r.paid, 13189659348314473838);
    let st = s.curve.state();
    assert_eq!(st.q, 43955847401563227405);
    assert_eq!(st.t, 732325774678506329510968942);
    assert_eq!(st.real, 13955847401563227405);
    assert_eq!(st.fees, 437541525984367728);
    check_curve_balances(@s);
}

#[test]
fn graduation_matches_reference() {
    let s = setup_curve(vector_params(206886218069608574091572236));
    // Plain buys until the last one, which takes the curve's last tokens with buy_and_graduate and graduates in the
    // same call (a plain buy never graduates; buy_and_graduate is only for the last buy).
    let curve_tokens = s.curve.params().curve_tokens;
    while s.curve.state().open {
        if s.curve.quote_buy(37 * ONE).out == curve_tokens - s.curve.state().sold {
            buy_and_graduate_as(@s, alice(), 37 * ONE);
        } else {
            buy_as(@s, alice(), 37 * ONE);
        }
    }
    // The last buy graduated: the curve's closing state, and what it handed the locker for the Ekubo pool.
    let after = s.curve.state();
    assert!(after.graduated);
    assert_eq!(after.q, 115005359056806002144);
    assert_eq!(after.t, 279900000000000000000000000);
    assert_eq!(after.real, 0);
    let (x, y) = (s.token.balance_of(s.locker), s.currency.balance_of(s.locker));
    assert_eq!(x, 204817151071761416590310796);
    assert_eq!(y, 84155305466237942123);
    assert_eq!(s.token.total_supply(), 206886218069608574091572236 + 793100000000000000000000000 - 2069066997847157501261440);
    assert!(after.fees >= 850053590568060021);
    // Price continuity: the pool's y/x is never below the curve's final q/t, within one token unit.
    assert!(y * after.t >= x * after.q);
    assert!(y * after.t - x * after.q < after.q);
    // The curve keeps no tokens and exactly its unflushed fees in currency.
    assert_eq!(s.token.balance_of(s.curve.contract_address), 0);
    assert_eq!(s.currency.balance_of(s.curve.contract_address), after.fees);
}
