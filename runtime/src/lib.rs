//! effect_rt: the Rust side of effect2rust, for Effect 4.
//!
//! Every piece here mirrors behavior that an Effect 4 HttpApi server on Bun has, so the
//! Effect program can serve as the reference implementation in differential tests:
//!
//! - [`Router`]: a port of the find-my-way router Effect's HttpRouter uses (case-insensitive,
//!   trailing / duplicate slashes ignored, `decodeURI` semantics, 100-char params, HEAD → GET)
//! - [`read_json_body`]: HttpApiBuilder's payload handling (content-type normalization, 415,
//!   TextDecoder + JSON.parse semantics)
//! - JSON / path-parameter decoders matching Schema's JSON and StringTree codecs
//! - [`Sql`]: parameters typed by value exactly like @effect/sql-pg's driver
//!   (int4 / int8 / float8 / bool, strings untyped), and column decoding like its row parser
//! - [`ser_number`]: numbers encoded like JSON.stringify (non-finite as strings)

use std::{future::Future, sync::Arc};

pub use axum::{
    body::Bytes,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use axum::{
    extract::{DefaultBodyLimit, Request},
    http::{header, HeaderValue, Method},
};
use serde::Serialize;
pub use serde_json::{Map, Value};
pub use sqlx::postgres::{PgPool, PgRow};
use sqlx::{postgres::PgArguments, Arguments, Column, Row, TypeInfo};

// ═══════════════════════════ Decoding ═══════════════════════════

/// A decode failure. HttpApi answers every decode failure with an empty 400.
#[derive(Debug, Clone, Copy)]
pub struct Invalid;

/// `String.prototype.length`: UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A Struct / Class is decoded from a (non-array) object; extra keys are ignored.
pub fn json_object(v: Option<&Value>) -> Result<&Map<String, Value>, Invalid> {
    match v {
        Some(Value::Object(m)) => Ok(m),
        _ => Err(Invalid),
    }
}

pub fn json_string(v: Option<&Value>) -> Result<String, Invalid> {
    match v {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(Invalid),
    }
}

pub fn json_bool(v: Option<&Value>) -> Result<bool, Invalid> {
    match v {
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(Invalid),
    }
}

fn json_f64(n: &serde_json::Number) -> f64 {
    // arbitrary_precision keeps the source text; Rust's parser rounds like JSON.parse
    // (correctly rounded, overflow → ±Infinity).
    n.as_str().parse::<f64>().unwrap_or(f64::NAN)
}

/// `Schema.Number` on the JSON codec: a JSON number, or "NaN" / "Infinity" / "-Infinity"
/// unless the schema is finite. Finite / Int accept JSON numbers only.
pub fn json_number(v: Option<&Value>, finite: bool) -> Result<f64, Invalid> {
    match v {
        Some(Value::Number(n)) => Ok(json_f64(n)),
        Some(Value::String(s)) if !finite => match s.as_str() {
            "NaN" => Ok(f64::NAN),
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            _ => Err(Invalid),
        },
        _ => Err(Invalid),
    }
}

/// `Schema.Int`: a JSON number that is a safe integer.
pub fn json_int(v: Option<&Value>) -> Result<i64, Invalid> {
    match v {
        Some(Value::Number(n)) => to_int(json_f64(n)),
        _ => Err(Invalid),
    }
}

/// `Schema.isInt()`: `Number.isSafeInteger`.
pub fn to_int(n: f64) -> Result<i64, Invalid> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE {
        Ok(n as i64)
    } else {
        Err(Invalid)
    }
}

/// StringTree codec for finite numbers (Int / Finite / numbers with checks):
/// `^[+-]?\d*\.?\d+(?:[Ee][+-]?\d+)?$`, then `Number(s)`.
pub fn param_finite(s: &str) -> Result<f64, Invalid> {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int_digits = digits(i);
    i += int_digits;
    if i < b.len() && b[i] == b'.' {
        let frac = digits(i + 1);
        if frac == 0 {
            return Err(Invalid); // `\d*\.?\d+`: a dot must be followed by digits
        }
        i += 1 + frac;
    } else if int_digits == 0 {
        return Err(Invalid);
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp = digits(i);
        if exp == 0 {
            return Err(Invalid);
        }
        i += exp;
    }
    if i != b.len() {
        return Err(Invalid);
    }
    Ok(js_number(s))
}

