# Jobs4Sudanese portal: solution architecture

Status: MVP (v0.1). Owner: Jobs4Sudanese fork. Scope: the hosted portal in `portal/`.

## 1. Context and goals

career-ops is a single-user job-search engine driven from an AI coding CLI. It is powerful
but needs a terminal, an AI CLI subscription and Node.js, which excludes most Sudanese
job seekers, many of whom are displaced, on mobile and on intermittent connectivity. The
upstream `web/` app does not fix this: it is single-user, loopback-only and has no login
(the bind address is its only access control).

**Goal:** offer the core career-ops value (honest evaluation against your own CV,
application tracking, a job feed) as a hosted, bilingual, mobile-friendly service for
many users, **without forking the engine's logic**.

| # | Requirement | How it is met |
|---|---|---|
| G1 | Same results as the CLI | The portal runs the engine's own scripts and mode files; nothing is reimplemented (§3) |
| G2 | Many users, strict isolation | One career-ops data root per user, UUID-keyed, plus a process-wide override guard (§4) |
| G3 | Arabic first, English available | Server-rendered RTL/LTR UI; report language and market selectable per user |
| G4 | Safe with untrusted postings | Model holds no tools; backend-owned persistence; strict CSP; escaped rendering (§6) |
| G5 | Cheap to run, simple to operate | One Node process, SQLite, no build step; zero-token shared scan; prompt caching (§7) |

Non-goals for the MVP: CV/PDF tailoring, cover letters, interview prep, auto-apply (never).

## 2. Component view

```
 Browser (AR/EN, no JS required)
    │ HTTPS (TLS at reverse proxy)
    ▼
 ┌──────────────────────── portal/server.mjs (Express 5) ────────────────────────┐
 │ security headers · origin check · CSRF · sessions · rate limits · i18n views │
 │                                                                               │
 │  routes ──► core.mjs (tenant bridge) ──spawn──► career-ops engine scripts     │
 │    │          · CAREER_OPS_ROOT=users/{uuid}    doctor · onboard-write        │
 │    │          · scrubbed env, timeouts          fetch-jd · set-status         │
 │    │                                            reserve-report-num            │
 │    ▼                                            persist-evaluation-report     │
 │  jobs.mjs (queue) ──► evaluator.mjs ──HTTPS──►  merge-tracker · scan          │
 │    │                     │  Claude API (no tools, streamed, cached prefix)    │
 │    ▼                     ▼                                                    │
 │  SQLite (portal.sqlite)  web/src/lib/report-envelope + report-persist (reuse) │
 └───────────────────────────────────────────────────────────────────────────────┘
    │
    ▼  PORTAL_DATA_DIR (persistent volume)
    ├── portal.sqlite            accounts · hashed sessions · job queue · audit log
    ├── shared/                  career-ops root for the shared feed (portals.yml, data/pipeline.md)
    └── users/{uuid}/            one career-ops data root per user
        ├── cv.md · config/profile.yml · modes/_profile.md · portals.yml
        ├── data/applications.md (tracker, source of truth)
        ├── reports/NNN-company-YYYY-MM-DD.md
        └── batch/tracker-additions/
```

## 3. Engine reuse (G1)

The portal follows `web/AGENTS.md`: orchestrate the core, never reimplement it.

| Capability | Engine entry point used | Notes |
|---|---|---|
| Tenant setup | `doctor.mjs --json --init-templates` + tracker seed (AGENTS.md onboarding Step 4) | `merge-tracker.mjs` deliberately never creates the tracker, so the seed is required |
| Profile | `onboard-write.mjs --answers -` (`--force --only profile` on edits) | `language.output` / `language.modes_dir` patched line-wise, re-parsed and verified |
| Evaluation logic | `modes/_shared.md` + `modes/oferta.md`, or `modes/ar/_shared.md` + `modes/ar/fursah.md` | Loaded verbatim as the system prompt |
| Report extraction | `web/src/lib/report-envelope.mjs` (`<<report-md>>`) | Same contract the local web app uses |
| Persistence | `web/src/lib/report-persist.mjs` → `reserve-report-num` → `persist-evaluation-report` → `merge-tracker` → release | Spawn function injected so scripts run from the code root against the tenant root |
| JD fetch | `fetch-jd.mjs` (ATS public APIs only) | No arbitrary server-side fetch of user URLs (SSRF) |
| Tracker read | `tracker-parse.mjs` (`resolveColumns`, `parseTrackerRow`, `firstLinkTarget`) | |
| Status change | `set-status.mjs <#> <State> --json` | The single canonical write path |
| States | `templates/states.yml` via `loadCanonicalStates` | |
| Feed | `scan.mjs` against `shared/` | One zero-token scan serves every user |

