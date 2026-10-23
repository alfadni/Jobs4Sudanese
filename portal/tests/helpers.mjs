import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { createApp, ensureDataDirs } from "../src/app.mjs";

export const FAKE_REPORT = (company = "Acme Remote", role = "Backend Engineer", score = "4.2") => `# Evaluation: ${company} — ${role}

**Date:** 2026-10-23
**Archetype:** Platform
**Score:** ${score}/5
**URL:** (pasted)
**Legitimacy:** High Confidence
**Verification:** unconfirmed (portal)

## A) Role Summary
Backend role, fully remote.

## B) Match with CV
| Requirement | Evidence |
|---|---|
| Node.js | cv.md: "Built Node.js services" |

## Machine Summary

\`\`\`yaml
company: "${company}"
role: "${role}"
score: ${score}
archetype: Platform
legitimacy: High Confidence
\`\`\`
`;

/** A fake model that records what it was sent and answers with an envelope. */
export function fakeLlm(reply = (calls) => `<<report-md>>\n${FAKE_REPORT()}\n<</report-md>>\nVERDICT: 4.2/5 — good`) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    return { ok: true, text: reply(calls), usage: null };
  };
  fn.calls = calls;
  return fn;
}

export async function startPortal({ llm = fakeLlm(), overrides = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "j4s-test-"));
  const cfg = loadConfig({ dataDir, adminEmails: ["admin@example.com"], ...overrides });
  ensureDataDirs(cfg);
  const db = openDb(dataDir);
  const { app, queue } = await createApp({ cfg, db, llm });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    cfg, db, queue, base, llm,
    async close() {
      await queue.idle();
      await new Promise((r) => server.close(r));
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A minimal browser: keeps cookies, extracts the CSRF token from pages. */
export class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }

  #cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  #store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async get(p) {
    const res = await fetch(this.base + p, { headers: { cookie: this.#cookieHeader() }, redirect: "manual" });
    this.#store(res);
    const body = await res.text();
    const m = body.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, body, location: res.headers.get("location"), headers: res.headers };
  }

  async post(p, fields, { csrf = this.csrf, origin = this.base } = {}) {
    const form = new URLSearchParams({ ...fields, ...(csrf ? { _csrf: csrf } : {}) });
    const headers = { cookie: this.#cookieHeader(), "content-type": "application/x-www-form-urlencoded" };
    if (origin) headers.origin = origin;
    const res = await fetch(this.base + p, { method: "POST", headers, body: form, redirect: "manual" });
    this.#store(res);
    return { status: res.status, body: await res.text(), location: res.headers.get("location") };
  }
}

export const SAMPLE_CV = `# Amna Osman

Khartoum, Sudan · amna@example.com

## Summary
Backend engineer with 5 years building payment and logistics APIs.

## Experience

### Bankak (Bank of Khartoum) — Khartoum
**Backend Engineer**
2021 – 2025
- Built Node.js services handling mobile wallet transfers.
- Designed PostgreSQL schemas for reconciliation.

## Education
B.Sc. Computer Science, University of Khartoum

## Skills
Node.js, TypeScript, PostgreSQL, Docker, REST APIs
`;

export const SAMPLE_JD = `Acme Remote is hiring a Backend Engineer (fully remote, EMEA time zones).
You will design and operate Node.js and TypeScript services for our payments platform,
own PostgreSQL schemas, and work with product on reliability. Requirements: 4+ years backend
experience, Node.js, SQL, Docker, experience with payments or fintech is a plus.
Compensation: USD 3,000 - 4,500 per month. Apply on our careers page.`;

export async function registerAndOnboard(b, { email = "amna@example.com", name = "Amna Osman" } = {}) {
  await b.get("/register");
  const r = await b.post("/register", { name, email, password: "correct-horse-battery", consent: "1" });
  if (r.status !== 303) throw new Error(`register failed ${r.status}: ${r.body.slice(0, 500)}`);
  await b.get("/profile");
  const p = await b.post("/profile", {
    full_name: name, email, location: "Khartoum, Sudan", country: "Sudan", city: "Khartoum",
    timezone: "Africa/Khartoum", target_roles: "Backend Engineer\nPlatform Engineer", target_range: "3000-4500",
    currency: "USD", minimum: "", output_lang: "ar", market: "global",
  });
  if (p.status !== 303) throw new Error(`profile failed ${p.status}: ${p.body.match(/role="alert">([\s\S]*?)<\/div>/)?.[1]}`);
  await b.get("/profile");
  const c = await b.post("/profile/cv", { cv: SAMPLE_CV });
  if (c.status !== 303) throw new Error(`cv failed ${c.status}`);
}
