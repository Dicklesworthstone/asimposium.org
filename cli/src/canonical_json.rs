//! The canonical JSON codec shared with the Worker (bead asimposiumorg-phg).
//!
//! Byte-for-byte equal to `canonicalJson` in `@asimposium/contracts`, checked
//! against the shared golden vectors in
//! `packages/contracts/test/fixtures/canonical-json.vectors.json`:
//! object keys sort by UTF-16 code unit; strings, numbers, booleans and null
//! serialize exactly as ECMAScript `JSON.stringify` (numbers as IEEE-754
//! doubles in ECMAScript `Number::toString` form); no whitespace.

use serde_json::Value;

/// Canonical text of a parsed JSON value.
pub fn canonical_json(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

fn write_value(value: &Value, out: &mut String) -> Result<(), String> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            let double = number
                .as_f64()
                .ok_or_else(|| "canonical JSON numbers must be representable".to_string())?;
            out.push_str(&ecmascript_number(double)?);
        }
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_value(&map[key.as_str()], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// ECMAScript JSON.stringify string quoting (well-formed variant).
fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript Number::toString for finite doubles (the JSON.stringify form).
fn ecmascript_number(value: f64) -> Result<String, String> {
    if !value.is_finite() {
        return Err("canonical JSON numbers must be finite.".to_string());
    }
    if value == 0.0 {
        return Ok("0".to_string());
    }
    let negative = value < 0.0;
    // Rust's `{:e}` yields the shortest round-trip digits: "d[.ddd]e<exp>".
    let formatted = format!("{:e}", value.abs());
    let (mantissa, exponent) = formatted
        .split_once('e')
        .ok_or_else(|| "unexpected float format".to_string())?;
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // n: the position of the decimal point relative to the digit string.
    let n = exponent
        .parse::<i32>()
        .map_err(|_| "unexpected float exponent".to_string())?
        + 1;
    let body = if k <= n && n <= 21 {
        format!("{}{}", digits, "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let exp = (n - 1).abs();
        if k == 1 {
            format!("{}e{}{}", digits, sign, exp)
        } else {
            format!("{}.{}e{}{}", &digits[..1], &digits[1..], sign, exp)
        }
    };
    Ok(if negative { format!("-{}", body) } else { body })
}

#[cfg(test)]
mod tests {
    use super::ecmascript_number;

    #[test]
    fn ecmascript_number_forms() {
        for (value, expected) in [
            (1.0, "1"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (0.1, "0.1"),
            (2.5, "2.5"),
            (123.456, "123.456"),
            (-1.5e-9, "-1.5e-9"),
            (9007199254740993.0, "9007199254740992"),
        ] {
            assert_eq!(ecmascript_number(value).unwrap(), expected, "{value}");
        }
        assert!(ecmascript_number(f64::NAN).is_err());
    }
}