**Coupling risk:** the portal imports two plain modules from `web/src/lib/`. If upstream
moves them, `portal/tests/e2e.test.mjs` fails immediately (it exercises the full path).

## 4. Multi-tenancy and isolation (G2)

- **Data root per user**: `users/{uuid}`. The UUID comes from the database only and is
  validated against a strict regex before any path join; no request parameter ever
  forms a path. Report files are matched against `^\d{3,}-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$`.
- **Ownership checks**: jobs are looked up by id and then compared to the session user
  (404 on mismatch, not 403, so job ids cannot be probed).
- **Process-wide override guard**: the engine honours `CAREER_OPS_TRACKER`,
  `CAREER_OPS_PROFILE`, `CAREER_OPS_PORTALS`, `CAREER_OPS_PIPELINE`, … for the *whole
  process*. In a shared server any one of them would silently merge every tenant into one
  file, so the portal refuses to boot when they are set and strips them from children.
- **Child environment**: an allow-list (PATH, HOME, proxy/CA settings), plus
  `CAREER_OPS_ROOT`. The Anthropic key and the portal secret never reach engine scripts.
- **Locks**: engine scripts keep their own tracker and report-number locks per data root;
  the queue additionally runs at most one job per user at a time.

## 5. Key flows

### 5.1 Evaluate a job (happy path)

1. `POST /evaluate` with `url` and/or `jd`. Validation order is chosen to spend nothing
   on bad input: AI configured → profile and CV present → URL is http(s) → JD size →
   no running evaluation for this user → daily quota.
2. If there is no JD text but there is a URL → `fetch-jd.mjs` (known ATS APIs only).
3. Enqueue (SQLite row) → `303 /jobs/{id}`; the page auto-refreshes (meta refresh, no JS).
4. Worker: build the prompt. The system prefix is operating rules + mode files (identical
   for every user, so it is cached for 1h). The user turn is the candidate files + the JD in
   `<job_description untrusted="true">`.
5. Claude (`claude-opus-5-5`, adaptive thinking, effort `high`, streamed, 64k max output,
   server-side refusal fallback) returns the report inside `<<report-md>>`.