/// StringTree codec for `Schema.Number` (no finite check): finite pattern or NaN / ±Infinity.
pub fn param_number(s: &str) -> Result<f64, Invalid> {
    match s {
        "NaN" => Ok(f64::NAN),
        "Infinity" => Ok(f64::INFINITY),
        "-Infinity" => Ok(f64::NEG_INFINITY),
        _ => param_finite(s),
    }
}

/// StringTree codec for booleans.
pub fn param_bool(s: &str) -> Result<bool, Invalid> {
    match s {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(Invalid),
    }
}

/// JavaScript `Number(s)` (used by `Schema.NumberFromString`).
pub fn js_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, base: u32| -> f64 {
        if digits.is_empty() {
            return f64::NAN;
        }
        digits
            .chars()
            .try_fold(0f64, |acc, c| c.to_digit(base).map(|d| acc * base as f64 + d as f64))
            .unwrap_or(f64::NAN)
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
        return sign * f64::INFINITY;
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
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp_digits == 0 {
            return f64::NAN;
        }
        i += exp_digits;
    }
    if i != b.len() {
        return f64::NAN;
    }
    body.parse::<f64>().map(|n| sign * n).unwrap_or(f64::NAN)
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' | '\u{000A}' | '\u{000B}' | '\u{000C}' | '\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
            | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

// ═══════════════════════════ Encoding ═══════════════════════════

/// Encode a number like Schema's JSON codec + JSON.stringify: finite numbers in JS
/// formatting (`1e+21`, `0.1`), non-finite numbers as the strings "NaN" / "Infinity".
pub fn ser_number<S: serde::Serializer>(n: &f64, s: S) -> Result<S::Ok, S::Error> {
    if n.is_finite() {
        let mut buf = ryu_js::Buffer::new();
        let text = buf.format(*n).to_owned();
        serde_json::value::RawValue::from_string(text).map_err(serde::ser::Error::custom)?.serialize(s)
    } else {
        s.serialize_str(if n.is_nan() { "NaN" } else if *n > 0.0 { "Infinity" } else { "-Infinity" })
    }
}

pub fn ser_opt_number<S: serde::Serializer>(n: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match n {
        Some(n) => ser_number(n, s),
        None => s.serialize_none(),
    }
}

// ═══════════════════════════ Responses ═══════════════════════════

pub fn empty(status: u16) -> Response {
    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR).into_response()
}

pub fn json<T: Serialize>(status: u16, v: &T) -> Response {
    match serde_json::to_vec(v) {
        Ok(body) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
            [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
            body,
        )
            .into_response(),
        Err(e) => Die(format!("encoding failed: {e}")).into_response(),
    }
}

/// A defect: an empty 500, like an HttpApi handler that dies.
#[derive(Debug)]
pub struct Die(pub String);

