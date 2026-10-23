/**
 * app.mjs: the Express application.
 *
 * createApp() takes its collaborators (db, llm, queue) so tests can run the
 * real routes and the real engine scripts with a fake model.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { audit } from "./db.mjs";
import {
  RateLimiter, createSession, csrfMatches, destroySession, DUMMY_HASH, hashPassword,
  loadSession, normalizeEmail, passwordProblem, validEmail, verifyPassword,
} from "./auth.mjs";
import {
  canonicalStates, exportTenant, fetchJd, initTenant, onboardingState, readCv, readProfile,
  readReport, readTracker, removeTenant, setStatus, tenantSpawn, userRoot, writeCv, writeProfile,
  coreModule, sharedRoot, MARKETS,
} from "./core.mjs";
import { evaluate } from "./evaluator.mjs";
import { JobQueue } from "./jobs.mjs";
import { filterFeed, readFeed, runSharedScan } from "./feed.mjs";
import { pickLang } from "./i18n.mjs";
import * as V from "./views.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = "j4s_session";
const PRE_CSRF_COOKIE = "j4s_pre";
const LANG_COOKIE = "j4s_lang";

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed */ }
  }
  return out;
}

function cookie(res, name, value, { maxAge, httpOnly = true, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  res.append("Set-Cookie", parts.join("; "));
}

const safeNext = (p) => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") ? p : "/");
const today = () => new Date().toISOString().slice(0, 10);

/**
 * @param {{cfg: object, db: import("node:sqlite").DatabaseSync, llm: Function|null}} deps
 */
export async function createApp({ cfg, db, llm }) {
  const { persistEvaluation } = await import(path.join(cfg.codeRoot, "web/src/lib/report-persist.mjs"));
  const { parseReportEnvelope, REPORT_ENVELOPE_INSTRUCTION } = await import(path.join(cfg.codeRoot, "web/src/lib/report-envelope.mjs"));
  const { isPostingUrl } = await coreModule(cfg, "lib/tracker-addition.mjs");
  const states = await canonicalStates(cfg);

  const queue = new JobQueue({
    db,
    concurrency: cfg.evalConcurrency,
    handlers: {
      evaluate: async (job) => {
        const root = userRoot(cfg, job.user_id);
        let jdText = job.input.jd;
        if (!jdText && job.input.url) {
          jdText = await fetchJd(cfg, root, job.input.url);
          if (!jdText) return { status: "stopped", error: "JD_UNAVAILABLE" };
        }
        const profile = await readProfile(cfg, root);
        return evaluate({
          cfg, root, llm,
          parseEnvelope: parseReportEnvelope,
          envelopeInstruction: REPORT_ENVELOPE_INSTRUCTION,
          jdText, url: job.input.url ?? "", today: today(),
          output: profile?.output_lang ?? "ar",
          modesDir: MARKETS[profile?.market] ?? "modes",
          persist: (markdown) => persistEvaluation({
            spawnFn: tenantSpawn(cfg, root), execPath: process.execPath, root,
            markdown, url: job.input.url ?? "", today: today(),
          }),
        });
      },
      scan: () => runSharedScan(cfg),
    },
  });

  const loginLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60_000 });
  const registerLimiter = new RateLimiter({ limit: 5, windowMs: 60 * 60_000 });

  const app = express();
  app.disable("x-powered-by");
  if (cfg.trustProxy) app.set("trust proxy", 1);

  // --- security headers -----------------------------------------------------
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    if (cfg.production) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });

  app.use("/static", express.static(path.join(here, "..", "public"), { maxAge: cfg.production ? "7d" : 0, index: false }));
  app.get("/healthz", (req, res) => res.json({ ok: true }));
  app.use(express.urlencoded({ extended: false, limit: "200kb", parameterLimit: 50 }));

  // --- session, language, CSRF ---------------------------------------------
  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.cookies = cookies;
    req.session = loadSession(db, cookies[SESSION_COOKIE]);
    const lang = pickLang(cookies[LANG_COOKIE] ?? req.session?.user.lang ?? "ar");
    // Anonymous forms (login/register) use a double-submit token in its own cookie.
    let pre = cookies[PRE_CSRF_COOKIE];
    if (!req.session && (!pre || !/^[\w-]{20,64}$/.test(pre))) {
      pre = crypto.randomBytes(24).toString("base64url");
      cookie(res, PRE_CSRF_COOKIE, pre, { maxAge: 2 * 3600_000, secure: cfg.production });
    }
    req.csrfToken = req.session?.csrf ?? pre;
    req.ctx = (extra = {}) => V.makeCtx({ lang, user: req.session?.user ?? null, path: req.path, csrf: req.csrfToken, ...extra });
    res.page = (status, body) => res.status(status).type("html").send(String(body));
    next();
  });

  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    // Same-origin check (defence in depth next to SameSite + the token).
    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      const host = req.headers["x-forwarded-host"] && cfg.trustProxy ? req.headers["x-forwarded-host"] : req.headers.host;
      try {
        if (new URL(origin).host !== host) return res.page(403, V.messagePage(req.ctx(), { title: "403", text: req.ctx().t("err_csrf") }));
      } catch {
        return res.page(403, "forbidden");
      }
    }
    if (!csrfMatches(req.csrfToken, req.body?._csrf)) {
      return res.page(403, V.messagePage(req.ctx(), { title: "403", text: req.ctx().t("err_csrf") }));
    }
    next();
  });

  const requireUser = (req, res, next) => {
    if (!req.session) return res.redirect(303, "/login");
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (req.session?.user.role !== "admin") return res.page(403, V.messagePage(req.ctx(), { title: "403", text: req.ctx().t("err_forbidden") }));
    next();
  };
  const ip = (req) => req.ip ?? req.socket.remoteAddress ?? "unknown";
  const quotaLeft = (userId) => Math.max(0, cfg.dailyEvalQuota - queue.countToday(userId, "evaluate"));
  const startSession = (res, userId) => {
    const { token } = createSession(db, userId, cfg.sessionTtlMs);
    cookie(res, SESSION_COOKIE, token, { maxAge: cfg.sessionTtlMs, secure: cfg.production });
  };

  // --- public ---------------------------------------------------------------
  app.get("/", (req, res) => (req.session ? res.redirect(303, "/dashboard") : res.page(200, V.landingPage(req.ctx()))));

  app.get("/lang", (req, res) => {
    const lang = pickLang(req.query.to);
    cookie(res, LANG_COOKIE, lang, { maxAge: 365 * 86400_000, httpOnly: false, secure: cfg.production });
    if (req.session) db.prepare("UPDATE users SET lang = ? WHERE id = ?").run(lang, req.session.user.id);
    res.redirect(303, safeNext(req.query.next));
  });

  app.get("/register", (req, res) => res.page(200, V.registerPage(req.ctx())));
  app.post("/register", async (req, res) => {
    const ctx = req.ctx();
    if (!cfg.allowRegistration) return res.page(403, V.registerPage(ctx, { errors: ["err_registration_closed"] }));
    if (!registerLimiter.take(`r:${ip(req)}`)) return res.page(429, V.registerPage(ctx, { errors: ["err_rate"] }));
    const name = String(req.body.name ?? "").trim().slice(0, 120);
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    const errors = [];
    if (!name) errors.push("err_name");
    if (!validEmail(email)) errors.push("err_email");
    const pw = passwordProblem(password);
    if (pw) errors.push(`err_${pw}`);
    if (req.body.consent !== "1") errors.push("err_consent");
    if (!errors.length && db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) errors.push("err_email_taken");
    if (errors.length) return res.page(400, V.registerPage(ctx, { errors, values: { name, email } }));

    const id = crypto.randomUUID();
    const role = cfg.adminEmails.includes(email) ? "admin" : "user";
    const init = await initTenant(cfg, userRoot(cfg, id));
    if (!init.ok) {
      removeTenant(cfg, id);
      console.error("tenant init failed:", init.error);
      return res.page(500, V.registerPage(ctx, { errors: ["err_generic"], values: { name, email } }));
    }
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, email, name, hashPassword(password), role, ctx.lang, new Date().toISOString());
    audit(db, id, "register", role);
    startSession(res, id);
    res.redirect(303, "/profile");
  });

  app.get("/login", (req, res) => (req.session ? res.redirect(303, "/dashboard") : res.page(200, V.loginPage(req.ctx()))));
  app.post("/login", (req, res) => {
    const ctx = req.ctx();
    const email = normalizeEmail(req.body.email);
    if (!loginLimiter.take(`l:${ip(req)}`) || !loginLimiter.take(`e:${email}`)) {
      return res.page(429, V.loginPage(ctx, { errors: ["err_rate"], values: { email } }));
    }
    const user = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email);
    const ok = verifyPassword(req.body.password, user?.password_hash ?? DUMMY_HASH) && Boolean(user);
    if (!ok) {
      audit(db, user?.id ?? null, "login_failed", email);
      return res.page(401, V.loginPage(ctx, { errors: ["err_login"], values: { email } }));
    }
    if (req.cookies[SESSION_COOKIE]) destroySession(db, req.cookies[SESSION_COOKIE]);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);
    audit(db, user.id, "login");
    startSession(res, user.id);
    res.redirect(303, "/dashboard");
  });

  app.post("/logout", (req, res) => {
    destroySession(db, req.cookies[SESSION_COOKIE]);
    cookie(res, SESSION_COOKIE, "", { maxAge: 0, secure: cfg.production });
    res.redirect(303, "/");
  });

  // --- signed in --------------------------------------------------------------
  app.get("/dashboard", requireUser, async (req, res) => {
    const root = userRoot(cfg, req.session.user.id);
    const rows = await readTracker(cfg, root);
    res.page(200, V.dashboardPage(req.ctx(), {
      onboarding: onboardingState(root), rows, recent: queue.recent(req.session.user.id, 8),
      quotaLeft: quotaLeft(req.session.user.id),
    }));
  });

  app.get("/profile", requireUser, async (req, res) => {
    const root = userRoot(cfg, req.session.user.id);
    const flash = req.query.saved ? { kind: "ok", text: req.ctx().t("saved") } : null;
    res.page(200, V.profilePage(req.ctx({ flash }), { profile: await readProfile(cfg, root), cv: readCv(root) }));
  });

  app.post("/profile", requireUser, async (req, res) => {
    const root = userRoot(cfg, req.session.user.id);
    const form = Object.fromEntries(
      ["full_name", "email", "phone", "location", "country", "city", "timezone", "target_roles", "target_range", "currency", "minimum", "output_lang", "market"]
        .map((k) => [k, String(req.body[k] ?? "").slice(0, k === "target_roles" ? 1500 : 200)]),
    );
    const errors = [];
    if (!form.full_name.trim()) errors.push("err_name");
    if (!validEmail(normalizeEmail(form.email))) errors.push("err_email");
    if (errors.length) return res.page(400, V.profilePage(req.ctx(), { profile: form, cv: readCv(root), errors }));
    const r = await writeProfile(cfg, root, form);
    if (!r.ok) {
      return res.page(400, V.profilePage(req.ctx(), { profile: form, cv: readCv(root), errors: [{ key: "err_generic" }, r.error] }));
    }
    audit(db, req.session.user.id, "profile_saved");
    res.redirect(303, "/profile?saved=1");
  });

  app.post("/profile/cv", requireUser, async (req, res) => {
    const root = userRoot(cfg, req.session.user.id);
    const cv = String(req.body.cv ?? "");
    const errors = [];
    if (cv.trim().length < 50) errors.push("err_cv_short");
    if (cv.length > cfg.maxCvChars) errors.push("err_cv_long");
    if (errors.length) return res.page(400, V.profilePage(req.ctx(), { profile: await readProfile(cfg, root), cv, errors }));
    writeCv(root, cv);
    audit(db, req.session.user.id, "cv_saved");
    res.redirect(303, "/profile?saved=1#cv");
  });

  app.get("/evaluate", requireUser, (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url.slice(0, 2000) : "";
    res.page(200, V.evaluatePage(req.ctx(), { values: { url }, quotaLeft: quotaLeft(req.session.user.id) }));
  });

  app.post("/evaluate", requireUser, async (req, res) => {
    const userId = req.session.user.id;
    const root = userRoot(cfg, userId);
    const url = String(req.body.url ?? "").trim();
    let jd = String(req.body.jd ?? "").trim();
    const values = { url, jd };
    const fail = (status, errors) => res.page(status, V.evaluatePage(req.ctx(), { errors, values, quotaLeft: quotaLeft(userId) }));

    if (!llm) return fail(503, ["err_no_ai"]);
    const ob = onboardingState(root);
    if (!ob.profile || !ob.cv) return fail(400, ["err_profile_first"]);
    if (url && (!isPostingUrl(url) || url.length > 2000)) return fail(400, ["err_url"]);
    if (jd.length > cfg.maxJdChars) return fail(400, ["err_jd_long"]);
    if (queue.activeFor(userId, "evaluate")) return fail(429, ["err_busy"]);
    if (quotaLeft(userId) <= 0) return fail(429, [{ key: "err_quota", vars: { n: cfg.dailyEvalQuota } }]);
    if (!jd && url) {
      jd = (await fetchJd(cfg, root, url)) ?? "";
      if (!jd) return fail(400, ["err_jd_needed"]);
    }
    if (jd.length < 200) return fail(400, [jd ? "err_jd_short" : "err_jd_needed"]);

    const id = queue.enqueue(userId, "evaluate", { url, jd });
    audit(db, userId, "evaluate_queued", url || "(pasted)");
    res.redirect(303, `/jobs/${id}`);
  });

  app.get("/jobs/:id", requireUser, (req, res) => {
    const job = queue.get(String(req.params.id));
    if (!job || job.user_id !== req.session.user.id) return res.page(404, V.messagePage(req.ctx(), { title: "404", text: req.ctx().t("err_not_found") }));
    if (job.status === "done" && job.result?.reportFile) return res.redirect(303, `/reports/${job.result.reportFile}`);
    if (job.error === "JD_UNAVAILABLE") job.error = req.ctx().t("err_jd_needed");
    res.page(200, V.jobPage(req.ctx(), job));
  });

  app.get("/tracker", requireUser, async (req, res) => {
    const root = userRoot(cfg, req.session.user.id);
    const flash = req.query.updated ? { kind: "ok", text: req.ctx().t("status_updated") }
      : req.query.error ? { kind: "error", text: String(req.query.error).slice(0, 300) } : null;
    res.page(200, V.trackerPage(req.ctx({ flash }), { rows: await readTracker(cfg, root), states }));
  });

  app.post("/tracker/:num/status", requireUser, async (req, res) => {
    const num = Number.parseInt(String(req.params.num), 10);
    const state = String(req.body.status ?? "");
    if (!Number.isInteger(num) || num < 1 || !states.includes(state)) return res.redirect(303, "/tracker?error=invalid");
    const r = await setStatus(cfg, userRoot(cfg, req.session.user.id), num, state);
    audit(db, req.session.user.id, "status", `${num}:${state}:${r.ok ? "ok" : r.error}`);
    res.redirect(303, r.ok ? "/tracker?updated=1" : `/tracker?error=${encodeURIComponent(r.error)}`);
  });

  app.get("/reports/:file", requireUser, async (req, res) => {
    const root = userRoot(cfg, req.session.user.id);
    const markdown = readReport(root, String(req.params.file));
    if (markdown == null) return res.page(404, V.messagePage(req.ctx(), { title: "404", text: req.ctx().t("err_not_found") }));
    const row = (await readTracker(cfg, root)).find((r) => r.reportFile === req.params.file) ?? null;
    if (row && !/^https?:\/\//i.test(row.url ?? "")) row.url = "";
    res.page(200, V.reportPage(req.ctx(), { markdown, row }));
  });

  app.get("/feed", requireUser, (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
    const { items, updatedAt } = readFeed(cfg);
    const filtered = filterFeed(items, q).slice(0, 200);
    res.page(200, V.feedPage(req.ctx(), { items: filtered, total: items.length, q, updatedAt }));
  });

  app.get("/account", requireUser, (req, res) => res.page(200, V.accountPage(req.ctx())));

  app.get("/account/export", requireUser, (req, res) => {
    const u = req.session.user;
    const bundle = { exported_at: new Date().toISOString(), account: { email: u.email, name: u.name }, files: exportTenant(userRoot(cfg, u.id)) };
    audit(db, u.id, "export");
    res.set("Content-Disposition", `attachment; filename="jobs4sudanese-${today()}.json"`);
    res.type("application/json").send(JSON.stringify(bundle, null, 2));
  });

  app.post("/account/delete", requireUser, async (req, res) => {
    if (String(req.body.confirm ?? "").trim() !== "DELETE") return res.page(400, V.accountPage(req.ctx(), { errors: ["acc_delete_confirm"] }));
    const u = req.session.user;
    if (queue.activeFor(u.id, "evaluate")) return res.page(409, V.accountPage(req.ctx(), { errors: ["err_busy"] }));
    removeTenant(cfg, u.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
    audit(db, null, "account_deleted", u.id);
    cookie(res, SESSION_COOKIE, "", { maxAge: 0, secure: cfg.production });
    res.page(200, V.messagePage(V.makeCtx({ lang: req.ctx().lang }), { title: req.ctx().t("acc_h"), text: req.ctx().t("acc_deleted") }));
  });

  // --- admin -----------------------------------------------------------------
  const lastScan = () => {
    const row = db.prepare("SELECT * FROM jobs WHERE kind = 'scan' ORDER BY created_at DESC LIMIT 1").get();
    return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null;
  };

  app.get("/admin", requireUser, requireAdmin, (req, res) => {
    const flash = req.query.scan === "started" ? { kind: "ok", text: req.ctx().t("adm_scan_started") }
      : req.query.scan === "running" ? { kind: "warn", text: req.ctx().t("adm_scan_running") } : null;
    res.page(200, V.adminPage(req.ctx({ flash }), {
      users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
      evals: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'evaluate' AND status = 'done'").get().n,
      lastScan: lastScan(),
      portalsPath: path.join(sharedRoot(cfg), "portals.yml"),
    }));
  });

  app.post("/admin/scan", requireUser, requireAdmin, (req, res) => {
    if (queue.activeFor(null, "scan")) return res.redirect(303, "/admin?scan=running");
    queue.enqueue(null, "scan", {});
    audit(db, req.session.user.id, "scan_started");
    res.redirect(303, "/admin?scan=started");
  });

  // --- errors ----------------------------------------------------------------
  app.use((req, res) => res.page(404, V.messagePage(req.ctx?.() ?? V.makeCtx({ lang: "ar" }), { title: "404", text: V.makeCtx({ lang: "ar" }).t("err_not_found") })));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const ctx = req.ctx?.() ?? V.makeCtx({ lang: "ar" });
    res.page(err.status === 413 ? 413 : 500, V.messagePage(ctx, { title: "Error", text: ctx.t("err_generic") }));
  });

  return { app, queue };
}

export function ensureDataDirs(cfg) {
  fs.mkdirSync(path.join(cfg.dataDir, "users"), { recursive: true, mode: 0o700 });
}