6. The backend appends `## Job Description (archived verbatim)` (#2789), then
   `persistEvaluation` reserves a number, writes the report + headed TSV, merges the
   tracker and releases the reservation.
7. Job `done` → redirect to the report; the tracker shows the row; below 4.0/5 a
   do-not-apply recommendation is shown.

### 5.2 Customer journeys: positive and negative cases

| # | Journey | Expected behaviour | Covered by |
|---|---|---|---|
| P1 | New user registers, fills profile and CV, evaluates a pasted JD | Report rendered in Arabic; row in tracker; status can move to Applied | `e2e: journey` |
| P2 | User evaluates from a Greenhouse/Lever/Ashby link with no text | JD fetched from the ATS API, evaluated | `fetch-jd.mjs` (engine tests) |
| P3 | User picks a role from the shared feed | `/evaluate?url=` prefilled → P2 | feed parser test |
| P4 | User switches the UI language | Cookie + saved preference; reports follow the profile's report language | manual |
| P5 | User exports, then deletes the account | JSON bundle of every file; data root and DB rows removed | `e2e: journey` |
| N1 | Evaluates before setting up profile/CV | 400 with guidance; no model call, no cost | `e2e: blocked until profile` |
| N2 | Link from an unsupported site and no text | "Paste the JD" message; no job created | route validation |
| N3 | JD too short / too long / `javascript:` URL | 400 before any model call | `e2e: quota, short JD, bad URL` |
| N4 | Daily quota exhausted | 429 with the limit; failed jobs do not count against it | `e2e: quota` |
| N5 | Second evaluation while one is running | 429 "already running" | route validation |
| N6 | Posting is a login wall / closed / dealbreaker | Model returns `<<stop>> reason`; nothing written; reason shown | `e2e: gate stop` |
| N7 | Model output malformed, cut off (max_tokens) or refused | Job `failed` with a clear message; nothing half-written | `e2e: malformed reply` |
| N8 | Posting contains prompt-injection text | Model has no tools; text is quoted as a Block G anomaly; persistence path is fixed | design (§6) |
| N9 | Engine write fails (lock, disk) | `persistEvaluation` releases the number, returns the error; job `failed` | engine contract |
| N10 | Server restarts mid-evaluation | On boot, queued/running jobs are marked failed with "run it again" | `JobQueue` constructor |
| N11 | User B guesses user A's job id or report name | 404 | `e2e: tenant isolation` |
| N12 | Forged form / cross-site post | 403 (CSRF token + Origin check + SameSite=Lax) | `e2e: CSRF` |
| N13 | Password guessing | 401 with a generic message, then 429 after 10 attempts / 15 min per IP and per email | `e2e: login throttling` |
| N14 | Status change to a non-canonical state | Rejected before `set-status.mjs`; engine validates again | route validation |
| N15 | Feed scan partially fails (some boards unreachable) | Run marked done with the errors listed, not failed | `feed.mjs` |
| N16 | AI provider down / rate-limited / bad key | Job `failed` with a specific message; user can retry | `describeLlmError` |

## 6. Security and privacy (G4)

| Threat | Control |
|---|---|
| Prompt injection via a posting | No tools for the model; JD fenced as untrusted; output only accepted through the envelope parser; filenames and paths are backend-owned; report rendered with markdown-it `html:false` |
| XSS | Auto-escaping template tag; CSP `script-src 'self'` with no inline script (the UI needs no JS); `javascript:` links dropped by markdown-it; feed and tracker links must be http(s) |
| CSRF | Per-session synchronizer token (double-submit cookie before login) + Origin check + `SameSite=Lax` |
| Session theft | 256-bit random token in an HttpOnly (Secure in prod) cookie; only SHA-256 stored; rotated at login; 14-day TTL; hourly purge |
| Credential stuffing | scrypt (N=2^15) with salt; constant-time compare; dummy hash for unknown emails (no user enumeration by timing); IP + email throttling |
| SSRF | No server-side fetch of user URLs except `fetch-jd.mjs` (fixed ATS API hosts) and `scan.mjs` (proxy-egress guard) |
| Path traversal | UUID-only tenant paths; report-name regex; scripts referenced by basename only |
| Tenant bleed | §4 override guard + scrubbed child env + ownership checks |
| Clickjacking / sniffing | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, HSTS in production |
| Secrets | `PORTAL_SECRET` required in production; API key never passed to child processes |
| Supply chain | 3 runtime dependencies (express, @anthropic-ai/sdk, markdown-it) with a committed lockfile |

**Personal data.** CVs contain PII. Data is stored under `PORTAL_DATA_DIR` with 0700/0600
permissions; registration requires explicit consent to AI processing; users can export
everything (portability) and delete everything (erasure). CV and JD text are sent to the
AI provider for each evaluation, which the consent text states. The audit log records
actions, not content.

## 7. Cost and performance (G5)

- **Prompt caching:** mode files (≈28k tokens for the global market, ≈15k for the Arabic/Gulf
  market, estimated at 4 chars/token; Arabic text tokenizes denser, so measure with
  `count_tokens`) are a byte-identical system prefix
  shared by every user of a market, cached with a 1h TTL; only the CV + JD are billed at
  full input rate after the first call.
- **Quotas:** `PORTAL_DAILY_EVAL_QUOTA` per user (default 10/day); global
  `PORTAL_EVAL_CONCURRENCY` (default 2); one active evaluation per user.
- **Effort:** `high` by default because scoring quality is the product; `PORTAL_EFFORT`
  can be lowered after measuring quality on real postings.
- **Feed:** one zero-token scan for all users, instead of N per-user scans.

## 8. Scaling path

The MVP is deliberately one process. Each step below is triggered by a measurable signal:

| Signal | Step |
|---|---|
| > ~1 vCPU sustained, or HA needed | Move the queue to a durable broker (BullMQ/Redis or SQS) with separate worker processes; move rate limits to Redis; keep the `jobs` table shape |
| Need > 1 web instance | Shared volume (EFS/Filestore) for `PORTAL_DATA_DIR`, or object storage per tenant with a local working copy per job; Postgres for accounts/sessions/jobs |
| Many concurrent users | Per-user evaluation cost dashboard from `usage`; Message Batches API for non-urgent re-evaluations (50% cost) |
| Abuse | Email verification, CAPTCHA on register, per-IP evaluation quota |

## 9. Known limitations and next steps

1. **Not yet run against the live Claude API in this environment** (no key here). The
   request shape follows the current SDK types; verify with one real evaluation after deploy.
2. **Feed scan not verified live here** (sandbox egress blocked the ATS hosts); the
   parser is tested against `scan.mjs`'s documented line format.
3. No email verification or password reset yet (needs an email provider).
4. CV tailoring/PDF, cover letters and interview prep are not exposed yet; they map to the
   engine's `pdf`, `cover` and `interview-prep` modes and the same envelope pattern.
5. Feed curation for Sudanese job seekers (remote-first employers, Gulf companies, NGOs) is
   an operator task in `shared/portals.yml`.
