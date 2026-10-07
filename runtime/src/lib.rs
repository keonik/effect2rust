//! effect_rt — the Rust side of effect2rust.
//!
//! Every function here mirrors one piece of Effect behavior that generated
//! servers rely on, down to error messages, so the Effect server can act as a
//! reference implementation in differential tests:
//!
//! - `Schema` decoding (`string`, `int`, `number_from_string`, refinements…)
//!   producing the same `ParseIssue`s (`_tag`, `path`, `message`)
//! - `HttpApi` body handling (JSON / urlencoded / text) and error responses
//! - `Effect.orDie` defects (`Die`) → empty 500
//! - JS number semantics (`Number(s)`, `Number.isSafeInteger`, `String(n)`)

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
pub use serde_json::{Map, Value};

// ─────────────────────────── Paths & issues ───────────────────────────

/// Allocation-free path to the value being decoded (a linked list on the stack).
/// Only materialized into a Vec when an issue is actually reported.
#[derive(Clone, Copy)]
pub struct Path<'a> {
    parent: Option<&'a Path<'a>>,
    key: Option<&'a str>,
}

impl<'a> Path<'a> {
    pub const ROOT: Path<'static> = Path { parent: None, key: None };

    pub fn key(&'a self, key: &'a str) -> Path<'a> {
        Path { parent: Some(self), key: Some(key) }
    }

    fn to_vec(self) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = Some(&self);
        while let Some(p) = cur {
            if let Some(k) = p.key {
                out.push(k.to_owned());
            }
            cur = p.parent;
        }
        out.reverse();
        out
    }
}

/// One `ParseResult` issue, serialized like `ArrayFormatter` output.
#[derive(Debug, Serialize)]
pub struct Issue {
    #[serde(rename = "_tag")]
    pub tag: &'static str,
    pub path: Vec<String>,
    pub message: String,
}

impl Issue {
    fn new(tag: &'static str, path: Path, message: String) -> Self {
        Issue { tag, path: path.to_vec(), message }
    }
}

/// `HttpApiDecodeError` → 400. Effect stops at the first issue by default, and so do we.
#[derive(Debug)]
pub struct DecodeError(pub Issue);

impl IntoResponse for DecodeError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct Body<'a> {
            issues: [&'a Issue; 1],
            message: &'a str,
            #[serde(rename = "_tag")]
            tag: &'static str,
        }
        let body = Body { issues: [&self.0], message: &self.0.message, tag: "HttpApiDecodeError" };
        (StatusCode::BAD_REQUEST, Json(body)).into_response()
    }
}

impl From<Issue> for DecodeError {
    fn from(i: Issue) -> Self {
        DecodeError(i)
    }
}

// ─────────────────────────── Defects (Effect.orDie) ───────────────────────────

/// A defect: an error that was turned into a die. Responds with an empty 500,
/// exactly like an Effect HttpApi handler that dies.
#[derive(Debug)]
pub struct Die(pub String);

impl IntoResponse for Die {
    fn into_response(self) -> Response {
        eprintln!("[defect] {}", self.0);
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

impl From<Issue> for Die {
    fn from(i: Issue) -> Self {
        Die(i.message)
    }
}

/// Encode a `Schema.Number` like `JSON.stringify`: integral values without a
/// fraction, non-finite values as `null`.
pub fn ser_number<S: serde::Serializer>(n: &f64, s: S) -> Result<S::Ok, S::Error> {
    if !n.is_finite() {
        s.serialize_none()
    } else if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        s.serialize_i64(*n as i64)
    } else {
        s.serialize_f64(*n)
    }
}

pub fn empty(status: StatusCode) -> Response {
    status.into_response()
}

// ─────────────────────────── Schema decoders ───────────────────────────

/// Struct / Class: the input must be a (non-array) object.
pub fn object<'v>(v: Option<&'v Value>, p: Path, expected: &str) -> Result<&'v Map<String, Value>, Issue> {
    match v {
        Some(Value::Object(m)) => Ok(m),
        Some(other) => Err(Issue::new("Type", p, format!("Expected {expected}, actual {}", format_unknown(other)))),
        None => Err(Issue::new("Missing", p, "is missing".into())),
    }
}

pub fn string(v: Option<&Value>, p: Path) -> Result<String, Issue> {
    match v {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(other) => Err(type_issue(p, "string", other)),
        None => Err(missing(p)),
    }
}