impl IntoResponse for Die {
    fn into_response(self) -> Response {
        eprintln!("[defect] {}", self.0);
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

// ═══════════════════════════ Request bodies ═══════════════════════════

/// HttpApiBuilder's JSON payload handling:
/// - content type: header value lowercased, parameters dropped; missing → application/json;
///   anything else → 415 "Unsupported content-type: <type>"
/// - body text: UTF-8 with replacement characters and the BOM stripped (TextDecoder)
/// - "" → no value (the schema then rejects it); invalid JSON → 400
pub fn read_json_body(headers: &HeaderMap, body: &[u8]) -> Result<Option<Value>, Response> {
    let content_type = match headers.get(header::CONTENT_TYPE) {
        None => "application/json".to_owned(),
        Some(v) => {
            let raw = String::from_utf8_lossy(v.as_bytes()).to_lowercase();
            let raw = raw.trim();
            raw.split(';').next().unwrap_or("").trim().to_owned()
        }
    };
    if content_type != "application/json" {
        let mut resp = format!("Unsupported content-type: {content_type}").into_response();
        *resp.status_mut() = StatusCode::UNSUPPORTED_MEDIA_TYPE;
        return Err(resp);
    }
    let text = String::from_utf8_lossy(body);
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    if text.is_empty() {
        return Ok(None);
    }
    parse_json(text).map(Some).map_err(|_| empty(400))
}

/// `JSON.parse`: like serde_json, except that lone UTF-16 surrogate escapes are accepted
/// (they become U+FFFD when the string reaches UTF-8, as they do in the JS driver).
pub fn parse_json(text: &str) -> Result<Value, Invalid> {
    match serde_json::from_str(text) {
        Ok(v) => Ok(v),
        Err(_) if text.contains("\\u") => serde_json::from_str(&replace_lone_surrogates(text)).map_err(|_| Invalid),
        Err(_) => Err(Invalid),
    }
}

/// Rewrite `\uD800`-style escapes that don't form a surrogate pair to `�`.
fn replace_lone_surrogates(text: &str) -> String {
    let b = text.as_bytes();
    let hex4 = |i: usize| -> Option<u16> {
        let s = text.get(i..i + 4)?;
        u16::from_str_radix(s, 16).ok().filter(|_| s.bytes().all(|c| c.is_ascii_hexdigit()))
    };
    let mut out = String::with_capacity(text.len());
    let (mut i, mut in_string, mut last) = (0, false, 0);
    while i < b.len() {
        match b[i] {
            b'"' => {
                in_string = !in_string;
                i += 1;
            }
            b'\\' if in_string => {
                if b.get(i + 1) == Some(&b'u') {
                    if let Some(cu) = hex4(i + 2) {
                        let is_high = (0xD800..0xDC00).contains(&cu);
                        let is_low = (0xDC00..0xE000).contains(&cu);
                        let paired = is_high && b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex4(i + 8).is_some_and(|n| (0xDC00..0xE000).contains(&n));
                        if paired {
                            i += 12;
                            continue;
                        }
                        if is_high || is_low {
                            out.push_str(&text[last..i]);
                            out.push_str("\\uFFFD");
                            i += 6;
                            last = i;
                            continue;
                        }
                    }
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    out.push_str(&text[last..]);
    out
}

// ═══════════════════════════ Routing (find-my-way) ═══════════════════════════

#[derive(Debug, Clone, Copy)]
pub struct RouterConfig {
    pub case_sensitive: bool,
    pub ignore_trailing_slash: bool,
    pub ignore_duplicate_slashes: bool,
    pub max_param_length: usize,
}

impl Default for RouterConfig {
    fn default() -> Self {
        RouterConfig { case_sensitive: false, ignore_trailing_slash: true, ignore_duplicate_slashes: true, max_param_length: 100 }
    }
}

#[derive(Debug)]
enum Seg {
    Static(String),
    Param,
}

#[derive(Debug)]
struct Route {
    method: String,
    segs: Vec<Seg>,
}

pub struct Router {
    cfg: RouterConfig,
    routes: Vec<Route>,
}

impl Router {
    /// Routes as (METHOD, "/path/:param") in handler order.
    pub fn new(cfg: RouterConfig, routes: &[(&str, &str)]) -> Router {
        let routes = routes
            .iter()
            .map(|(method, path)| {
                let path = if cfg.ignore_trailing_slash && path.len() > 1 { path.trim_end_matches('/') } else { path };
                let segs = path
                    .split('/')
                    .skip(1)
                    .map(|s| {
                        if s.starts_with(':') {
                            Seg::Param
                        } else if cfg.case_sensitive {
                            Seg::Static(s.to_owned())
                        } else {
                            Seg::Static(s.to_lowercase())
                        }
                    })
                    .collect();
                Route { method: method.to_string(), segs }
            })
            .collect();
        Router { cfg, routes }
    }

    /// Find the route for a request target (path + optional query). HEAD falls back to GET.
    pub fn find(&self, method: &str, url: &str) -> Option<(usize, Vec<String>)> {
        let (lookup, origin, decode_params) = sanitize(url, &self.cfg)?;
        let lookup_segs: Vec<&str> = lookup.split('/').skip(1).collect();
        let origin_segs: Vec<&str> = origin.split('/').skip(1).collect();
        let try_method = |m: &str| self.match_method(m, &lookup_segs, &origin_segs, decode_params);
        try_method(method).or_else(|| if method == "HEAD" { try_method("GET") } else { None })
    }

    fn match_method(&self, method: &str, lookup: &[&str], origin: &[&str], decode_params: bool) -> Option<(usize, Vec<String>)> {
        let mut best: Option<(usize, Vec<String>, Vec<bool>)> = None;
        'routes: for (idx, r) in self.routes.iter().enumerate() {
            if r.method != method || r.segs.len() != lookup.len() || lookup.len() != origin.len() {
                continue;
            }
            let mut params = Vec::new();
            let mut kinds = Vec::with_capacity(r.segs.len());
            for (i, seg) in r.segs.iter().enumerate() {
                match seg {
                    Seg::Static(s) => {
                        if s != lookup[i] {
                            continue 'routes;
                        }
                        kinds.push(false);
                    }
                    Seg::Param => {
                        if lookup[i].is_empty() {
                            continue 'routes;
                        }
                        let raw = origin[i];
                        let value = if decode_params { safe_decode_uri_component(raw) } else { raw.to_owned() };
                        if utf16_len(&value) > self.cfg.max_param_length {
                            continue 'routes;
                        }
                        params.push(value);
                        kinds.push(true);
                    }
                }
            }
            // Static segments win over parameters at the first position where routes differ.
            if best.as_ref().map_or(true, |(_, _, k)| kinds < *k) {
                best = Some((idx, params, kinds));
            }
        }
        best.map(|(i, p, _)| (i, p))
    }
}

/// find-my-way's path normalization: returns (lookup path, original-case path, decode params?).
fn sanitize(url: &str, cfg: &RouterConfig) -> Option<(String, String, bool)> {
    let b = url.as_bytes();
    let clean = b.first() == Some(&b'/')
        && (b.len() == 1 || b[b.len() - 1] != b'/')
        && !b.iter().enumerate().skip(1).any(|(i, &c)| matches!(c, b'%' | b'?' | b';' | b'#' | b'A'..=b'Z') || (c == b'/' && b[i - 1] == b'/'));
    if clean {
        return Some((url.to_owned(), url.to_owned(), false));
    }
    let mut path = url.to_owned();
    if !path.starts_with('/') {
        // /^https?:\/\/.*?\//
        let lower = path.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            let start = path.find("://").unwrap() + 3;
            if let Some(slash) = path[start..].find('/') {
                path = format!("/{}", &path[start + slash + 1..]);
            }
        }
    }
    if cfg.ignore_duplicate_slashes {
        while path.contains("//") {
            path = path.replace("//", "/");
        }
    }
    let (mut path, decode_params) = safe_decode_uri(path)?;
    if cfg.ignore_trailing_slash && path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    let lookup = if cfg.case_sensitive { path.clone() } else { path.to_lowercase() };
    Some((lookup, path, decode_params))
}

/// Characters where decodeURIComponent and decodeURI differ: # $ & + , / : ; = ? @ (and %).
fn decode_component_char(high: Option<u8>, low: Option<u8>) -> Option<char> {
    match (high?, low?) {
        (b'2', b'5') => Some('%'),
        (b'2', b'3') => Some('#'),
        (b'2', b'4') => Some('$'),
        (b'2', b'6') => Some('&'),
        (b'2', b'B' | b'b') => Some('+'),
        (b'2', b'C' | b'c') => Some(','),
        (b'2', b'F' | b'f') => Some('/'),
        (b'3', b'A' | b'a') => Some(':'),
        (b'3', b'B' | b'b') => Some(';'),
        (b'3', b'D' | b'd') => Some('='),
        (b'3', b'F' | b'f') => Some('?'),
        (b'4', b'0') => Some('@'),
        _ => None,
    }
}

/// find-my-way's safeDecodeURI: strip the query (`?`, `;`, `#`), decodeURI when needed.
/// None when decodeURI would throw (the route is then not found).
fn safe_decode_uri(path: String) -> Option<(String, bool)> {
    let mut path = path;
    let (mut should_decode, mut should_decode_param) = (false, false);
    let mut i = 1;
    while i < path.len() {
        let b = path.as_bytes();
        let c = b[i];
        if c == b'%' {
            let (high, low) = (b.get(i + 1).copied(), b.get(i + 2).copied());
            if decode_component_char(high, low).is_none() {
                should_decode = true;
            } else {
                should_decode_param = true;
                if high == Some(b'2') && low == Some(b'5') {
                    should_decode = true;
                    path.insert_str(i + 1, "25");
                    i += 2;
                }
                i += 2;
            }
        } else if c == b'?' || c == b';' || c == b'#' {
            path.truncate(i);
            break;
        }
        i += 1;
    }
    let decoded = if should_decode { js_decode_uri(&path)? } else { path };
    Some((decoded, should_decode_param))
}

/// JavaScript `decodeURI`: decodes UTF-8 escapes, keeps escapes of reserved characters,
/// None on malformed input (URIError).
pub fn js_decode_uri(s: &str) -> Option<String> {
    const RESERVED: &[u8] = b";/?:@&=+$,#";
    let b = s.as_bytes();
    let hex = |i: usize| -> Option<u8> {
        let h = b.get(i..i + 2)?;
        if !h.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()
    };
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let first = hex(i + 1)?;
        if first < 0x80 {
            if RESERVED.contains(&first) {
                out.extend_from_slice(&b[i..i + 3]);
            } else {
                out.push(first);
            }
            i += 3;
            continue;
        }
        let n = match first {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut bytes = vec![first];
        let mut j = i + 3;
        for _ in 1..n {
            if b.get(j) != Some(&b'%') {
                return None;
            }
            let cont = hex(j + 1)?;
            if cont & 0xC0 != 0x80 {
                return None;
            }
            bytes.push(cont);
            j += 3;
        }
        // Rejects overlong forms, surrogates and > U+10FFFF, like the spec's Decode.
        let ch = std::str::from_utf8(&bytes).ok()?;
        out.extend_from_slice(ch.as_bytes());
        i = j;
    }
    String::from_utf8(out).ok()
}

/// find-my-way's safeDecodeURIComponent (decodes only the reserved escapes; a trailing
/// partial escape stops decoding; unknown escapes become "undefined", as in the original).
fn safe_decode_uri_component(s: &str) -> String {
    let Some(start) = s.find('%') else { return s.to_owned() };
    let b = s.as_bytes();
    let mut decoded = String::new();
    let mut last = start;
    let mut i = start;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                break;
            }
            decoded.push_str(&s[last..i]);
            match decode_component_char(b.get(i + 1).copied(), b.get(i + 2).copied()) {
                Some(c) => decoded.push(c),
                None => decoded.push_str("undefined"),
            }
            last = i + 3;
        }
        i += 1;
    }
    format!("{}{}{}", &s[..start], decoded, &s[last.min(s.len())..])
}

// ═══════════════════════════ Server ═══════════════════════════

/// Serve every request through the router. `hostname` None listens on `::` (falling back
/// to 0.0.0.0 where IPv6 isn't available), like Bun's default.
pub async fn serve<C, F, Fut>(hostname: Option<&str>, port: u16, router: Router, ctx: C, handle: F)
where
    C: Send + Sync + 'static,
    F: Fn(Arc<C>, usize, Vec<String>, HeaderMap, Bytes) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Response> + Send + 'static,
{
    let router = Arc::new(router);
    let ctx = Arc::new(ctx);
    let app = axum::Router::new()
        .fallback(move |req: Request| {
            let (router, ctx, handle) = (router.clone(), ctx.clone(), handle.clone());
            async move {
                let (parts, body) = req.into_parts();
                let target = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
                let Some((route, params)) = router.find(parts.method.as_str(), target) else {
                    return empty(404);
                };
                let body = if parts.method == Method::GET || parts.method == Method::HEAD {
                    Bytes::new()
                } else {
                    match axum::body::to_bytes(body, usize::MAX).await {
                        Ok(b) => b,
                        Err(_) => return empty(400),
                    }
                };
                handle(ctx, route, params, parts.headers, body).await
            }
        })
        .layer(DefaultBodyLimit::disable());

    let listener = match hostname {
        Some(h) => tokio::net::TcpListener::bind((h, port)).await,
        None => match tokio::net::TcpListener::bind(("::", port)).await {
            Ok(l) => Ok(l),
            Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", port)).await,
        },
    }
    .unwrap_or_else(|e| {
        eprintln!("failed to listen on port {port}: {e}");
        std::process::exit(1)
    });
    let addr = listener.local_addr().map(|a| a.to_string()).unwrap_or_default();
    println!("Listening on http://{addr}");
    axum::serve(listener, app).await.expect("server");
}

// ═══════════════════════════ SQL ═══════════════════════════

/// A lazily connecting pool (connections open on first use, like PgClient's pool).
pub fn pool(url: &str, max_connections: u32) -> PgPool {
    sqlx::postgres::PgPoolOptions::new().max_connections(max_connections).connect_lazy(url).unwrap_or_else(|e| {
        eprintln!("invalid database url: {e}");
        std::process::exit(1)
    })
}

/// What a query can fail with: the SqlError and SchemaError of `effect/sql`.
#[derive(Debug)]
pub enum SqlFailure {
    Sql(String),
    Schema(String),
}

impl SqlFailure {
    pub fn schema(field: &str) -> SqlFailure {
        SqlFailure::Schema(format!("row field \"{field}\" doesn't match its schema"))
    }
}

/// A statement whose parameters are typed by value, like @effect/sql-pg's driver:
/// integers in int32 range → int4, other safe integers → int8, other numbers → float8,
/// booleans → bool, strings untyped (Postgres infers them; expressed as `$n::text::<type>`).
/// Each combination is its own SQL text, so prepared statements are cached per shape.
pub struct Sql {
    sql: String,
    args: PgArguments,
    parts: &'static [&'static str],
    n: usize,
}

