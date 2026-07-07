// auth-shared.js — JWT + hashing primitives for dooo Stage 4 auth.
//
// Pure WebCrypto, zero dependencies. Runs identically in Cloudflare Workers,
// Pages Functions, browsers, and Node 19+ (for tests). Session JWTs are HS256
// with a shared SESSION_SECRET; magic-link tokens and api tokens are stored
// server-side as SHA-256 hashes only.

const te = new TextEncoder();
const td = new TextDecoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

// SHA-256 of a UTF-8 string as lowercase hex. Matches `echo -n "x" | shasum -a 256`.
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Cryptographically random base64url token (default 32 bytes ≈ 43 chars).
export function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(buf);
}

// Uniform random numeric code (rejection sampling — no modulo bias).
export function randomCode(digits = 6) {
  const out = [];
  while (out.length < digits) {
    const buf = crypto.getRandomValues(new Uint8Array(digits * 2));
    for (const b of buf) {
      if (b < 250 && out.length < digits) out.push(b % 10);
    }
  }
  return out.join("");
}

// Constant-time string comparison (length-safe).
export function timingSafeEqual(a, b) {
  const ea = te.encode(String(a));
  const eb = te.encode(String(b));
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// Sign a session JWT (HS256). Claims are the caller's responsibility;
// the suite's shape is {iss:'dooo', sub, hh, em, role, jti, iat, exp}.
export async function signSessionJwt(claims, secret) {
  const header = b64url(te.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(te.encode(JSON.stringify(claims)));
  const data = `${header}.${payload}`;
  const key = await hmacKey(secret, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(data)));
  return `${data}.${b64url(sig)}`;
}

// Verify a session JWT against one or more secrets (rotation: [current, prev]).
// Returns the claims object, or null on any failure. Enforces alg=HS256
// (blocks alg-confusion), iss, and exp with ±skew tolerance.
export async function verifySessionJwt(jwt, secrets, opts = {}) {
  const {
    now = Math.floor(Date.now() / 1000),
    skewSec = 60,
    iss = "dooo",
  } = opts;
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) return null;
  let header, claims, sigBytes;
  try {
    header = JSON.parse(td.decode(b64urlToBytes(parts[0])));
    claims = JSON.parse(td.decode(b64urlToBytes(parts[1])));
    sigBytes = b64urlToBytes(parts[2]);
  } catch {
    return null;
  }
  if (!header || header.alg !== "HS256") return null;
  const data = te.encode(`${parts[0]}.${parts[1]}`);
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  for (const secret of list) {
    const key = await hmacKey(secret, ["verify"]);
    if (await crypto.subtle.verify("HMAC", key, sigBytes, data)) {
      if (claims.iss !== iss) return null;
      if (typeof claims.exp !== "number" || claims.exp + skewSec < now) return null;
      return claims;
    }
  }
  return null;
}

// Decode claims WITHOUT verifying — client-side renewal timing only.
// Never make an authorization decision from this.
export function decodeJwtClaims(jwt) {
  try {
    return JSON.parse(td.decode(b64urlToBytes(String(jwt).split(".")[1] || "")));
  } catch {
    return null;
  }
}
