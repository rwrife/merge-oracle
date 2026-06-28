import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * `oracle bless` — opt-in git pre-push hook that performs a fast offline
 * reading on the outgoing diff and aborts the push when the verdict is dire.
 *
 * The hook itself is intentionally tiny: it pipes `git diff` into
 * `oracle bless --check -`, which computes a numeric severity (0–10) from
 * pure heuristics on the diff (no LLM, no network). The hook script exits
 * non-zero when severity meets or exceeds `ORACLE_BLESS_THRESHOLD`
 * (default 8). Standard git escape hatches apply (`git push --no-verify`).
 */

export const HOOK_HEADER_MARKER = "# managed by: oracle bless";
export const DEFAULT_BLESS_THRESHOLD = 8;

export type BlessStatus =
  | { kind: "installed"; path: string }
  | { kind: "not-installed"; path: string }
  | { kind: "foreign-hook"; path: string };

export interface BlessOmen {
  id: string;
  weight: number; // 0–10 contribution; capped per omen
  message: string;
}

export interface BlessVerdict {
  severity: number; // 0–10 (clamped)
  omens: BlessOmen[];
  summary: string;
  inputs: {
    additions: number;
    deletions: number;
    filesChanged: number;
    testFilesRemoved: number;
  };
}

/* ------------------------------------------------------------------------- */
/* Heuristics                                                                */
/* ------------------------------------------------------------------------- */

interface DiffFileInfo {
  path: string;
  additions: number;
  deletions: number;
  removed: boolean;
}

export function parseDiffFiles(diff: string): DiffFileInfo[] {
  const files: DiffFileInfo[] = [];
  let current: DiffFileInfo | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      if (current) files.push(current);
      current = { path: header[2], additions: 0, deletions: 0, removed: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("deleted file mode")) current.removed = true;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    else if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
  }
  if (current) files.push(current);
  return files;
}

const TEST_PATH = /(^|\/)(tests?|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$/i;

function isTestFile(path: string): boolean {
  return TEST_PATH.test(path) || TEST_FILE.test(path);
}

/** Substrings that look like secrets when present in additions. */
const SECRET_PATTERNS: ReadonlyArray<{ id: string; re: RegExp; label: string }> = [
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key id" },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: "OpenAI-style secret key" },
  { id: "github-token", re: /\bghp_[A-Za-z0-9]{20,}\b/, label: "GitHub personal access token" },
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, label: "PEM private key" },
];

const REVERT_MARKER = /TODO:\s*revert\s+before\s+merge/i;

function additionsOnly(diff: string): string {
  const out: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("+")) out.push(line.slice(1));
  }
  return out.join("\n");
}

/**
 * Pure-heuristic severity assessment of a diff. Deterministic, offline.
 * Severity is clamped to 0–10. The hook compares it against the threshold.
 */
