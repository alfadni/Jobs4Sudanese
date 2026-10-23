/**
 * feed.mjs: one shared job feed for every user.
 *
 * Scanning is zero-token (scan.mjs reads public ATS APIs) but it is still
 * network-heavy, so the portal runs ONE scan against a shared data root
 * ({PORTAL_DATA_DIR}/shared) instead of one per user. Users browse the
 * resulting data/pipeline.md and send a posting to their own evaluation.
 * An administrator curates shared/portals.yml (companies + title filters).
 */
import fs from "node:fs";
import path from "node:path";
import { runScript, sharedRoot, initTenant, atomicWrite } from "./core.mjs";

export async function ensureSharedRoot(cfg) {
  const root = sharedRoot(cfg);
  if (!fs.existsSync(path.join(root, "modes", "_profile.md"))) {
    const r = await initTenant(cfg, root);
    if (!r.ok) throw new Error(`shared feed root init failed: ${r.error}`);
  }
  const portals = path.join(root, "portals.yml");
  if (!fs.existsSync(portals)) {
    atomicWrite(portals, fs.readFileSync(path.join(cfg.codeRoot, "templates", "portals.example.yml"), "utf8"));
  }
  return root;
}

export async function runSharedScan(cfg) {
  const root = await ensureSharedRoot(cfg);
  const r = await runScript(cfg, root, "scan.mjs", ["--quiet"], { timeoutMs: cfg.scanTimeoutMs });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.timedOut) return { status: "failed", error: "Scan timed out." };
  // scan.mjs exits 1 when ANY board had a network error, even if the rest
  // were scanned and written. That is a partial success, not a failure:
  // keep the run "done" and show the errors next to the summary.
  if (!r.ok && !/New offers added/.test(out)) {
    return { status: "failed", error: `scan.mjs failed: ${out.split("\n").slice(-4).join(" ")}` };
  }
  const summary = out.split("\n").filter((l) => !l.startsWith("→")).slice(-12).join("\n");
  return { status: "done", result: { summary, partial: !r.ok } };
}

/**
 * Parse pipeline.md inbox lines written by scan.mjs:
 *   - [ ] {url} | {company} | {title} [| {location} [| {comp}]] [| posted: YYYY-MM-DD] [| ...]
 * Only unchecked items are offers; anything malformed is skipped.
 */
export function parsePipeline(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^- \[ \] (https?:\/\/\S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|(.*))?$/);
    if (!m) continue;
    const rest = (m[4] ?? "").split("|").map((s) => s.trim());
    const labelled = (key) => rest.find((s) => s.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? "";
    const positional = rest.filter((s) => !/^[a-z_]+:/i.test(s));
    out.push({
      url: m[1],
      company: m[2],
      title: m[3],
      location: positional[0] ?? "",
      comp: positional[1] ?? "",
      posted: /^\d{4}-\d{2}-\d{2}$/.test(labelled("posted")) ? labelled("posted") : "",
    });
  }
  return out;
}

export function readFeed(cfg) {
  try {
    const text = fs.readFileSync(path.join(sharedRoot(cfg), "data", "pipeline.md"), "utf8");
    const stat = fs.statSync(path.join(sharedRoot(cfg), "data", "pipeline.md"));
    return { items: parsePipeline(text), updatedAt: stat.mtime };
  } catch (e) {
    if (e.code === "ENOENT") return { items: [], updatedAt: null };
    throw e;
  }
}

export function filterFeed(items, q) {
  const terms = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((it) => {
    const hay = `${it.company} ${it.title} ${it.location}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
