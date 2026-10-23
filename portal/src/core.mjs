/**
 * core.mjs: the bridge between the portal and the career-ops engine.
 *
 * Each user owns an isolated career-ops DATA ROOT under
 * {PORTAL_DATA_DIR}/users/{uuid}/ with the same layout a CLI user has
 * (cv.md, config/profile.yml, data/applications.md, reports/, ...). Every
 * engine script runs as a child process with CAREER_OPS_ROOT pointed at that
 * root, so the portal orchestrates the core and never reimplements it
 * (web/AGENTS.md rule 1). The child gets a scrubbed environment: no API keys,
 * no portal secrets, and none of the CAREER_OPS_* lane overrides that would
 * point every tenant at one shared file.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Env vars that redirect one engine file for the whole PROCESS. In a
 * multi-tenant server any of these would silently merge every user's tracker,
 * profile or pipeline into one file, so the portal refuses to start with them.
 */
export const TENANT_UNSAFE_ENV = [
  "CAREER_OPS_TRACKER", "CAREER_OPS_PROFILE", "CAREER_OPS_PORTALS", "CAREER_OPS_PIPELINE",
  "CAREER_OPS_SCAN_HISTORY", "CAREER_OPS_ADDITIONS", "CAREER_OPS_ROOT", "CAREER_OPS_DATA_DIR",
];

export function assertTenantSafeEnv(env = process.env) {
  const set = TENANT_UNSAFE_ENV.filter((k) => String(env[k] ?? "").trim() !== "");
  if (set.length) {
    throw new Error(`Refusing to start: ${set.join(", ")} would point every user at one shared file. Unset them; the portal sets the data root per user.`);
  }
}

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REPORT_FILE_RE = /^\d{3,}-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/;

export function userRoot(cfg, userId) {
  if (!USER_ID_RE.test(String(userId))) throw new Error("invalid user id");
  return path.join(cfg.dataDir, "users", userId);
}

export function sharedRoot(cfg) {
  return path.join(cfg.dataDir, "shared");
}

/** Lazily import an engine module by path, so the portal tracks the core it ships with. */
export function coreModule(cfg, rel) {
  return import(pathToFileURL(path.join(cfg.codeRoot, rel)).href);
}

