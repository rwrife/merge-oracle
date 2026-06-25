import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function readText(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

// We intentionally avoid pulling in a YAML parser — these are structural
// substring checks that catch the things most likely to break the action.

describe("action.yml — composite GitHub Action shape", () => {
  const action = readText("action.yml");

  it("declares a composite action with branding", () => {
    expect(action).toMatch(/^name:\s*"merge-oracle"/m);
    expect(action).toMatch(/^\s*using:\s*"composite"/m);
    expect(action).toMatch(/^branding:/m);
  });

  it("exposes the documented inputs", () => {
    for (const input of [
      "method:",
      "offline:",
      "version:",
      "node-version:",
      "marker:",
      "github-token:",
      "openai-api-key:",
      "openai-base-url:",
      "openai-model:",
    ]) {
      expect(action).toContain(input);
    }
  });

  it("guards on pull_request events", () => {
    expect(action).toMatch(/github\.event\.pull_request\.number/);
    expect(action).toMatch(/merge-oracle action must run on a pull_request event/);
  });

  it("installs the npm package and invokes the oracle CLI", () => {
    expect(action).toMatch(/npm install -g "@rwrife\/merge-oracle@\$\{ORACLE_VERSION\}"/);
    expect(action).toMatch(/oracle --version/);
    expect(action).toMatch(/oracle "\$\{args\[@\]\}"/);
  });

  it("fetches the diff via gh and feeds it to oracle read", () => {
    expect(action).toMatch(/gh pr diff "\$\{PR_NUMBER\}" --repo "\$\{REPO\}"/);
    expect(action).toMatch(/args=\(read /);
  });

  it("uses a sticky comment marker via the GitHub REST API", () => {
    expect(action).toMatch(/<!-- merge-oracle:sticky -->/);
    expect(action).toMatch(/repos\/\$\{REPO\}\/issues\/\$\{PR_NUMBER\}\/comments/);
    expect(action).toMatch(/-X PATCH/);
    expect(action).toMatch(/-X POST/);
  });

  it("exposes reading and method outputs", () => {
    expect(action).toMatch(/^outputs:/m);
    expect(action).toMatch(/^\s*reading:/m);
    expect(action).toMatch(/steps\.read\.outputs\.reading/);
  });
});

describe("examples/workflow.yml", () => {
  const wf = readText("examples/workflow.yml");

  it("triggers on pull_request and uses rwrife/merge-oracle@v1", () => {
    expect(wf).toMatch(/on:\s*\n\s*pull_request:/);
    expect(wf).toMatch(/uses:\s*rwrife\/merge-oracle@v1/);
    expect(wf).toMatch(/pull-requests:\s*write/);
  });
});