impl Sql {
    pub fn new(parts: &'static [&'static str]) -> Sql {
        Sql { sql: parts[0].to_owned(), args: PgArguments::default(), parts, n: 0 }
    }

    fn push(&mut self, cast: &str) {
        self.n += 1;
        self.sql.push('$');
        self.sql.push_str(&self.n.to_string());
        self.sql.push_str(cast);
        self.sql.push_str(self.parts[self.n]);
    }

    pub fn int(&mut self, v: i64) {
        if (i32::MIN as i64..=i32::MAX as i64).contains(&v) {
            self.args.add(v as i32).expect("bind");
            self.push("::int4");
        } else {
            self.args.add(v).expect("bind");
            self.push("::int8");
        }
    }

    pub fn number(&mut self, v: f64) {
        if v.is_finite() && v.fract() == 0.0 {
            if v >= i32::MIN as f64 && v <= i32::MAX as f64 {
                return self.int(v as i64);
            }
            if v.abs() <= 9_007_199_254_740_991.0 {
                self.args.add(v as i64).expect("bind");
                return self.push("::int8");
            }
        }
        self.args.add(v).expect("bind");
        self.push("::float8");
    }

    pub fn bool(&mut self, v: bool) {
        self.args.add(v).expect("bind");
        self.push("::bool");
    }

    /// `pg_type` is the type Postgres infers for this parameter ("" when it's text).
    pub fn string(&mut self, v: &str, pg_type: &str) {
        self.args.add(v.to_owned()).expect("bind");
        if pg_type.is_empty() {
            self.push("");
        } else {
            self.push(&format!("::text::{pg_type}"));
        }
    }

    pub fn null(&mut self, pg_type: &str) {
        self.args.add(None::<String>).expect("bind");
        self.push(&format!("::text::{pg_type}"));
    }

    pub async fn fetch_optional(self, db: &PgPool) -> Result<Option<PgRow>, SqlFailure> {
        sqlx::query_with(&self.sql, self.args).fetch_optional(db).await.map_err(sql_failure)
    }

    pub async fn fetch_all(self, db: &PgPool) -> Result<Vec<PgRow>, SqlFailure> {
        sqlx::query_with(&self.sql, self.args).fetch_all(db).await.map_err(sql_failure)
    }

    pub async fn execute(self, db: &PgPool) -> Result<(), SqlFailure> {
        sqlx::query_with(&self.sql, self.args).execute(db).await.map(|_| ()).map_err(sql_failure)
    }
}

