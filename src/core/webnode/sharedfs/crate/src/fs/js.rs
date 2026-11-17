//! JavaScript's number semantics, for the arguments that arrive as `f64`
//! exactly as the TypeScript filesystem received them. Written with plain
//! arithmetic: `core` has no `trunc`/`floor` on stable, and a libm call would
//! become an import of the module.

/// 2^52: from here on every `f64` is an integer.
const INTEGRAL: f64 = 4503599627370496.0;

/// `Math.trunc`.
pub fn trunc(x: f64) -> f64 {
    if x.is_finite() && x < INTEGRAL && x > -INTEGRAL {
        (x as i64) as f64
    } else {
        x
    }
}

/// `Math.floor`.
pub fn floor(x: f64) -> f64 {
    let truncated = trunc(x);
    if truncated > x {
        truncated - 1.0
    } else {
        truncated
    }
}

/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && trunc(x) == x
}

/// ToInt32, what `x | 0` and `x & mask` apply to a number: the integer part
/// modulo 2^32, read as signed.
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let bits = x.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    // |x| = mantissa * 2^exponent, exactly.
    let (mantissa, exponent) = if biased == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1u64 << 52), biased - 1075)
    };
    let magnitude = if exponent >= 32 {
        0
    } else if exponent >= 0 {
        (mantissa << exponent) as u32
    } else if exponent > -64 {
        (mantissa >> -exponent) as u32
    } else {
        0
    };
    let value = if x < 0.0 {
        magnitude.wrapping_neg()
    } else {
        magnitude
    };
    value as i32
}
