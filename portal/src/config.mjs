/**
 * config.mjs: every environment knob the portal reads, in one place.
 *
 * Read once at startup. Anything security-relevant fails closed: production
 * without PORTAL_SECRET refuses to boot rather than signing with a default.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The career-ops checkout that holds the engine scripts (portal/..). */
export const CODE_ROOT = path.resolve(here, "..", "..");

function int(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

function list(name) {
  return String(process.env[name] ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const env = process.env.NODE_ENV || "development";
  const production = env === "production";
  const secret = process.env.PORTAL_SECRET || "";
  if (production && secret.length < 32) {
    throw new Error("PORTAL_SECRET must be set to at least 32 random characters in production.");
  }
  const dataDir = path.resolve(process.env.PORTAL_DATA_DIR || path.join(CODE_ROOT, "portal-data"));
  return {
    env,
    production,
    port: int("PORT", 3100, 1),
    host: process.env.PORTAL_HOST || (production ? "0.0.0.0" : "127.0.0.1"),
    // Only trust X-Forwarded-* when a reverse proxy terminates TLS in front of us.
    trustProxy: process.env.PORTAL_TRUST_PROXY === "1",
    secret: secret || "dev-only-insecure-secret-change-me-0123456789",
    dataDir,
    codeRoot: CODE_ROOT,
    adminEmails: list("PORTAL_ADMIN_EMAILS"),
    allowRegistration: process.env.PORTAL_ALLOW_REGISTRATION !== "0",
    model: process.env.PORTAL_MODEL || "claude-opus-5-5",
    effort: process.env.PORTAL_EFFORT || "high",
    evalConcurrency: int("PORTAL_EVAL_CONCURRENCY", 2, 1),
    dailyEvalQuota: int("PORTAL_DAILY_EVAL_QUOTA", 10, 0),
    scriptTimeoutMs: int("PORTAL_SCRIPT_TIMEOUT_MS", 120_000, 1000),
    scanTimeoutMs: int("PORTAL_SCAN_TIMEOUT_MS", 15 * 60_000, 1000),
    sessionTtlMs: int("PORTAL_SESSION_TTL_HOURS", 24 * 14, 1) * 3600_000,
    maxJdChars: 60_000,
    maxCvChars: 60_000,
    ...overrides,
  };
}
