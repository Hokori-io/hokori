//! Integer arithmetic shared by the sale and pool contracts. Every rounding favors the reserves, never the
//! trader, and matches the reference model (`quantum-launchpad/sim/qlp.py`); the vector tests check it, and
//! independent invariant tests check the properties directly. All operations are checked: an overflow reverts
//! rather than wrapping.

use core::integer::{u512, u512_safe_div_rem_by_u256};
use core::num::traits::WideMul;
use crate::interfaces::CurveParams;

/// Basis points in 100%.
pub const BPS: u256 = 10_000;

/// Largest supported virtual currency reserve (2^96 base units, about 79 billion whole units) and largest
/// virtual token reserve / pool reserve (2^128 base units). With these bounds every product the contracts
/// form (k = v0 * t0, q * t, fee and pool arithmetic) stays far below 2^256.
pub const MAX_V0: u256 = 0x1000000000000000000000000;
pub const MAX_TOKENS: u256 = 0x100000000000000000000000000000000;
const TWO_64: u256 = 0x10000000000000000;
/// Sanity bound on every fee rate (10%), not a recommendation.
pub const MAX_FEE_BPS: u16 = 1000;
/// Bounds on the launch-window fee: at most 99%, for at most 10 blocks.
pub const MAX_SNIPER_FEE_BPS: u16 = 9900;
pub const MAX_SNIPER_BLOCKS: u64 = 10;

/// ceil(a / b). `b` must be non-zero.
pub fn ceil_div(a: u256, b: u256) -> u256 {
    assert(b != 0, 'math: division by zero');
    if a == 0 {
        return 0;
    }
    (a - 1) / b + 1
}

fn div512(n: u512, c: u256) -> (u256, u256) {
    let c: NonZero<u256> = c.try_into().expect('math: division by zero');
    let (q, r) = u512_safe_div_rem_by_u256(n, c);
    assert(q.limb2 == 0 && q.limb3 == 0, 'math: result overflows');
    (u256 { low: q.limb0, high: q.limb1 }, r)
}

/// floor(a * b / c) with a 512-bit intermediate product: it never overflows unless the result itself doesn't
/// fit in 256 bits (and then it reverts). Used wherever a product of two large amounts can occur.
pub fn mul_div(a: u256, b: u256, c: u256) -> u256 {
    let (q, _) = div512(a.wide_mul(b), c);
    q
}

/// ceil(a * b / c), with the same 512-bit intermediate.
pub fn mul_div_up(a: u256, b: u256, c: u256) -> u256 {
    let (q, r) = div512(a.wide_mul(b), c);
    if r == 0 {
        q
    } else {
        q + 1
    }
}

/// a * b >= c * d, compared exactly in 512 bits.
pub fn product_ge(a: u256, b: u256, c: u256, d: u256) -> bool {
    let l = a.wide_mul(b);
    let r = c.wide_mul(d);
    if l.limb3 != r.limb3 {
        return l.limb3 > r.limb3;
    }
    if l.limb2 != r.limb2 {
        return l.limb2 > r.limb2;
    }
    if l.limb1 != r.limb1 {
        return l.limb1 > r.limb1;
    }
    l.limb0 >= r.limb0
}

/// The fee on `amount` at `fee_bps`, rounded up (the payer never underpays a fee).
pub fn fee_up(amount: u256, fee_bps: u256) -> u256 {
    mul_div_up(amount, fee_bps, BPS)
}

/// How a curve ends and what its graduation seeds, as a pure function of its parameters.
#[derive(Copy, Drop, Debug, PartialEq)]
pub struct GraduationSeed {
    pub q_end: u256,
    pub t_end: u256,
    pub real: u256, // currency in the reserve when the curve closes
    pub grad_fee: u256,
    pub y: u256, // currency seeded into the pool
    pub x: u256 // tokens seeded into the pool
}

/// The curve closes only on a last buy that fills exactly the remaining tokens at the smallest spend that pays
/// for them, so it always closes at t = t0 - curve_tokens and q = ceil(k / t), whatever the path. Graduation's
/// outcome is therefore known when the curve is created, and checked then (see `check_curve_params`).
pub fn graduation_seed(p: @CurveParams) -> GraduationSeed {
    let t_end = *p.t0 - *p.curve_tokens;
    let q_end = ceil_div(*p.v0 * *p.t0, t_end);
    let real = q_end - *p.v0;
    let grad_fee = mul_div(real, (*p.grad_fee_bps).into(), BPS);
    let y = real - grad_fee;
    let x = mul_div(y, t_end, q_end);
    GraduationSeed { q_end, t_end, real, grad_fee, y, x }
}

/// Refuses parameters under which a sale could get stuck: out-of-range numbers, fees, or a graduation that
/// would seed an empty pool or need more tokens than are reserved for it.
pub fn check_curve_params(p: @CurveParams) {
    assert(*p.v0 > 0 && *p.v0 <= MAX_V0, 'curve: v0 out of range');
    assert(*p.t0 <= MAX_TOKENS, 'curve: t0 out of range');
    assert(*p.curve_tokens > 0 && *p.curve_tokens < *p.t0, 'curve: bad curve_tokens');
    assert(*p.x_reserve <= MAX_TOKENS, 'curve: x_reserve out of range');
    assert(*p.min_trade > 0, 'curve: min_trade is zero');
    assert(*p.fee_bps <= MAX_FEE_BPS, 'curve: fee too high');
    assert(*p.grad_fee_bps <= MAX_FEE_BPS, 'curve: grad fee too high');
    assert(*p.sniper_blocks <= MAX_SNIPER_BLOCKS, 'curve: sniper window too long');
    assert(
        *p.sniper_blocks == 0
            || (*p.sniper_fee_bps >= *p.fee_bps && *p.sniper_fee_bps <= MAX_SNIPER_FEE_BPS),
        'curve: bad sniper fee',
    );
    let g = graduation_seed(p);
    assert(g.x > 0 && g.y > 0, 'curve: pool would be empty');
    assert(g.x <= *p.x_reserve, 'curve: reserve too small');
    // Ekubo takes 128-bit amounts, and its prices cover about 2^-128..2^128; the pool's opening price stays
    // within 2^-64..2^64 so the locker computes it with ample precision.
    assert(g.x < MAX_TOKENS && g.y < MAX_TOKENS, 'curve: pool amounts too large');
    assert(g.y <= g.x * TWO_64 && g.x <= g.y * TWO_64, 'curve: pool price out of range');
}