pub fn boolean(v: Option<&Value>, p: Path) -> Result<bool, Issue> {
    match v {
        Some(Value::Bool(b)) => Ok(*b),
        Some(other) => Err(type_issue(p, "boolean", other)),
        None => Err(missing(p)),
    }
}

/// `Schema.Number` — JS numbers are f64, so JSON numbers are read as f64.
pub fn number(v: Option<&Value>, p: Path) -> Result<f64, Issue> {
    match v {
        Some(Value::Number(n)) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        Some(other) => Err(type_issue(p, "number", other)),
        None => Err(missing(p)),
    }
}

/// `Schema.Int` = `Number.pipe(int())`.
pub fn int(v: Option<&Value>, p: Path) -> Result<i64, Issue> {
    let n = number(v, p)?;
    refine_int(n, p)
}

/// `Schema.NumberFromString` (via Effect's `Number.parse`).
pub fn number_from_string(v: Option<&Value>, p: Path) -> Result<f64, Issue> {
    let s = string(v, p)?;
    parse_js_number(&s).ok_or_else(|| {
        Issue::new("Transformation", p, format!("Unable to decode {} into a number", json_string(&s)))
    })
}

/// `Schema.int()` refinement: `Number.isSafeInteger`.
pub fn refine_int(n: f64, p: Path) -> Result<i64, Issue> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE {
        Ok(n as i64)
    } else {
        Err(Issue::new("Refinement", p, format!("Expected an integer, actual {}", js_number_to_string(n))))
    }
}

/// `Schema.minLength(n)` — JS string length counts UTF-16 code units.
pub fn refine_min_length(s: String, min: usize, p: Path) -> Result<String, Issue> {
    if s.encode_utf16().count() >= min {
        Ok(s)
    } else {
        Err(Issue::new(
            "Refinement",
            p,
            format!("Expected a string at least {min} character(s) long, actual {}", json_string(&s)),
        ))
    }
}

/// `Schema.maxLength(n)`.
pub fn refine_max_length(s: String, max: usize, p: Path) -> Result<String, Issue> {
    if s.encode_utf16().count() <= max {
        Ok(s)
    } else {
        Err(Issue::new(
            "Refinement",
            p,
            format!("Expected a string at most {max} character(s) long, actual {}", json_string(&s)),
        ))
    }
}

fn missing(p: Path) -> Issue {
    Issue::new("Missing", p, "is missing".into())
}

fn type_issue(p: Path, expected: &str, actual: &Value) -> Issue {
    Issue::new("Type", p, format!("Expected {expected}, actual {}", format_unknown(actual)))
}

// ─────────────────────────── HttpApi request bodies ───────────────────────────

/// How `HttpApi` reads a payload: JSON when the content type mentions json
/// (unparseable JSON → empty 400), urlencoded forms as records (repeated keys
/// become arrays), anything else as the raw text.
pub fn read_payload(headers: &HeaderMap, body: &[u8]) -> Result<Value, Response> {
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ct.contains("json") {
        serde_json::from_slice(body).map_err(|_| empty(StatusCode::BAD_REQUEST))
    } else if ct.starts_with("application/x-www-form-urlencoded") {
        let mut map = Map::new();
        for (k, v) in form_urlencoded::parse(body) {
            let v = Value::String(v.into_owned());
            match map.get_mut(k.as_ref()) {
                Some(Value::Array(arr)) => arr.push(v),
                Some(prev) => {
                    let first = prev.take();
                    *prev = Value::Array(vec![first, v]);
                }
                None => {
                    map.insert(k.into_owned(), v);
                }
            }
        }
        Ok(Value::Object(map))
    } else {
        Ok(Value::String(String::from_utf8_lossy(body).into_owned()))
    }
}

// ─────────────────────────── Database values ───────────────────────────

/// Bind a decoded `Schema.Int` (a JS safe integer) to an `int4` parameter.
/// Postgres would reject an out-of-range value at runtime, which Effect turns
/// into a defect; we reproduce that without the round trip.
pub fn int4(n: i64) -> Result<i32, Die> {
    i32::try_from(n).map_err(|_| Die(format!("value \"{n}\" is out of range for type integer")))
}

pub fn int2(n: i64) -> Result<i16, Die> {
    i16::try_from(n).map_err(|_| Die(format!("value \"{n}\" is out of range for type smallint")))
}

/// Convert a column value into the type its `Result` schema promises.
/// `SqlSchema` decodes rows with the schema; a mismatch (e.g. a NULL for a
/// non-nullable field) is a defect.
pub trait Col<T> {
    fn col(self, field: &str) -> Result<T, Die>;
}

