# Jobs4Sudanese portal

A hosted, multi-user, bilingual (Arabic RTL / English) web portal that gives job
seekers the career-ops workflow without installing an AI coding CLI:

| career-ops (CLI) | Portal |
|---|---|
| Onboarding (`doctor.mjs --init-templates`, `onboard-write.mjs`, tracker seed) | Register → **Profile & CV** form |
| `oferta` / `fursah` evaluation → report → `merge-tracker.mjs` | **Evaluate a job** (paste URL and/or JD text) |
| `fetch-jd.mjs` (ATS public APIs) | Automatic JD fetch for Greenhouse, Lever, Ashby, Workable… |
| `data/applications.md` + `set-status.mjs` | **My applications** table with status changes |
| `reports/*.md` | Rendered report page with fit advice (< 4.0 → do-not-apply warning) |
| `scan.mjs` + `portals.yml` | **Job feed** (one shared scan for all users; admin-triggered) |
| — | Account export (JSON) and permanent deletion |

Design and trade-offs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run locally

```bash
npm install                 # repository root: engine dependencies
cd portal && npm install    # portal dependencies
ANTHROPIC_API_KEY=sk-ant-... PORTAL_ADMIN_EMAILS=you@example.com npm start
```

Open http://127.0.0.1:3100. Without `ANTHROPIC_API_KEY` the portal runs but evaluations are
disabled. The first account whose email is in `PORTAL_ADMIN_EMAILS` becomes admin and can run
the feed scan from **Admin**.

## Deploy

```bash
DOCKER_BUILDKIT=1 docker build -f portal/Dockerfile -t jobs4sudanese .   # from the repo root
docker run -d -p 127.0.0.1:3100:3100 -v j4s-data:/data --env-file portal.env jobs4sudanese
```

Put it behind a TLS-terminating reverse proxy (Caddy/nginx/a cloud load balancer) and set
`PORTAL_TRUST_PROXY=1`. Every setting is listed in [`.env.example`](.env.example). Required in
production: `NODE_ENV=production`, `PORTAL_SECRET` (≥ 32 random chars), `ANTHROPIC_API_KEY`.

**Back up `PORTAL_DATA_DIR`.** It holds the SQLite database (`portal.sqlite`, WAL mode) and
every user's career-ops data root (`users/{uuid}/`), i.e. CVs and personal data.

**Feed companies** are configured in `$PORTAL_DATA_DIR/shared/portals.yml` (seeded from
`templates/portals.example.yml` on the first scan). Edit `tracked_companies` and
`title_filter` to suit Sudanese job seekers (remote-friendly employers, Gulf and regional
companies, NGOs that publish on Greenhouse/Lever/Ashby/Workable). If outbound traffic goes
through an HTTP proxy, set `CAREER_OPS_TRUST_PROXY_EGRESS=1` or the scanner refuses to fetch.

## Hard rules inherited from career-ops

- **Never applies or submits anything.** The portal evaluates and tracks; the user applies.
- **Never invents facts.** Evaluations are grounded only in the user's own CV and profile.
- **Postings are untrusted data.** The model has no tools; the backend persists the report
  through the engine's own scripts.
- Below 4.0/5 the report explicitly recommends not applying.

## Tests

```bash
cd portal && npm test
```

The end-to-end suite drives the real HTTP routes and the real engine scripts
(`doctor`, `onboard-write`, `reserve-report-num`, `persist-evaluation-report`,
`merge-tracker`, `set-status`) with a fake model, and covers tenant isolation, CSRF,
cross-origin posts, throttling, quotas, gate stops and malformed model output.