fn sql_failure(e: sqlx::Error) -> SqlFailure {
    SqlFailure::Sql(e.to_string())
}

fn col_type(row: &PgRow, i: usize) -> &str {
    row.column(i).type_info().name()
}

fn mismatch(field: &str) -> SqlFailure {
    SqlFailure::schema(field)
}

macro_rules! get {
    ($row:expr, $i:expr, $t:ty, $field:expr) => {
        $row.try_get::<Option<$t>, _>($i).map_err(|_| mismatch($field))?
    };
}

/// Schema.Int from a column: int2 / int4 (int8 arrives as a JS BigInt and fails).
pub fn col_int_opt(row: &PgRow, i: usize, field: &str) -> Result<Option<i64>, SqlFailure> {
    Ok(match col_type(row, i) {
        "INT2" => get!(row, i, i16, field).map(i64::from),
        "INT4" => get!(row, i, i32, field).map(i64::from),
        _ => return Err(mismatch(field)),
    })
}

/// Schema.Number / Finite from a column: int2 / int4 / float4 / float8.
pub fn col_number_opt(row: &PgRow, i: usize, field: &str) -> Result<Option<f64>, SqlFailure> {
    Ok(match col_type(row, i) {
        "INT2" => get!(row, i, i16, field).map(f64::from),
        "INT4" => get!(row, i, i32, field).map(f64::from),
        "FLOAT4" => get!(row, i, f32, field).map(f64::from),
        "FLOAT8" => get!(row, i, f64, field),
        _ => return Err(mismatch(field)),
    })
}