macro_rules! col_impl {
    ($target:ty, $expected:literal: $($src:ty),+) => {$(
        impl Col<$target> for $src {
            #[inline]
            fn col(self, _field: &str) -> Result<$target, Die> { Ok(self.into()) }
        }
        impl Col<$target> for Option<$src> {
            #[inline]
            fn col(self, field: &str) -> Result<$target, Die> {
                self.map(Into::into)
                    .ok_or_else(|| Die(format!("[\"{field}\"]: Expected {}, actual null", $expected)))
            }
        }
    )+};
}

col_impl!(i64, "number": i16, i32, i64);
col_impl!(f64, "number": f32, f64, i16, i32);
col_impl!(String, "string": String);
col_impl!(bool, "boolean": bool);

// ─────────────────────────── JS semantics ───────────────────────────

/// Effect's `Number.parse`: "NaN" / "Infinity" / "-Infinity" literals,
/// blank → none, otherwise `Number(s)`, NaN → none.
pub fn parse_js_number(s: &str) -> Option<f64> {
    match s {
        "NaN" => return Some(f64::NAN),
        "Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let t = s.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return None;
    }
    js_number_ctor(t)
}

/// `Number(t)` for an already-trimmed, non-empty string (StringNumericLiteral).
fn js_number_ctor(t: &str) -> Option<f64> {
    let radix = |digits: &str, base: u32| -> Option<f64> {
        if digits.is_empty() {
            return None;
        }
        digits.chars().try_fold(0f64, |acc, c| c.to_digit(base).map(|d| acc * base as f64 + d as f64))
    };
    let lower = t.get(..2).map(str::to_ascii_lowercase);
    match lower.as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return Some(sign * f64::INFINITY);
    }
    // StrUnsignedDecimalLiteral: digits [. digits] [exp] | . digits [exp]
    let b = body.as_bytes();
    let mut i = 0;
    let int_digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        frac_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac_digits;
    }
    if int_digits == 0 && frac_digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp_digits == 0 {
            return None;
        }
        i += exp_digits;
    }
    if i != b.len() {
        return None;
    }
    // Rust's parser accepts this grammar (incl. "1." and ".5").
    body.parse::<f64>().ok().map(|n| sign * n)
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' | '\u{000A}' | '\u{000B}' | '\u{000C}' | '\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
            | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// ECMAScript `Number.prototype.toString()` (shortest round-trip, JS exponent rules).
pub fn js_number_to_string(n: f64) -> String {
    let mut buf = ryu_js::Buffer::new();
    buf.format(n).to_owned()
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).expect("strings always serialize")
}

/// Effect's `Inspectable.formatUnknown` for JSON values.
pub fn format_unknown(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => json_string(s),
        Value::Array(a) => format!("[{}]", a.iter().map(format_unknown).collect::<Vec<_>>().join(",")),
        Value::Object(m) => format!(
            "{{{}}}",
            m.iter().map(|(k, v)| format!("{}:{}", json_string(k), format_unknown(v))).collect::<Vec<_>>().join(",")
        ),
    }
}

// ─────────────────────────── Tests ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_parse_matches_effect() {
        let ok = [("1", 1.0), (" 1", 1.0), ("1e2", 100.0), ("0x10", 16.0), ("0b11", 3.0), ("+5", 5.0), ("1.", 1.0), (".5", 0.5)];
        for (s, n) in ok {
            assert_eq!(parse_js_number(s), Some(n), "{s}");
        }
        for s in ["abc", " ", "", "1_0", "-0x10", "0x", "1e", "inf", "infinity", "nan"] {
            assert_eq!(parse_js_number(s), None, "{s}");
        }
        assert!(parse_js_number("NaN").unwrap().is_nan());
        assert_eq!(parse_js_number("-Infinity"), Some(f64::NEG_INFINITY));
    }

    #[test]
    fn number_format_matches_js() {
        assert_eq!(js_number_to_string(1.5), "1.5");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(2f64.powi(60)), "1152921504606847000");
        assert_eq!(js_number_to_string(f64::NAN), "NaN");
        assert_eq!(js_number_to_string(f64::INFINITY), "Infinity");
    }

    #[test]
    fn format_unknown_matches_effect() {
        let v: Value = serde_json::from_str(r#"{"a":[1,"x"]}"#).unwrap();
        assert_eq!(format_unknown(&v), r#"{"a":[1,"x"]}"#);
        assert_eq!(format_unknown(&Value::String("{\"t\":1}".into())), r#""{\"t\":1}""#);
    }
}
