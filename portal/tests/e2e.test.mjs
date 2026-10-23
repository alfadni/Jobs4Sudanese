/**
 * End-to-end: real HTTP routes + the real career-ops engine scripts
 * (doctor, onboard-write, reserve-report-num, persist-evaluation-report,
 * merge-tracker, set-status). Only the model is faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Browser, fakeLlm, FAKE_REPORT, registerAndOnboard, SAMPLE_JD, startPortal } from "./helpers.mjs";
import { readTracker, userRoot } from "../src/core.mjs";

test("journey: register → profile → CV → evaluate → tracker → status → report → export → delete", async (t) => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const b = new Browser(portal.base);

  // Landing is Arabic + RTL by default.
  const landing = await b.get("/");
  assert.equal(landing.status, 200);
  assert.match(landing.body, /<html lang="ar" dir="rtl">/);

  await registerAndOnboard(b);
  const user = portal.db.prepare("SELECT id FROM users WHERE email = ?").get("amna@example.com");
  const root = userRoot(portal.cfg, user.id);

  // The engine wrote the tenant's profile with the language block patched.
  const profileYml = fs.readFileSync(path.join(root, "config", "profile.yml"), "utf8");
  assert.match(profileYml, /full_name: "Amna Osman"/);
  assert.match(profileYml, /^ {2}output: ar$/m);
  assert.ok(fs.existsSync(path.join(root, "modes", "_profile.md")), "doctor --init-templates ran");

  // Evaluate a pasted JD.
  await b.get("/evaluate");
  const ev = await b.post("/evaluate", { url: "https://jobs.example.com/acme/backend", jd: SAMPLE_JD });
  assert.equal(ev.status, 303, ev.body.slice(0, 400));
  assert.match(ev.location, /^\/jobs\//);
  await portal.queue.idle();

  // The model got the mode files, the candidate files and a fenced, untrusted JD.
  const call = portal.llm.calls[0];
  assert.match(call.system[1], /<mode_file path="modes\/oferta.md">/);
  assert.match(call.user, /<candidate_file path="cv.md">[\s\S]*Bankak/);
  assert.match(call.user, /<job_description untrusted="true">[\s\S]*Acme Remote is hiring/);
  assert.match(call.user, /Arabic/);

  const job = await b.get(ev.location);
  assert.equal(job.status, 303, `job page should redirect to the report: ${job.body.slice(0, 300)}`);
  assert.match(job.location, /^\/reports\/001-acme-remote-\d{4}-\d{2}-\d{2}\.md$/);

  // Report persisted by the engine with the verbatim JD appended.
  const reportFile = path.basename(job.location);
  const saved = fs.readFileSync(path.join(root, "reports", reportFile), "utf8");
  assert.match(saved, /## Job Description \(archived verbatim\)/);
  assert.match(saved, /Acme Remote is hiring/);

  // Tracker row merged by merge-tracker.mjs.
  const tracker = await b.get("/tracker");
  assert.equal(tracker.status, 200);
  assert.match(tracker.body, /Acme Remote/);
  assert.match(tracker.body, /4\.2\/5/);

  // Status change through set-status.mjs.
  const st = await b.post("/tracker/1/status", { status: "Applied" });
  assert.equal(st.location, "/tracker?updated=1");
  const apps = fs.readFileSync(path.join(root, "data", "applications.md"), "utf8");
  assert.match(apps, /\| Applied \|/);

  // Report page renders markdown, shows the strong-fit advice and the posting link.
  const rep = await b.get(job.location);
  assert.equal(rep.status, 200);
  assert.match(rep.body, /<table>/);
  assert.match(rep.body, /href="https:\/\/jobs.example.com\/acme\/backend"/);

  // Export contains the user's own files.
  const exp = await b.get("/account/export");
  const bundle = JSON.parse(exp.body);
  assert.ok(bundle.files["cv.md"].includes("Bankak"));
  assert.ok(Object.keys(bundle.files).some((k) => k.startsWith("reports/")));

  // Delete removes the account and every file.
  await b.get("/account");
  const del = await b.post("/account/delete", { confirm: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(root), false);
  assert.equal(portal.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
  assert.equal((await b.get("/dashboard")).location, "/login");
});

test("a low score shows the do-not-apply recommendation", async (t) => {
  const llm = fakeLlm(() => `<<report-md>>\n${FAKE_REPORT("Weak Fit Co", "Data Scientist", "2.8")}\n<</report-md>>`);
  const portal = await startPortal({ llm });
  t.after(() => portal.close());
  const b = new Browser(portal.base);
  await registerAndOnboard(b);
  await b.get("/evaluate");
  const ev = await b.post("/evaluate", { url: "", jd: SAMPLE_JD });
  await portal.queue.idle();
  const job = await b.get(ev.location);
  const rep = await b.get(job.location);
  assert.match(rep.body, /class="flash warn"/);
  assert.match(rep.body, /score low/);
});

test("negative: a gate stop writes nothing and tells the user why", async (t) => {
  const llm = fakeLlm(() => "<<stop>> The posting text is a login page, not a job description.");
  const portal = await startPortal({ llm });
  t.after(() => portal.close());
  const b = new Browser(portal.base);
  await registerAndOnboard(b);
  await b.get("/evaluate");
  const ev = await b.post("/evaluate", { jd: SAMPLE_JD });
  await portal.queue.idle();
  const job = await b.get(ev.location);
  assert.equal(job.status, 200);
  assert.match(job.body, /login page, not a job description/);
  const user = portal.db.prepare("SELECT id FROM users").get();
  const root = userRoot(portal.cfg, user.id);
  assert.deepEqual(await readTracker(portal.cfg, root), []);
  assert.equal(fs.existsSync(path.join(root, "reports")) && fs.readdirSync(path.join(root, "reports")).length > 0, false);
});

test("negative: a malformed model reply is refused, not half-saved", async (t) => {
  const llm = fakeLlm(() => "Here is your evaluation: looks good!");
  const portal = await startPortal({ llm });
  t.after(() => portal.close());
  const b = new Browser(portal.base);
  await registerAndOnboard(b);
  await b.get("/evaluate");
  const ev = await b.post("/evaluate", { jd: SAMPLE_JD });
  await portal.queue.idle();
  const job = await b.get(ev.location);
  assert.match(job.body, /class="narrow card failed"/);
  assert.match(job.body, /report-md/);
});

test("negative: evaluation is blocked until the profile and CV exist", async (t) => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const b = new Browser(portal.base);
  await b.get("/register");
  await b.post("/register", { name: "No Profile", email: "np@example.com", password: "correct-horse-battery", consent: "1" });
  await b.get("/evaluate");
  const ev = await b.post("/evaluate", { jd: SAMPLE_JD });
  assert.equal(ev.status, 400);
  assert.equal(portal.llm.calls.length, 0);
});

test("negative: quota, short JD and bad URL are refused before any model call", async (t) => {
  const portal = await startPortal({ overrides: { dailyEvalQuota: 1 } });
  t.after(() => portal.close());
  const b = new Browser(portal.base);
  await registerAndOnboard(b);
  await b.get("/evaluate");
  assert.equal((await b.post("/evaluate", { jd: "too short" })).status, 400);
  assert.equal((await b.post("/evaluate", { url: "javascript:alert(1)", jd: SAMPLE_JD })).status, 400);
  assert.equal((await b.post("/evaluate", { jd: SAMPLE_JD })).status, 303);
  await portal.queue.idle();
  const over = await b.post("/evaluate", { jd: SAMPLE_JD });
  assert.equal(over.status, 429);
  assert.equal(portal.llm.calls.length, 1);
});

test("tenant isolation: one user cannot read another user's job or report", async (t) => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const a = new Browser(portal.base);
  await registerAndOnboard(a, { email: "a@example.com", name: "User A" });
  await a.get("/evaluate");
  const ev = await a.post("/evaluate", { jd: SAMPLE_JD });
  await portal.queue.idle();
  const job = await a.get(ev.location);

  const b = new Browser(portal.base);
  await registerAndOnboard(b, { email: "b@example.com", name: "User B" });
  assert.equal((await b.get(ev.location)).status, 404, "job id of another user");
  assert.equal((await b.get(job.location)).status, 404, "report of another user");
  assert.equal((await b.get("/reports/..%2F..%2Fportal.sqlite")).status, 404, "path traversal");
  assert.doesNotMatch((await b.get("/tracker")).body, /Acme Remote/);
});

test("security: CSRF and cross-origin posts are rejected; admin is gated", async (t) => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const b = new Browser(portal.base);
  await registerAndOnboard(b);
  await b.get("/profile");
  assert.equal((await b.post("/profile/cv", { cv: "x".repeat(100) }, { csrf: "forged" })).status, 403);
  assert.equal((await b.post("/profile/cv", { cv: "x".repeat(100) }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await b.get("/admin")).status, 403);

  const admin = new Browser(portal.base);
  await admin.get("/register");
  await admin.post("/register", { name: "Admin", email: "admin@example.com", password: "correct-horse-battery", consent: "1" });
  assert.equal((await admin.get("/admin")).status, 200);
});

test("security: login throttling and generic errors", async (t) => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const b = new Browser(portal.base);
  await b.get("/login");
  const first = await b.post("/login", { email: "nobody@example.com", password: "wrong-password-123" });
  assert.equal(first.status, 401);
  let last;
  for (let i = 0; i < 12; i++) last = await b.post("/login", { email: "nobody@example.com", password: "wrong-password-123" });
  assert.equal(last.status, 429);
});

test("security: headers forbid framing and inline script", async (t) => {
  const portal = await startPortal();
  t.after(() => portal.close());
  const res = await fetch(`${portal.base}/`);
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-powered-by"), null);
});