/// Schema.String from a column: text-like types and uuid (as its canonical text).
pub fn col_string_opt(row: &PgRow, i: usize, field: &str) -> Result<Option<String>, SqlFailure> {
    Ok(match col_type(row, i) {
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" => get!(row, i, String, field),
        "UUID" => get!(row, i, uuid::Uuid, field).map(|u| u.to_string()),
        _ => return Err(mismatch(field)),
    })
}

pub fn col_boolean_opt(row: &PgRow, i: usize, field: &str) -> Result<Option<bool>, SqlFailure> {
    Ok(match col_type(row, i) {
        "BOOL" => get!(row, i, bool, field),
        _ => return Err(mismatch(field)),
    })
}

fn required<T>(v: Result<Option<T>, SqlFailure>, field: &str) -> Result<T, SqlFailure> {
    v?.ok_or_else(|| mismatch(field))
}

pub fn col_int(row: &PgRow, i: usize, field: &str) -> Result<i64, SqlFailure> {
    required(col_int_opt(row, i, field), field)
}
pub fn col_number(row: &PgRow, i: usize, field: &str) -> Result<f64, SqlFailure> {
    required(col_number_opt(row, i, field), field)
}
pub fn col_string(row: &PgRow, i: usize, field: &str) -> Result<String, SqlFailure> {
    required(col_string_opt(row, i, field), field)
}
pub fn col_boolean(row: &PgRow, i: usize, field: &str) -> Result<bool, SqlFailure> {
    required(col_boolean_opt(row, i, field), field)
}

