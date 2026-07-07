import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { LoadedDiff } from "./sources/types.js";

/** SQLite schema version — bump when we add columns. */
const SCHEMA_VERSION = 1;

export interface HistoryRecordInput {
  loaded: LoadedDiff;
  methodId: string;
  personaId: string;
  spread?: string | null;
  symbols: unknown;
  reading: string;
  channel?: string;
}

export interface HistoryRow {
  id: number;
  createdAt: string;
  repo: string | null;
  prNumber: number | null;
  prUrl: string | null;
  diffSha256: string;
  methodId: string;
  personaId: string;
  spread: string | null;
  symbolsJson: string;
  reading: string;
  channel: string | null;
  outcome: string | null;
  outcomeAt: string | null;
}

export type Outcome = "merged" | "closed" | "abandoned";

export interface HistoryStats {
  total: number;
  byOutcome: Record<string, number>;
  byMethod: Array<{ methodId: string; total: number; merged: number; closed: number; abandoned: number; pending: number }>;
  byPersona: Array<{ personaId: string; total: number; merged: number; closed: number; abandoned: number; pending: number }>;
}

/** Read the ORACLE_HISTORY env flag. Returns false when explicitly disabled. */
export function historyEnabledFromEnv(): boolean {
  const v = process.env.ORACLE_HISTORY;
  if (v == null || v === "") return true;
  return !/^(0|false|no|off)$/i.test(v);
}

/** Default DB path (respects ORACLE_HISTORY_PATH override). */
export function defaultHistoryPath(): string {
  if (process.env.ORACLE_HISTORY_PATH) return process.env.ORACLE_HISTORY_PATH;
  return join(homedir(), ".merge-oracle", "history.sqlite");
}

/** Extract owner/repo + PR number from a GitHub PR URL. */
export function parsePrOrigin(origin: string): { repo: string | null; prNumber: number | null; prUrl: string | null } {
  const m = origin.match(/^https?:\/\/github\.com\/([^\/]+\/[^\/]+)\/pull\/(\d+)/i);
  if (!m) return { repo: null, prNumber: null, prUrl: null };
  return { repo: m[1], prNumber: Number.parseInt(m[2], 10), prUrl: origin };
}

export class HistoryStore {
  private db_: Database.Database;
  readonly path: string;

  constructor(path: string = defaultHistoryPath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db_ = new Database(path);
    this.db_.pragma("journal_mode = WAL");
    this.migrate();
  }

  /**
   * Underlying handle. Kept read-only-ish (typed as the driver's Database)
   * so cohabiting modules like `reviewers/history.ts` can attach their own
   * tables without us re-exporting the schema surface.
   */
  get db(): Database.Database {
    return this.db_;
  }

