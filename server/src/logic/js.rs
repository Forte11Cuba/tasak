//! JavaScript's rules where Rust's differ, so both implementations read the same texts the same way.

/// JavaScript's `\s` and `String.prototype.trim()`: its WhiteSpace and LineTerminator characters.
/// Not `char::is_whitespace`, which includes U+0085 and leaves out U+FEFF.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `Number(text)`: blank is 0; decimal (sign, fraction, exponent), 0x/0o/0b or Infinity; else NaN.
/// `None` is `Number(undefined)`, NaN.
pub fn number(text: Option<&str>) -> f64 {
    let Some(text) = text else { return f64::NAN };
    let s = text.trim_matches(is_js_space);
    if s.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = s.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits
                .chars()
                .fold(0.0, |n, c| n * radix as f64 + c.to_digit(radix).unwrap() as f64);
        }
    }
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    if unsigned == "Infinity" {
        return if s.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust also reads "inf" and "nan", which JavaScript doesn't
    let valid = unsigned.starts_with(|c: char| c.is_ascii_digit() || c == '.')
        && unsigned
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if valid { s.parse().unwrap_or(f64::NAN) } else { f64::NAN }
}

/// Truthiness of a number: not 0 and not NaN
pub fn truthy(n: f64) -> bool {
    n != 0.0 && !n.is_nan()
}

/// `Math.max(a, b)`: NaN if either is (Rust's `f64::max` would ignore it)
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// `Math.min(a, b)`
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// Length in UTF-16 code units, as JavaScript's `.length`
pub fn len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JavaScript's comparison of strings (`<`, default `sort()`): by UTF-16 code units
pub fn cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `x.toFixed(digits)`: rounded on the exact decimal value of the double, ties up (away from zero).
/// Not `format!("{x:.2}")`, which rounds ties to even: 763.125 is "763.13" in JavaScript, "763.12" in Rust
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x < 0.0 {
        return format!("-{}", to_fixed(-x, digits));
    }
    if x.is_infinite() || x >= 1e21 {
        return format!("{x}");
    }
    // Every double has a finite decimal expansion, at most 1074 digits after the point
    // abs: -0.0 is not < 0, and JavaScript writes it without the sign
    let exact = format!("{:.1074}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap();
    let mut kept: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    if frac.as_bytes()[digits] >= b'5' {
        // Add one to the last kept digit, carrying
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let point = kept.len() - digits;
    let (int, frac) = kept.split_at(point);
    let int = String::from_utf8(int.to_vec()).unwrap();
    if digits == 0 {
        int
    } else {
        format!("{int}.{}", String::from_utf8(frac.to_vec()).unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_reads_like_javascript() {
        for (text, n) in [
            (" 12 ", 12.0),
            ("", 0.0),
            ("1e3", 1000.0),
            ("-1.5", -1.5),
            (".5", 0.5),
            ("5.", 5.0),
            ("+7", 7.0),
            ("0x10", 16.0),
            ("0b11", 3.0),
            ("Infinity", f64::INFINITY),
        ] {
            assert_eq!(number(Some(text)), n, "{text:?}");
        }
        for text in ["abc", "inf", "nan", "1_000", "0x", "1e", "--1", "12px"] {
            assert!(number(Some(text)).is_nan(), "{text:?}");
        }
        assert!(number(None).is_nan());
    }

    #[test]
    fn to_fixed_rounds_like_javascript() {
        for (x, digits, text) in [
            (763.125, 2, "763.13"),
            (1.005, 2, "1.00"), // 1.005 is 1.00499999999999989… as a double
            (0.5, 0, "1"),
            (2.5, 0, "3"),
            (-1.5, 0, "-2"),
            (9.995, 2, "9.99"),
            (99.996, 2, "100.00"),
            (0.0, 2, "0.00"),
            (-0.0, 1, "0.0"),
            (1234.5678, 3, "1234.568"),
        ] {
            assert_eq!(to_fixed(x, digits), text, "{x}");
        }
    }
}