// ═══════════════════════════ Tests ═══════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_matches_number_ctor() {
        for (s, n) in [("1", 1.0), (" 1", 1.0), ("", 0.0), ("  ", 0.0), ("1e2", 100.0), ("0x10", 16.0), ("0b11", 3.0), ("+5", 5.0), ("1.", 1.0), (".5", 0.5), ("-Infinity", f64::NEG_INFINITY)] {
            assert_eq!(js_number(s), n, "{s:?}");
        }
        for s in ["abc", "1_0", "-0x10", "0x", "1e", "inf", "NaN"] {
            assert!(js_number(s).is_nan(), "{s:?}");
        }
    }

    #[test]
    fn finite_param_pattern() {
        for (s, n) in [("1", 1.0), ("-1", -1.0), ("+5", 5.0), ("1e2", 100.0), (".5", 0.5), ("1.5", 1.5)] {
            assert_eq!(param_finite(s).unwrap(), n, "{s:?}");
        }
        assert!(param_finite("1e400").unwrap().is_infinite());
        for s in ["abc", "0x1", " 1", "1 ", "NaN", "Infinity", "1.", "", "+", "1e", "--1"] {
            assert!(param_finite(s).is_err(), "{s:?}");
        }
    }

    #[test]
    fn numbers_encode_like_json_stringify() {
        let enc = |n: f64| {
            #[derive(Serialize)]
            struct W(#[serde(serialize_with = "ser_number")] f64);
            serde_json::to_string(&W(n)).unwrap()
        };
        assert_eq!(enc(1.5), "1.5");
        assert_eq!(enc(5.0), "5");
        assert_eq!(enc(1e21), "1e+21");
        assert_eq!(enc(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(enc(f64::INFINITY), "\"Infinity\"");
    }

    #[test]
    fn json_parse_semantics() {
        assert_eq!(parse_json(r#"{"a":1,"a":2}"#).unwrap()["a"], parse_json("2").unwrap());
        let v = parse_json(r#"{"t":"\ud800x"}"#).unwrap();
        assert_eq!(v["t"], Value::String("\u{FFFD}x".into()));
        let pair = parse_json(r#""😀""#).unwrap();
        assert_eq!(pair, Value::String("😀".into()));
        assert!(json_number(Some(&parse_json("1e400").unwrap()), false).unwrap().is_infinite());
        assert!(json_int(Some(&parse_json("1.5").unwrap())).is_err());
        assert_eq!(json_int(Some(&parse_json("1e2").unwrap())).unwrap(), 100);
    }

    #[test]
    fn decode_uri_like_js() {
        assert_eq!(js_decode_uri("/a%20b").unwrap(), "/a b");
        assert_eq!(js_decode_uri("/a%2Fb").unwrap(), "/a%2Fb"); // reserved stays encoded
        assert_eq!(js_decode_uri("/%E2%82%AC").unwrap(), "/€");
        assert!(js_decode_uri("/%ZZ").is_none());
        assert!(js_decode_uri("/%E2%82").is_none());
        assert!(js_decode_uri("/%ED%A0%80").is_none()); // surrogate
    }

    #[test]
    fn router_matches_effect() {
        let r = Router::new(RouterConfig::default(), &[("GET", "/todos/:id"), ("POST", "/todos"), ("GET", "/todos/special")]);
        let find = |m: &str, u: &str| r.find(m, u);
        assert_eq!(find("GET", "/todos/1"), Some((0, vec!["1".into()])));
        assert_eq!(find("GET", "/todos/special"), Some((2, vec![]))); // static wins
        assert_eq!(find("GET", "/TODOS/AbC"), Some((0, vec!["AbC".into()]))); // params keep case
        assert_eq!(find("GET", "//todos/1/"), Some((0, vec!["1".into()])));
        assert_eq!(find("GET", "/todos/1?x=1"), Some((0, vec!["1".into()])));
        assert_eq!(find("GET", "/todos/1;jsessionid=2"), Some((0, vec!["1".into()])));
        assert_eq!(find("GET", "/todos/%31"), Some((0, vec!["1".into()])));
        assert_eq!(find("GET", "/todos/a%2Fb"), Some((0, vec!["a/b".into()])));
        assert_eq!(find("GET", "/todos/%2541"), Some((0, vec!["%41".into()])));
        assert_eq!(find("HEAD", "/todos/1"), Some((0, vec!["1".into()])));
        assert_eq!(find("GET", "/todos/"), None);
        assert_eq!(find("PUT", "/todos/1"), None);
        assert_eq!(find("GET", "/todos/%ZZ"), None);
        assert_eq!(find("GET", &format!("/todos/{}", "x".repeat(101))), None);
        assert_eq!(find("GET", &format!("/todos/{}", "x".repeat(100))), Some((0, vec!["x".repeat(100)])));
    }
}
