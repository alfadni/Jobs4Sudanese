#!/usr/bin/env node
/**
 * Jobs4Sudanese portal entry point.
 *
 *   PORTAL_SECRET=... ANTHROPIC_API_KEY=... node portal/server.mjs
 *
 * See portal/README.md for every setting and docs/ARCHITECTURE.md for the design.
 */
import { loadConfig } from "./src/config.mjs";
import { openDb } from "./src/db.mjs";
import { purgeExpiredSessions } from "./src/auth.mjs";
import { assertTenantSafeEnv } from "./src/core.mjs";
import { anthropicLlm } from "./src/evaluator.mjs";
import { createApp, ensureDataDirs } from "./src/app.mjs";

const cfg = loadConfig();
assertTenantSafeEnv();
ensureDataDirs(cfg);
const db = openDb(cfg.dataDir);

const hasAiCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
if (!hasAiCredentials) {
  console.warn("⚠️  No ANTHROPIC_API_KEY set: the portal runs, but evaluations are disabled.");
}
const { app, queue } = await createApp({ cfg, db, llm: hasAiCredentials ? anthropicLlm(cfg) : null });

const sweep = setInterval(() => purgeExpiredSessions(db), 60 * 60_000);
sweep.unref();

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`Jobs4Sudanese portal on http://${cfg.host}:${cfg.port} (${cfg.env}, data: ${cfg.dataDir})`);
});
server.requestTimeout = 60_000;
server.headersTimeout = 20_000;

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: draining (max 120s)…`);
  server.close();
  await Promise.race([queue.idle(), new Promise((r) => setTimeout(r, 120_000))]);
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
