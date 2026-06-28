import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  HOOK_HEADER_MARKER,
  assessDiffSeverity,
  hookPath,
  installHook,
  parseDiffFiles,
  readHookStatus,
  renderHookScript,
  uninstallHook,
} from "../src/bless.js";

function mkRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "oracle-bless-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  return dir;
}

let repos: string[] = [];
beforeEach(() => {
  repos = [];
});
afterEach(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true });
});
function newRepo(): string {
  const d = mkRepo();
  repos.push(d);
  return d;
}

describe("bless/parseDiffFiles", () => {
  it("parses diff --git headers and tallies +/- lines", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@",
      "+added",
      "-gone",
      "diff --git a/b.ts b/b.ts",
      "deleted file mode 100644",
      "--- a/b.ts",
      "+++ /dev/null",
      "-x",
      "-y",
    ].join("\n");
    const files = parseDiffFiles(diff);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1, removed: false });
    expect(files[1]).toMatchObject({ additions: 0, deletions: 2, removed: true });
  });
});

describe("bless/assessDiffSeverity", () => {
  it("returns severity 0 with no omens for a trivial benign diff", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@",
      "+hello world",
    ].join("\n");
    const v = assessDiffSeverity(diff);
    expect(v.severity).toBe(0);
    expect(v.omens).toEqual([]);
    expect(v.inputs.additions).toBe(1);
  });

  it("flags removed test files heavily", () => {
    const diff = [
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "deleted file mode 100644",
      "--- a/tests/a.test.ts",
      "+++ /dev/null",
      ...Array.from({ length: 5 }, () => "-line"),
    ].join("\n");
    const v = assessDiffSeverity(diff);
    expect(v.inputs.testFilesRemoved).toBe(1);
    expect(v.omens.some((o) => o.id === "tests-removed")).toBe(true);
    expect(v.severity).toBeGreaterThanOrEqual(6);
  });

  it("detects AWS-shaped access keys in additions and pins severity to 10", () => {
    const diff = [
      "diff --git a/cfg.ts b/cfg.ts",
      "--- a/cfg.ts",
      "+++ b/cfg.ts",
      "@@",
      "+const k = 'AKIAABCDEFGHIJKLMNOP';",
    ].join("\n");
    const v = assessDiffSeverity(diff);
    expect(v.omens.some((o) => o.id === "secret:aws-access-key")).toBe(true);
    expect(v.severity).toBe(10);
  });

  it("detects 'TODO: revert before merge' markers", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@",
      "+// TODO: revert before merge",
    ].join("\n");
    const v = assessDiffSeverity(diff);
    expect(v.omens.some((o) => o.id === "revert-marker")).toBe(true);
  });

  it("flags mass deletion when deletions dominate additions", () => {
    const adds = ["+keep"];
    const dels = Array.from({ length: 30 }, () => "-gone");
    const diff = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@",
      ...adds,
      ...dels,
    ].join("\n");
    const v = assessDiffSeverity(diff);
    expect(v.omens.some((o) => o.id === "mass-deletion")).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n+x\n";
    expect(assessDiffSeverity(diff)).toEqual(assessDiffSeverity(diff));
  });

  it("clamps severity to the 0–10 range", () => {
    const diff = [
      "diff --git a/s.ts b/s.ts",
      "--- a/s.ts",
      "+++ b/s.ts",
      "@@",
      "+AKIAABCDEFGHIJKLMNOP",
      "+sk-abcdefghijklmnopqrstuvwx",
      "+ghp_abcdefghijklmnopqrstuvwx",
      "+// TODO: revert before merge",
    ].join("\n");
    const v = assessDiffSeverity(diff);
    expect(v.severity).toBe(10);
  });
});

describe("bless/renderHookScript", () => {
  it("includes the header marker, threshold, and bin command", () => {
    const s = renderHookScript({ binCommand: "node /opt/oracle.js", threshold: 7 });
    expect(s).toContain(HOOK_HEADER_MARKER);
    expect(s).toContain("ORACLE_BLESS_THRESHOLD:-7");
    expect(s).toContain("node /opt/oracle.js bless --check -");
  });
});

describe("bless install/uninstall/status", () => {
  it("installs an executable hook with the marker and reports status", () => {
    const cwd = newRepo();
    const before = readHookStatus(cwd);
    expect(before.kind).toBe("not-installed");

    const res = installHook({ cwd, threshold: 5 });
    expect(res.action).toBe("installed");
    const path = hookPath(cwd);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o111;
    expect(mode).not.toBe(0);
    expect(readFileSync(path, "utf8")).toContain(HOOK_HEADER_MARKER);
    expect(readHookStatus(cwd).kind).toBe("installed");
  });

  it("is idempotent: re-installing reports 'replaced'", () => {
    const cwd = newRepo();
    installHook({ cwd });
    const second = installHook({ cwd });
    expect(second.action).toBe("replaced");
  });

  it("refuses to overwrite a foreign hook without --force", () => {
    const cwd = newRepo();
    const path = hookPath(cwd);
    mkdirSync(resolve(cwd, ".git/hooks"), { recursive: true });
    writeFileSync(path, "#!/bin/sh\necho not-ours\n");
    const res = installHook({ cwd });
    expect(res.action).toBe("refused");
    expect(readHookStatus(cwd).kind).toBe("foreign-hook");
  });

  it("overwrites a foreign hook with --force", () => {
    const cwd = newRepo();
    const path = hookPath(cwd);
    mkdirSync(resolve(cwd, ".git/hooks"), { recursive: true });
    writeFileSync(path, "#!/bin/sh\necho not-ours\n");
    const res = installHook({ cwd, force: true });
    expect(res.action).toBe("installed");
    expect(readHookStatus(cwd).kind).toBe("installed");
  });

  it("uninstall removes only an oracle-managed hook by default", () => {
    const cwd = newRepo();
    installHook({ cwd });
    const removed = uninstallHook({ cwd });
    expect(removed.action).toBe("removed");
    expect(existsSync(hookPath(cwd))).toBe(false);

    const path = hookPath(cwd);
    writeFileSync(path, "#!/bin/sh\necho not-ours\n");
    const refused = uninstallHook({ cwd });
    expect(refused.action).toBe("refused");
    expect(existsSync(path)).toBe(true);

    const forced = uninstallHook({ cwd, force: true });
    expect(forced.action).toBe("removed");
  });

  it("uninstall is a no-op when no hook exists", () => {
    const cwd = newRepo();
    expect(uninstallHook({ cwd }).action).toBe("absent");
  });
});