export function assessDiffSeverity(diff: string): BlessVerdict {
  const files = parseDiffFiles(diff);
  const additions = files.reduce((a, f) => a + f.additions, 0);
  const deletions = files.reduce((a, f) => a + f.deletions, 0);
  const testFilesRemoved = files.filter((f) => f.removed && isTestFile(f.path)).length;

  const adds = additionsOnly(diff);
  const omens: BlessOmen[] = [];

  // Mass deletion vs additions (catches drive-by purges).
  if (deletions > additions * 3 && deletions >= 20) {
    omens.push({
      id: "mass-deletion",
      weight: 4,
      message: `deletions (${deletions}) dwarf additions (${additions}) — the cards favor caution`,
    });
  }

  // Test files vanishing entirely.
  if (testFilesRemoved > 0) {
    omens.push({
      id: "tests-removed",
      weight: Math.min(10, 5 + testFilesRemoved),
      message: `${testFilesRemoved} test file(s) removed — the augurs grow restless`,
    });
  }

  // Secret-shaped strings in additions.
  for (const pat of SECRET_PATTERNS) {
    if (pat.re.test(adds)) {
      omens.push({
        id: `secret:${pat.id}`,
        weight: 10,
        message: `${pat.label} detected in additions — the omen is dire`,
      });
    }
  }

  // "TODO: revert before merge" sentinel.
  if (REVERT_MARKER.test(adds)) {
    omens.push({
      id: "revert-marker",
      weight: 6,
      message: "found a 'TODO: revert before merge' marker — the runes whisper warning",
    });
  }

  // Gigantic diffs.
  const churn = additions + deletions;
  if (churn >= 2000) {
    omens.push({
      id: "huge-diff",
      weight: 3,
      message: `${churn} lines of churn across ${files.length} file(s) — the spread is unwieldy`,
    });
  }

  const raw = omens.reduce((s, o) => s + o.weight, 0);
  const severity = Math.max(0, Math.min(10, raw));

  const summary =
    severity === 0
      ? "the oracle finds no ill omens — push is blessed."
      : omens.map((o) => `  • [${o.weight}] ${o.message}`).join("\n");

  return {
    severity,
    omens,
    summary,
    inputs: {
      additions,
      deletions,
      filesChanged: files.length,
      testFilesRemoved,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Hook install / uninstall / status                                         */
/* ------------------------------------------------------------------------- */

export function findGitDir(cwd: string = process.cwd()): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return resolve(cwd, out);
  } catch {
    throw new Error("not inside a git working tree — run `git init` first");
  }
}

export function hookPath(cwd: string = process.cwd()): string {
  return resolve(findGitDir(cwd), "hooks", "pre-push");
}

export function renderHookScript(opts: {
  binCommand?: string;
  threshold?: number;
} = {}): string {
  const bin = opts.binCommand ?? "oracle";
  const threshold = opts.threshold ?? DEFAULT_BLESS_THRESHOLD;
  return `#!/usr/bin/env bash
${HOOK_HEADER_MARKER}
# Aborts the push when the oracle's severity meets/exceeds the threshold.
# Bypass with: git push --no-verify
set -u
THRESHOLD="\${ORACLE_BLESS_THRESHOLD:-${threshold}}"
RANGE="\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if git rev-parse --verify --quiet "@{push}" >/dev/null 2>&1; then
  DIFF="$(git diff @{push}..HEAD 2>/dev/null || true)"
else
  DIFF="$(git diff origin/HEAD..HEAD 2>/dev/null || git diff HEAD~1..HEAD 2>/dev/null || true)"
fi
if [ -z "\${DIFF}" ]; then
  exit 0
fi
printf '%s' "\${DIFF}" | ${bin} bless --check - --threshold "\${THRESHOLD}"
STATUS=$?
if [ "\${STATUS}" -ne 0 ]; then
  echo "🔮 oracle bless: push aborted (bypass with: git push --no-verify)" 1>&2
fi
exit "\${STATUS}"
`;
}

export function readHookStatus(cwd: string = process.cwd()): BlessStatus {
  const path = hookPath(cwd);
  if (!existsSync(path)) return { kind: "not-installed", path };
  const contents = readFileSync(path, "utf8");
  if (contents.includes(HOOK_HEADER_MARKER)) return { kind: "installed", path };
  return { kind: "foreign-hook", path };
}

export interface InstallResult {
  action: "installed" | "replaced" | "refused";
  path: string;
  reason?: string;
}

export function installHook(opts: {
  cwd?: string;
  force?: boolean;
  binCommand?: string;
  threshold?: number;
} = {}): InstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const path = hookPath(cwd);
  const status = readHookStatus(cwd);
  if (status.kind === "foreign-hook" && !opts.force) {
    return {
      action: "refused",
      path,
      reason: "a non-oracle pre-push hook already exists — re-run with --force to overwrite",
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  const script = renderHookScript({
    binCommand: opts.binCommand,
    threshold: opts.threshold,
  });
  writeFileSync(path, script, { encoding: "utf8" });
  chmodSync(path, 0o755);
  return {
    action: status.kind === "installed" ? "replaced" : "installed",
    path,
  };
}

export interface UninstallResult {
  action: "removed" | "absent" | "refused";
  path: string;
  reason?: string;
}

export function uninstallHook(opts: { cwd?: string; force?: boolean } = {}): UninstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const status = readHookStatus(cwd);
  if (status.kind === "not-installed") {
    return { action: "absent", path: status.path };
  }
  if (status.kind === "foreign-hook" && !opts.force) {
    return {
      action: "refused",
      path: status.path,
      reason: "pre-push hook is not managed by oracle — re-run with --force to remove anyway",
    };
  }
  unlinkSync(status.path);
  return { action: "removed", path: status.path };
}
