/**
 * jobs.mjs: the evaluation/scan job queue.
 *
 * State lives in SQLite so a user can close the tab and come back, and so a
 * crash is visible: on boot, anything still "running" is marked failed rather
 * than left spinning forever. Workers run in-process with a global
 * concurrency cap (cost and rate-limit control) and one job per user at a
 * time (fairness). A multi-instance deployment swaps this for a durable queue
 * (docs/ARCHITECTURE.md, scaling path); the job table shape stays the same.
 */
import crypto from "node:crypto";

export class JobQueue {
  /**
   * @param {{db: import("node:sqlite").DatabaseSync, concurrency: number,
   *          handlers: Record<string, (job: object) => Promise<{status: string, result?: object, error?: string}>>}} opts
   */
  constructor({ db, concurrency, handlers }) {
    this.db = db;
    this.concurrency = concurrency;
    this.handlers = handlers;
    this.running = 0;
    this.runningUsers = new Set();
    this.idleWaiters = [];
    db.prepare("UPDATE jobs SET status = 'failed', error = 'Interrupted by a server restart. Please run it again.', updated_at = ? WHERE status IN ('running','queued')")
      .run(Date.now());
  }

  enqueue(userId, kind, input) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare("INSERT INTO jobs (id, user_id, kind, status, input, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
      .run(id, userId, kind, JSON.stringify(input), now, now);
    queueMicrotask(() => this.#pump());
    return id;
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!row) return null;
    return { ...row, input: JSON.parse(row.input), result: row.result ? JSON.parse(row.result) : null };
  }

  /** Evaluations this user started since local midnight UTC (quota window). */
  countToday(userId, kind) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    return this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND kind = ? AND created_at >= ? AND status != 'failed'")
      .get(userId, kind, start.getTime()).n;
  }

  activeFor(userId, kind) {
    return this.db.prepare("SELECT id FROM jobs WHERE user_id IS ? AND kind = ? AND status IN ('queued','running') ORDER BY created_at LIMIT 1")
      .get(userId, kind)?.id ?? null;
  }

  recent(userId, limit = 10) {
    return this.db.prepare("SELECT id, kind, status, input, result, error, created_at FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit)
      .map((r) => ({ ...r, input: JSON.parse(r.input), result: r.result ? JSON.parse(r.result) : null }));
  }

  /** Resolves when nothing is queued or running (tests, graceful shutdown). */
  idle() {
    if (this.running === 0 && !this.#nextJob()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  #nextJob() {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 50").all();
    return rows.find((r) => !this.runningUsers.has(r.user_id ?? "system")) ?? null;
  }

  #pump() {
    while (this.running < this.concurrency) {
      const job = this.#nextJob();
      if (!job) break;
      this.#run(job);
    }
    if (this.running === 0 && !this.#nextJob()) {
      const waiters = this.idleWaiters.splice(0);
      waiters.forEach((w) => w());
    }
  }

  async #run(row) {
    const owner = row.user_id ?? "system";
    this.running += 1;
    this.runningUsers.add(owner);
    this.db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
    let outcome;
    try {
      const handler = this.handlers[row.kind];
      outcome = handler
        ? await handler({ ...row, input: JSON.parse(row.input) })
        : { status: "failed", error: `no handler for ${row.kind}` };
    } catch (e) {
      outcome = { status: "failed", error: `Unexpected error: ${e?.message ?? e}` };
    }
    this.db.prepare("UPDATE jobs SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(outcome.status, outcome.result ? JSON.stringify(outcome.result) : null, outcome.error ?? null, Date.now(), row.id);
    this.running -= 1;
    this.runningUsers.delete(owner);
    this.#pump();
  }
}