  private migrate(): void {
    this.db_.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        repo TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        diff_sha256 TEXT NOT NULL,
        method_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        spread TEXT,
        symbols_json TEXT NOT NULL,
        reading TEXT NOT NULL,
        channel TEXT,
        outcome TEXT,
        outcome_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_readings_repo ON readings(repo);
      CREATE INDEX IF NOT EXISTS idx_readings_method ON readings(method_id);
      CREATE INDEX IF NOT EXISTS idx_readings_persona ON readings(persona_id);
      CREATE INDEX IF NOT EXISTS idx_readings_created ON readings(created_at DESC);
    `);
    const row = this.db_.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    const current = row ? Number.parseInt(row.value, 10) : 0;
    if (current < SCHEMA_VERSION) {
      // Future migrations go here, guarded by version checks.
      this.db_.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)")
        .run(String(SCHEMA_VERSION));
    }
  }

  close(): void {
    this.db_.close();
  }

  insert(input: HistoryRecordInput): HistoryRow {
    const sha = createHash("sha256").update(input.loaded.diff).digest("hex");
    const { repo, prNumber, prUrl } = parsePrOrigin(input.loaded.origin);
    const stmt = this.db_.prepare(`
      INSERT INTO readings (repo, pr_number, pr_url, diff_sha256, method_id, persona_id, spread, symbols_json, reading, channel)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      repo,
      prNumber,
      prUrl,
      sha,
      input.methodId,
      input.personaId,
      input.spread ?? null,
      JSON.stringify(input.symbols),
      input.reading,
      input.channel ?? null,
    );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): HistoryRow | null {
    const row = this.db_.prepare(SELECT_SQL + " WHERE id = ?").get(id) as any;
    return row ? mapRow(row) : null;
  }

  list(filter: {
    repo?: string;
    methodId?: string;
    personaId?: string;
    limit?: number;
  } = {}): HistoryRow[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.repo) { where.push("repo = ?"); params.push(filter.repo); }
    if (filter.methodId) { where.push("method_id = ?"); params.push(filter.methodId); }
    if (filter.personaId) { where.push("persona_id = ?"); params.push(filter.personaId); }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 20));
    const rows = this.db_.prepare(SELECT_SQL + clause + " ORDER BY id DESC LIMIT ?").all(...params, limit) as any[];
    return rows.map(mapRow);
  }

  setOutcome(id: number, outcome: Outcome): HistoryRow | null {
    const info = this.db_.prepare(
      "UPDATE readings SET outcome = ?, outcome_at = datetime('now') WHERE id = ?",
    ).run(outcome, id);
    if (info.changes === 0) return null;
    return this.get(id);
  }

  stats(): HistoryStats {
    const total = (this.db_.prepare("SELECT COUNT(*) AS c FROM readings").get() as { c: number }).c;
    const outcomeRows = this.db_.prepare(
      "SELECT COALESCE(outcome, 'pending') AS o, COUNT(*) AS c FROM readings GROUP BY o",
    ).all() as Array<{ o: string; c: number }>;
    const byOutcome: Record<string, number> = {};
    for (const r of outcomeRows) byOutcome[r.o] = r.c;

    const groupBy = (col: "method_id" | "persona_id") =>
      (this.db_.prepare(
        `SELECT ${col} AS g,
           COUNT(*) AS total,
           SUM(CASE WHEN outcome = 'merged' THEN 1 ELSE 0 END) AS merged,
           SUM(CASE WHEN outcome = 'closed' THEN 1 ELSE 0 END) AS closed,
           SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
           SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS pending
         FROM readings GROUP BY ${col} ORDER BY total DESC`,
      ).all() as Array<{ g: string; total: number; merged: number; closed: number; abandoned: number; pending: number }>);

    return {
      total,
      byOutcome,
      byMethod: groupBy("method_id").map((r) => ({
        methodId: r.g, total: r.total, merged: r.merged, closed: r.closed, abandoned: r.abandoned, pending: r.pending,
      })),
      byPersona: groupBy("persona_id").map((r) => ({
        personaId: r.g, total: r.total, merged: r.merged, closed: r.closed, abandoned: r.abandoned, pending: r.pending,
      })),
    };
  }
}

const SELECT_SQL = `SELECT id, created_at, repo, pr_number, pr_url, diff_sha256,
  method_id, persona_id, spread, symbols_json, reading, channel, outcome, outcome_at
  FROM readings`;

function mapRow(row: any): HistoryRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    repo: row.repo,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    diffSha256: row.diff_sha256,
    methodId: row.method_id,
    personaId: row.persona_id,
    spread: row.spread,
    symbolsJson: row.symbols_json,
    reading: row.reading,
    channel: row.channel,
    outcome: row.outcome,
    outcomeAt: row.outcome_at,
  };
}

export function renderHistoryTable(rows: HistoryRow[]): string {
  if (rows.length === 0) return "no readings recorded yet. consult the oracle first.\n";
  const header = ["id", "when", "repo/pr", "method", "persona", "outcome"];
  const data = rows.map((r) => [
    String(r.id),
    r.createdAt,
    r.repo ? `${r.repo}${r.prNumber ? "#" + r.prNumber : ""}` : "(local)",
    r.methodId,
    r.personaId,
    r.outcome ?? "-",
  ]);
  const widths = header.map((_, i) => Math.max(header[i].length, ...data.map((row) => row[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...data.map(fmt)].join("\n") + "\n";
}

export function renderHistoryDetail(row: HistoryRow): string {
  const lines = [
    `#${row.id} — ${row.createdAt}`,
    `  repo:    ${row.repo ?? "(local diff)"}${row.prNumber ? "  PR #" + row.prNumber : ""}`,
    row.prUrl ? `  url:     ${row.prUrl}` : "",
    `  method:  ${row.methodId}`,
    `  persona: ${row.personaId}`,
    row.spread ? `  spread:  ${row.spread}` : "",
    row.channel ? `  channel: ${row.channel}` : "",
    `  diff:    sha256:${row.diffSha256.slice(0, 16)}…`,
    `  outcome: ${row.outcome ?? "pending"}${row.outcomeAt ? " (at " + row.outcomeAt + ")" : ""}`,
    "",
    row.reading,
    "",
  ].filter((l) => l !== "");
  return lines.join("\n") + "\n";
}
