/**
 * views.mjs: server-rendered pages.
 *
 * `html` is a tagged template that escapes every interpolated value unless it
 * is already a SafeHtml (another `html` result or `raw()`). Reports are model
 * output derived from untrusted postings, so they are rendered by markdown-it
 * with raw HTML disabled; nothing from a posting can reach the DOM as markup.
 * No inline scripts anywhere: the CSP forbids them.
 */
import MarkdownIt from "markdown-it";
import { DIR, translator } from "./i18n.mjs";

class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const raw = (s) => new SafeHtml(String(s));

export function esc(v) {
  if (v instanceof SafeHtml) return v.s;
  if (v == null || v === false) return "";
  if (Array.isArray(v)) return v.map(esc).join("");
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function html(strings, ...values) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += esc(values[i]);
  });
  return new SafeHtml(out);
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: true });
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  tokens[idx].attrSet("rel", "noopener noreferrer nofollow");
  tokens[idx].attrSet("target", "_blank");
  return defaultLink(tokens, idx, opts, env, self);
};
export const renderMarkdown = (text) => raw(md.render(String(text ?? "")));

// ---------------------------------------------------------------------------

function csrfField(csrf) {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

function navLink(href, label, current) {
  return html`<a href="${href}"${raw(current === href ? ' aria-current="page"' : "")}>${label}</a>`;
}

export function layout(ctx, { title, body, refresh = 0 }) {
  const { t, lang, user, path, csrf } = ctx;
  const nav = user
    ? html`
      ${navLink("/dashboard", t("nav_dashboard"), path)}
      ${navLink("/feed", t("nav_feed"), path)}
      ${navLink("/evaluate", t("nav_evaluate"), path)}
      ${navLink("/tracker", t("nav_tracker"), path)}
      ${navLink("/profile", t("nav_profile"), path)}
      ${user.role === "admin" ? navLink("/admin", t("nav_admin"), path) : ""}
      ${navLink("/account", t("nav_account"), path)}
      <form method="post" action="/logout" class="inline">${csrfField(csrf)}<button class="link">${t("nav_logout")}</button></form>`
    : html`${navLink("/login", t("nav_login"), path)} ${navLink("/register", t("nav_register"), path)}`;
  return html`<!doctype html>
<html lang="${lang}" dir="${DIR[lang]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? raw(`<meta http-equiv="refresh" content="${Number(refresh)}">`) : ""}
<title>${title ? `${title} · ` : ""}${t("app_name")}</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
</head>
<body>
<a class="skip" href="#main">${lang === "ar" ? "تخطَّ إلى المحتوى" : "Skip to content"}</a>
<header class="top">
  <a class="brand" href="${user ? "/dashboard" : "/"}">${t("app_name")}</a>
  <nav aria-label="main">${nav}</nav>
  <a class="lang" href="/lang?to=${lang === "ar" ? "en" : "ar"}&next=${encodeURIComponent(path)}" hreflang="${lang === "ar" ? "en" : "ar"}">${t("switch_lang")}</a>
</header>
<main id="main">
${ctx.flash ? html`<p class="flash ${ctx.flash.kind}" role="status">${ctx.flash.text}</p>` : ""}
${body}
</main>
<footer>${t("footer")}</footer>
</body>
</html>`;
}

function field(label, input, hint) {
  return html`<label class="field"><span>${label}</span>${input}${hint ? html`<small>${hint}</small>` : ""}</label>`;
}

function errorBox(t, errors) {
  if (!errors?.length) return "";
  return html`<div class="error" role="alert"><ul>${errors.map((e) => html`<li>${t(e.key ?? e, e.vars)}</li>`)}</ul></div>`;
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

export function landingPage(ctx) {
  const { t } = ctx;
  const feature = (k) => html`<div class="card"><h3>${t(`landing_${k}_t`)}</h3><p>${t(`landing_${k}_d`)}</p></div>`;
  return layout(ctx, {
    title: "",
    body: html`
<section class="hero">
  <h1>${t("landing_h1")}</h1>
  <p class="lead">${t("landing_p1")}</p>
  <p><a class="btn" href="/register">${t("cta_start")}</a></p>
</section>
<section class="grid4">${["f1", "f2", "f3", "f4"].map(feature)}</section>`,
  });
}

export function registerPage(ctx, { errors = [], values = {} } = {}) {
  const { t } = ctx;
  return layout(ctx, {
    title: t("nav_register"),
    body: html`
<section class="narrow card">
<h1>${t("nav_register")}</h1>
${errorBox(t, errors)}
<form method="post" action="/register" novalidate>
  ${csrfField(ctx.csrf)}
  ${field(t("f_name"), html`<input name="name" required maxlength="120" autocomplete="name" value="${values.name ?? ""}">`)}
  ${field(t("f_email"), html`<input name="email" type="email" required maxlength="254" autocomplete="email" dir="ltr" value="${values.email ?? ""}">`)}
  ${field(t("f_password"), html`<input name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password" dir="ltr">`, t("f_password_hint"))}
  <label class="check"><input type="checkbox" name="consent" value="1" required> <span>${t("consent")}</span></label>
  <button class="btn">${t("f_submit_register")}</button>
</form>
<p>${t("have_account")} <a href="/login">${t("nav_login")}</a></p>
</section>`,
  });
}

export function loginPage(ctx, { errors = [], values = {} } = {}) {
  const { t } = ctx;
  return layout(ctx, {
    title: t("nav_login"),
    body: html`
<section class="narrow card">
<h1>${t("nav_login")}</h1>
${errorBox(t, errors)}
<form method="post" action="/login" novalidate>
  ${csrfField(ctx.csrf)}
  ${field(t("f_email"), html`<input name="email" type="email" required autocomplete="username" dir="ltr" value="${values.email ?? ""}">`)}
  ${field(t("f_password"), html`<input name="password" type="password" required autocomplete="current-password" dir="ltr">`)}
  <button class="btn">${t("f_submit_login")}</button>
</form>
<p>${t("no_account")} <a href="/register">${t("nav_register")}</a></p>
</section>`,
  });
}

export function messagePage(ctx, { title, text, status = "" }) {
  return layout(ctx, { title, body: html`<section class="narrow card ${status}"><h1>${title}</h1><p>${text}</p></section>` });
}

// ---------------------------------------------------------------------------
// Signed-in pages
// ---------------------------------------------------------------------------

export function scoreBadge(score) {
  const n = Number.parseFloat(String(score ?? ""));
  if (!Number.isFinite(n)) return html`<span class="score">${score || "—"}</span>`;
  const band = n >= 4.0 ? "good" : n >= 3.0 ? "mid" : "low";
  return html`<span class="score ${band}" dir="ltr">${n.toFixed(1)}/5</span>`;
}

function statusLabel(t, s) {
  const k = `st_${s}`;
  const v = t(k);
  return v === k ? s : v;
}

function jobLine(t, j) {
  const what = j.kind === "scan" ? t("adm_scan") : (j.input?.url || j.input?.title || t("nav_evaluate"));
  const when = new Date(j.created_at).toISOString().slice(0, 16).replace("T", " ");
  const link = j.status === "done" && j.result?.reportFile ? `/reports/${j.result.reportFile}` : `/jobs/${j.id}`;
  return html`<li><a href="${link}">${what}</a> <span class="muted" dir="ltr">${when}</span> <span class="tag ${j.status}">${t(`js_${j.status}`)}</span></li>`;
}

export function dashboardPage(ctx, { onboarding, rows, recent, quotaLeft }) {
  const { t, user } = ctx;
  const count = (states) => rows.filter((r) => states.includes(r.status)).length;
  const setup = !onboarding.profile || !onboarding.cv;
  return layout(ctx, {
    title: t("nav_dashboard"),
    body: html`
<h1>${t("dash_h", { name: user.name })}</h1>
${setup ? html`<section class="card notice"><h2>${t("dash_setup_h")}</h2><ol>
  <li class="${onboarding.profile ? "done" : ""}"><a href="/profile">${t("dash_setup_profile")}</a></li>
  <li class="${onboarding.cv ? "done" : ""}"><a href="/profile#cv">${t("dash_setup_cv")}</a></li>
</ol></section>` : ""}
<section class="stats">
  <div class="stat"><b>${rows.length}</b><span>${t("dash_stats_total")}</span></div>
  <div class="stat"><b>${count(["Applied", "Responded", "Assessment"])}</b><span>${t("dash_stats_applied")}</span></div>
  <div class="stat"><b>${count(["Interview"])}</b><span>${t("dash_stats_interview")}</span></div>
  <div class="stat"><b>${count(["Offer", "Hired"])}</b><span>${t("dash_stats_offer")}</span></div>
</section>
<p class="muted">${t("dash_quota", { n: quotaLeft })} · <a class="btn small" href="/evaluate">${t("nav_evaluate")}</a></p>
<section class="card"><h2>${t("dash_recent")}</h2>
${recent.length ? html`<ul class="plain">${recent.map((j) => jobLine(t, j))}</ul>` : html`<p class="muted">${t("dash_none")}</p>`}
</section>`,
  });
}

export function profilePage(ctx, { profile, cv, errors = [] }) {
  const { t } = ctx;
  const p = profile ?? { currency: "USD", output_lang: ctx.lang, market: "global" };
  const opt = (value, label, current) => html`<option value="${value}"${raw(value === current ? " selected" : "")}>${label}</option>`;
  return layout(ctx, {
    title: t("prof_h"),
    body: html`
<h1>${t("prof_h")}</h1>
<p class="muted">${t("prof_p")}</p>
${errorBox(t, errors)}
<form method="post" action="/profile" class="card">
  ${csrfField(ctx.csrf)}
  <h2>${t("prof_basics")}</h2>
  <div class="cols">
  ${field(t("f_name"), html`<input name="full_name" required maxlength="120" value="${p.full_name ?? ""}">`)}
  ${field(t("f_email"), html`<input name="email" type="email" required maxlength="254" dir="ltr" value="${p.email ?? ctx.user.email}">`)}
  ${field(t("f_phone"), html`<input name="phone" maxlength="40" dir="ltr" value="${p.phone ?? ""}">`)}
  ${field(t("f_location"), html`<input name="location" required maxlength="120" value="${p.location ?? ""}">`)}
  ${field(t("f_country"), html`<input name="country" maxlength="80" value="${p.country ?? ""}">`)}
  ${field(t("f_city"), html`<input name="city" maxlength="80" value="${p.city ?? ""}">`)}
  ${field(t("f_timezone"), html`<input name="timezone" maxlength="60" dir="ltr" placeholder="Africa/Khartoum" value="${p.timezone ?? ""}">`)}
  ${field(t("f_range"), html`<input name="target_range" maxlength="60" dir="ltr" placeholder="2000-3500 / month" value="${p.target_range ?? ""}">`)}
  ${field(t("f_currency"), html`<input name="currency" maxlength="3" dir="ltr" value="${p.currency ?? "USD"}">`)}
  ${field(t("f_minimum"), html`<input name="minimum" maxlength="40" dir="ltr" value="${p.minimum ?? ""}">`)}
  ${field(t("f_output"), html`<select name="output_lang">${opt("ar", t("lang_ar"), p.output_lang)}${opt("en", t("lang_en"), p.output_lang)}</select>`)}
  ${field(t("f_market"), html`<select name="market">${opt("global", t("market_global"), p.market)}${opt("gulf", t("market_gulf"), p.market)}</select>`)}
  </div>
  ${field(t("f_roles"), html`<textarea name="target_roles" rows="4" required maxlength="1500">${p.target_roles ?? ""}</textarea>`)}
  <button class="btn">${t("prof_save")}</button>
</form>
<form method="post" action="/profile/cv" class="card" id="cv">
  ${csrfField(ctx.csrf)}
  <h2>${t("prof_cv")}</h2>
  <p class="muted">${t("prof_cv_p")}</p>
  <textarea name="cv" rows="22" dir="auto" maxlength="60000" class="mono">${cv}</textarea>
  <button class="btn">${t("prof_save_cv")}</button>
</form>`,
  });
}

export function evaluatePage(ctx, { errors = [], values = {}, quotaLeft }) {
  const { t } = ctx;
  return layout(ctx, {
    title: t("ev_h"),
    body: html`
<h1>${t("ev_h")}</h1>
<p class="muted">${t("ev_p")}</p>
${errorBox(t, errors)}
<form method="post" action="/evaluate" class="card">
  ${csrfField(ctx.csrf)}
  ${field(t("f_url"), html`<input name="url" type="url" maxlength="2000" dir="ltr" value="${values.url ?? ""}">`)}
  ${field(t("f_jd"), html`<textarea name="jd" rows="16" dir="auto" maxlength="60000">${values.jd ?? ""}</textarea>`, t("f_jd_hint"))}
  <p class="muted small">${t("ev_untrusted")}</p>
  <p class="muted small">${t("dash_quota", { n: quotaLeft })}</p>
  <button class="btn">${t("ev_submit")}</button>
</form>`,
  });
}

export function jobPage(ctx, job) {
  const { t } = ctx;
  const active = job.status === "queued" || job.status === "running";
  let body;
  if (active) {
    body = html`<section class="narrow card center"><div class="spinner" aria-hidden="true"></div>
      <h1>${t("job_h")}</h1><p>${job.status === "queued" ? t("job_queued") : t("job_running")}</p>
      <p class="muted small">${t("job_refresh")}</p></section>`;
  } else {
    const title = job.status === "stopped" ? t("job_stopped") : t("job_failed");
    body = html`<section class="narrow card ${job.status}"><h1>${title}</h1><p dir="auto">${job.error ?? ""}</p>
      <p><a class="btn" href="/evaluate?url=${encodeURIComponent(job.input?.url ?? "")}">${t("job_retry")}</a></p></section>`;
  }
  return layout(ctx, { title: t("job_h"), body, refresh: active ? 5 : 0 });
}

export function trackerPage(ctx, { rows, states }) {
  const { t } = ctx;
  const statusForm = (r) => html`<form method="post" action="/tracker/${r.num}/status" class="row-form">
    ${csrfField(ctx.csrf)}
    <select name="status" aria-label="${t("col_status")}">${states.map((s) => html`<option value="${s}"${raw(s === r.status ? " selected" : "")}>${statusLabel(t, s)}</option>`)}</select>
    <button class="btn small">${t("update")}</button></form>`;
  return layout(ctx, {
    title: t("tr_h"),
    body: html`
<h1>${t("tr_h")}</h1>
${rows.length ? html`<div class="table-wrap"><table>
<thead><tr><th>${t("col_num")}</th><th>${t("col_date")}</th><th>${t("col_company")}</th><th>${t("col_role")}</th><th>${t("col_score")}</th><th>${t("col_status")}</th><th>${t("col_report")}</th></tr></thead>
<tbody>${rows.map((r) => html`<tr>
  <td dir="ltr">${r.num}</td><td dir="ltr">${r.date}</td><td dir="auto">${r.company}</td><td dir="auto">${r.role}</td>
  <td>${scoreBadge(r.score)}</td><td>${statusForm(r)}</td>
  <td>${r.reportFile ? html`<a href="/reports/${r.reportFile}">${t("view")}</a>` : "—"}</td></tr>`)}</tbody>
</table></div>` : html`<p class="card muted">${t("tr_empty")} <a href="/evaluate">${t("nav_evaluate")}</a></p>`}`,
  });
}

export function reportPage(ctx, { markdown, row }) {
  const { t } = ctx;
  const n = Number.parseFloat(String(row?.score ?? ""));
  const advice = Number.isFinite(n)
    ? html`<p class="flash ${n < 4.0 ? "warn" : "ok"}">${n < 4.0 ? t("low_fit") : t("good_fit")}</p>`
    : "";
  return layout(ctx, {
    title: row ? `${row.company} · ${row.role}` : t("col_report"),
    body: html`
<p><a href="/tracker">← ${t("rep_back")}</a></p>
${row ? html`<div class="report-head card"><div><h1 dir="auto">${row.company} · ${row.role}</h1>
  <p class="muted">${scoreBadge(row.score)} · ${statusLabel(t, row.status)}</p></div>
  ${row.url ? html`<a class="btn" href="${row.url}" target="_blank" rel="noopener noreferrer nofollow">${t("open_posting")}</a>` : ""}</div>` : ""}
${advice}
<p class="muted small">${t("apply_note")}</p>
<article class="report card" dir="auto">${renderMarkdown(markdown)}</article>`,
  });
}

export function feedPage(ctx, { items, total, q, updatedAt }) {
  const { t } = ctx;
  return layout(ctx, {
    title: t("feed_h"),
    body: html`
<h1>${t("feed_h")}</h1>
<p class="muted">${t("feed_p")}</p>
<form method="get" action="/feed" class="search">
  <input name="q" value="${q}" placeholder="${t("feed_search")}" aria-label="${t("feed_search")}">
  <button class="btn small">${t("search")}</button>
</form>
${updatedAt ? html`<p class="muted small">${t("feed_updated", { when: updatedAt.toISOString().slice(0, 16).replace("T", " ") })} · ${items.length}/${total}</p>` : ""}
${items.length ? html`<ul class="feed">${items.map((it) => html`<li class="card">
  <div><b dir="auto">${it.title}</b><div class="muted" dir="auto">${it.company}${it.location ? ` · ${it.location}` : ""}${it.comp ? ` · ${it.comp}` : ""}${it.posted ? ` · ${it.posted}` : ""}</div></div>
  <div class="actions"><a href="${it.url}" target="_blank" rel="noopener noreferrer nofollow">${t("open_posting")}</a>
  <a class="btn small" href="/evaluate?url=${encodeURIComponent(it.url)}">${t("feed_eval")}</a></div></li>`)}</ul>`
    : html`<p class="card muted">${t("feed_empty")}</p>`}`,
  });
}

export function adminPage(ctx, { users, evals, lastScan, portalsPath }) {
  const { t } = ctx;
  return layout(ctx, {
    title: t("adm_h"),
    body: html`
<h1>${t("adm_h")}</h1>
<section class="stats">
  <div class="stat"><b>${users}</b><span>${t("adm_users")}</span></div>
  <div class="stat"><b>${evals}</b><span>${t("adm_evals")}</span></div>
</section>
<section class="card">
  <form method="post" action="/admin/scan">${csrfField(ctx.csrf)}<button class="btn">${t("adm_scan")}</button></form>
  ${lastScan ? html`<p class="muted">${t("adm_last_scan")}: <span class="tag ${lastScan.status}">${t(`js_${lastScan.status}`)}</span> <span dir="ltr">${new Date(lastScan.updated_at).toISOString().slice(0, 16).replace("T", " ")}</span></p>
  ${lastScan.error ? html`<pre class="mono small" dir="ltr">${lastScan.error}</pre>` : ""}
  ${lastScan.result?.summary ? html`<pre class="mono small" dir="ltr">${lastScan.result.summary}</pre>` : ""}` : ""}
  <p class="muted small">${t("adm_portals", { path: portalsPath })}</p>
</section>`,
  });
}

export function accountPage(ctx, { errors = [] } = {}) {
  const { t } = ctx;
  return layout(ctx, {
    title: t("acc_h"),
    body: html`
<h1>${t("acc_h")}</h1>
${errorBox(t, errors)}
<section class="card"><h2>${t("acc_export")}</h2><p class="muted">${t("acc_export_p")}</p>
  <p><a class="btn" href="/account/export">${t("acc_export")}</a></p></section>
<section class="card danger"><h2>${t("acc_delete")}</h2><p>${t("acc_delete_p")}</p>
<form method="post" action="/account/delete">
  ${csrfField(ctx.csrf)}
  ${field(t("acc_delete_confirm"), html`<input name="confirm" dir="ltr" autocomplete="off" required>`)}
  <button class="btn danger">${t("acc_delete")}</button>
</form></section>`,
  });
}

export function makeCtx({ lang, user = null, path = "/", csrf = "", flash = null }) {
  return { lang, t: translator(lang), user, path, csrf, flash };
}
