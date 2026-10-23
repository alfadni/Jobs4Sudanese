/**
 * auth.mjs: password hashing, sessions, CSRF and login throttling.
 *
 * - Passwords: scrypt (N=2^15) with a per-user salt, compared in constant time.
 * - Sessions: a random 256-bit token goes in an HttpOnly cookie; only its
 *   SHA-256 is stored, so a leaked database cannot be replayed as cookies.
 * - CSRF: a per-session synchronizer token, required on every state-changing
 *   request, on top of SameSite=Lax and the Origin check in app.mjs.
 */
import crypto from "node:crypto";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/;

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function validEmail(email) {
  return EMAIL_RE.test(email) && email.length <= 254;
}

export function passwordProblem(pw) {
  if (typeof pw !== "string") return "password_required";
  if (pw.length < PASSWORD_MIN) return "password_short";
  if (pw.length > PASSWORD_MAX) return "password_long";
  return null;
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(pw, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  let actual;
  try {
    actual = crypto.scryptSync(String(pw ?? ""), Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A hash to verify against when the email is unknown, so timing does not reveal account existence. */
export const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function createSession(db, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(token), userId, csrf, now, now + ttlMs);
  return { token, csrf };
}

export function loadSession(db, token) {
  if (!token || typeof token !== "string" || token.length > 100) return null;
  const row = db.prepare(`
    SELECT s.token_hash, s.csrf, s.expires_at, u.id, u.email, u.name, u.role, u.lang
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
    return null;
  }
  return {
    tokenHash: row.token_hash,
    csrf: row.csrf,
    user: { id: row.id, email: row.email, name: row.name, role: row.role, lang: row.lang },
  };
}

export function destroySession(db, token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function purgeExpiredSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

export function csrfMatches(expected, given) {
  if (typeof expected !== "string" || typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Fixed-window counter keyed by IP + action. In-memory, so it is per-process:
 * fine for one instance; a multi-instance deployment moves this to Redis
 * (docs/ARCHITECTURE.md, scaling path).
 */
export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** @returns {boolean} true when this attempt is allowed */
  take(key, now = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 50_000) this.#sweep(now);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  #sweep(now) {
    for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
  }
}