function childEnv(root) {
  const keep = ["PATH", "HOME", "TZ", "LANG", "LC_ALL", "TMPDIR", "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "PLAYWRIGHT_BROWSERS_PATH",
    // Operator opt-in read by the scanners when egress goes through a proxy.
    "CAREER_OPS_TRUST_PROXY_EGRESS"];
  const env = {};
  for (const k of keep) if (process.env[k] != null) env[k] = process.env[k];
  env.CAREER_OPS_ROOT = root;
  env.CAREER_OPS_NO_UPDATE_CHECK = "1";
  env.NO_COLOR = "1";
  return env;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Run one engine script against a data root. Never throws.
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runScript(cfg, root, script, args = [], { input = null, timeoutMs } = {}) {
  if (path.basename(script) !== script || !script.endsWith(".mjs")) {
    return Promise.resolve({ ok: false, code: null, stdout: "", stderr: `refusing script ${script}`, timedOut: false });
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(cfg.codeRoot, script), ...args], {
      cwd: root,
      env: childEnv(root),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs ?? cfg.scriptTimeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: `${script} failed to start: ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
    child.stdin.on("error", () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * A spawn function for web/src/lib/report-persist.mjs. That module spawns
 * `{root}/{script}` with cwd=root because the web app runs inside the
 * checkout; here the data root is separate, so map the script back to the
 * code root and hand the child the tenant's scrubbed env.
 */
export function tenantSpawn(cfg, root) {
  return (cmd, [scriptPath, ...rest], opts = {}) =>
    spawn(cmd, [path.join(cfg.codeRoot, path.basename(scriptPath)), ...rest], {
      ...opts,
      cwd: root,
      env: childEnv(root),
    });
}

// ---------------------------------------------------------------------------
// Tenant lifecycle
// ---------------------------------------------------------------------------

/** Create a user's data root and the personalization templates (doctor --init-templates). */
export async function initTenant(cfg, root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const r = await runScript(cfg, root, "doctor.mjs", ["--json", "--init-templates"]);
  // doctor exits non-zero while onboarding is incomplete; the templates are
  // still copied. Only a missing _profile.md means the init really failed.
  if (!fs.existsSync(path.join(root, "modes", "_profile.md"))) {
    return { ok: false, error: r.stderr || "doctor.mjs --init-templates did not create modes/_profile.md" };
  }
  // AGENTS.md onboarding Step 4, plus the optional URL column so the posting
  // URL is kept and becomes merge-tracker's dedup key. merge-tracker.mjs never creates the tracker
  // ("No applications.md found. Nothing to merge into." and exit 0), so
  // without it every evaluation's row would sit unmerged in tracker-additions.
  const tracker = path.join(root, "data", "applications.md");
  if (!fs.existsSync(tracker)) atomicWrite(tracker, TRACKER_SEED);
  return { ok: true };
}

export const TRACKER_SEED = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
`;

export function removeTenant(cfg, userId) {
  const root = userRoot(cfg, userId);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Profile + CV
// ---------------------------------------------------------------------------

export const PROFILE_FIELDS = ["full_name", "email", "phone", "location", "country", "city", "timezone",
  "target_roles", "target_range", "currency", "minimum", "output_lang", "market"];

/**
 * Turn the portal's profile form into onboard-write.mjs answers. The form is
 * deliberately the same set of questions AGENTS.md onboarding asks.
 */
export function profileAnswers(form) {
  const roles = String(form.target_roles ?? "").split(/[\n,،]+/).map((s) => s.trim()).filter(Boolean).slice(0, 15);
  const answers = {
    candidate: {
      full_name: String(form.full_name ?? "").trim(),
      email: String(form.email ?? "").trim(),
      phone: String(form.phone ?? "").trim(),
      location: String(form.location ?? "").trim(),
    },
    target_roles: roles,
    compensation: {
      target_range: String(form.target_range ?? "").trim(),
      currency: String(form.currency ?? "USD").trim().toUpperCase().slice(0, 3),
    },
    location: {
      country: String(form.country ?? "").trim(),
      city: String(form.city ?? "").trim(),
      timezone: String(form.timezone ?? "").trim(),
    },
    spend_tier: "standard",
    portals: { positive: roles },
  };
  const minimum = String(form.minimum ?? "").trim();
  if (minimum) answers.compensation.minimum = minimum;
  if (!answers.candidate.phone) delete answers.candidate.phone;
  return answers;
}

export const MARKETS = { global: "modes", gulf: "modes/ar" };

/**
 * Set language.output and language.modes_dir in profile.yml, editing only
 * those two lines so the user's comments and every other field survive.
 * The result is re-parsed and refused unless it reads back as written.
 */
export function patchLanguageBlock(text, { output, modesDir }, loadYaml) {
  const lines = String(text).split("\n");
  let start = lines.findIndex((l) => /^language:\s*(#.*)?$/.test(l));
  if (start === -1) {
    lines.push("language:");
    start = lines.length - 1;
  }
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) end++;
  const block = lines.slice(start + 1, end).filter((l) => !/^\s+(output|modes_dir):/.test(l));
  block.unshift(`  output: ${output}`);
  if (modesDir && modesDir !== "modes") block.splice(1, 0, `  modes_dir: ${modesDir}`);
  const next = [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join("\n");
  const parsed = loadYaml(next);
  if (parsed?.language?.output !== output) throw new Error("language.output did not round-trip");
  const wantDir = modesDir && modesDir !== "modes" ? modesDir : undefined;
  if (parsed?.language?.modes_dir !== wantDir) throw new Error("language.modes_dir did not round-trip");
  return next;
}

export async function writeProfile(cfg, root, form) {
  const answers = profileAnswers(form);
  const exists = fs.existsSync(path.join(root, "config", "profile.yml"));
  const args = ["--answers", "-"];
  if (exists) args.push("--force", "--only", "profile");
  const r = await runScript(cfg, root, "onboard-write.mjs", args, { input: JSON.stringify(answers) });
  if (!r.ok) return { ok: false, error: lastLine(r.stderr) || "onboard-write.mjs failed" };

  const output = form.output_lang === "en" ? "en" : "ar";
  const modesDir = MARKETS[form.market] ?? "modes";
  const { loadYaml } = await coreModule(cfg, "lib/yaml-document.mjs");
  const file = path.join(root, "config", "profile.yml");
  try {
    const patched = patchLanguageBlock(fs.readFileSync(file, "utf8"), { output, modesDir }, loadYaml);
    atomicWrite(file, patched);
  } catch (e) {
    return { ok: false, error: `language settings not saved: ${e.message}` };
  }
  return { ok: true };
}

/** Read profile.yml into the flat shape the profile form shows. Missing file → null. */
export async function readProfile(cfg, root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, "config", "profile.yml"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const { loadYaml } = await coreModule(cfg, "lib/yaml-document.mjs");
  const p = loadYaml(text) ?? {};
  const c = p.candidate ?? {};
  const comp = p.compensation ?? {};
  const loc = p.location ?? {};
  const lang = p.language ?? {};
  const roles = p.target_roles?.primary ?? p.target_roles ?? [];
  const market = Object.entries(MARKETS).find(([, dir]) => dir === (lang.modes_dir ?? "modes"))?.[0] ?? "global";
  return {
    full_name: c.full_name ?? "", email: c.email ?? "", phone: c.phone ?? "", location: c.location ?? "",
    country: loc.country ?? "", city: loc.city ?? "", timezone: loc.timezone ?? "",
    target_roles: Array.isArray(roles) ? roles.join("\n") : String(roles ?? ""),
    target_range: comp.target_range ?? "", currency: comp.currency ?? "USD", minimum: comp.minimum ?? "",
    output_lang: lang.output === "en" ? "en" : "ar",
    market,
  };
}

export function readCv(root) {
  try {
    return fs.readFileSync(path.join(root, "cv.md"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}

export function writeCv(root, text) {
  atomicWrite(path.join(root, "cv.md"), String(text).replace(/\r\n/g, "\n"));
}

/** Read a personalization file the evaluator needs; missing → "". */
export function readOptional(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}

export function onboardingState(root) {
  const has = (rel) => fs.existsSync(path.join(root, rel));
  const cv = readCv(root).trim();
  return { profile: has("config/profile.yml"), cv: cv.length > 50 };
}

// ---------------------------------------------------------------------------
// Tracker, status, reports
// ---------------------------------------------------------------------------

export async function readTracker(cfg, root) {
  const { resolveTrackerPath } = await coreModule(cfg, "path-resolver.mjs");
  const { resolveColumns, parseTrackerRow, firstLinkTarget } = await coreModule(cfg, "tracker-parse.mjs");
  let text;
  try {
    text = fs.readFileSync(resolveTrackerPath(root), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const lines = text.split("\n");
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const target = firstLinkTarget(row.report);
    const reportFile = target ? path.basename(target) : null;
    rows.push({ ...row, reportFile: reportFile && REPORT_FILE_RE.test(reportFile) ? reportFile : null });
  }
  return rows.sort((a, b) => b.num - a.num);
}

export async function canonicalStates(cfg) {
  const { loadCanonicalStates } = await coreModule(cfg, "tracker-utils.mjs");
  const states = loadCanonicalStates(path.join(cfg.codeRoot, "templates", "states.yml"));
  return (states ?? []).map((s) => s.label).filter(Boolean);
}

/** The single write path for status changes: set-status.mjs. */
export async function setStatus(cfg, root, trackerNum, state, note) {
  const args = [String(trackerNum), state, "--json"];
  if (note) args.push("--note", note);
  const r = await runScript(cfg, root, "set-status.mjs", args);
  if (r.ok) return { ok: true };
  let error = lastLine(r.stderr) || lastLine(r.stdout) || "set-status.mjs failed";
  try { error = JSON.parse(r.stdout).error ?? error; } catch { /* plain text */ }
  return { ok: false, error };
}

export function readReport(root, file) {
  if (!REPORT_FILE_RE.test(String(file))) return null;
  try {
    return fs.readFileSync(path.join(root, "reports", file), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Full JD text from a known ATS public API (fetch-jd.mjs), or null on a miss. */
export async function fetchJd(cfg, root, url) {
  const r = await runScript(cfg, root, "fetch-jd.mjs", [url], { timeoutMs: 45_000 });
  return r.ok && r.stdout.trim().length > 200 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// Data portability
// ---------------------------------------------------------------------------

export function exportTenant(root) {
  const out = {};
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && /\.(md|yml|yaml|tsv|json)$/.test(e.name) && fs.statSync(abs).size < 2_000_000) {
        out[path.relative(root, abs)] = fs.readFileSync(abs, "utf8");
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function lastLine(s) {
  return String(s ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
}
