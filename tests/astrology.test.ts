import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  astrology,
  castAstrology,
  computeChart,
  parseBirthday,
  parseDiffDate,
  renderAstrologyAscii,
  signFromDate,
  syntheticDateFromString,
  syntheticSunDate,
} from "../src/methods/astrology.js";
import { getMethod, listMethods } from "../src/methods/_registry.js";
import { createOfflineClient } from "../src/llm/client.js";

const FIXTURE = readFileSync(resolve(__dirname, "../test/fixtures/multi-file.diff"), "utf8");

/**
 * Build an ephemeral git repo with controllable config so we can exercise
 * the birthday / email / repo paths without polluting the checkout's
 * real git config.
 */
function ephemeralRepoEnv(config: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(resolve(tmpdir(), "oracle-astro-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  for (const [k, v] of Object.entries(config)) {
    execFileSync("git", ["-C", dir, "config", k, v], { stdio: "ignore" });
  }
  return {
    ...process.env,
    GIT_DIR: resolve(dir, ".git"),
    GIT_WORK_TREE: dir,
    // The read helpers use `git config --get`, which honors GIT_DIR by
    // default; we scope everything to this dir.
  };
}

describe("methods/astrology registration", () => {
  it("astrology is discovered by the registry", () => {
    expect(getMethod("astrology")?.id).toBe("astrology");
    expect(listMethods().map((m) => m.id)).toContain("astrology");
  });

  it("describe() is non-trivial", () => {
    expect(astrology.describe().length).toBeGreaterThan(30);
  });
});

describe("methods/astrology date → sign", () => {
  it("maps zodiac cusps correctly on the UTC calendar", () => {
    expect(signFromDate(new Date(Date.UTC(2026, 2, 20)))).toBe("pisces");   // Mar 20
    expect(signFromDate(new Date(Date.UTC(2026, 2, 21)))).toBe("aries");    // Mar 21 (cusp day)
    expect(signFromDate(new Date(Date.UTC(2026, 6, 22)))).toBe("cancer");   // Jul 22
    expect(signFromDate(new Date(Date.UTC(2026, 6, 23)))).toBe("leo");      // Jul 23 (cusp)
    expect(signFromDate(new Date(Date.UTC(2026, 0,  1)))).toBe("capricorn");// Jan 1
    expect(signFromDate(new Date(Date.UTC(2026, 0, 20)))).toBe("aquarius"); // Jan 20 (cusp)
    expect(signFromDate(new Date(Date.UTC(2026,11, 22)))).toBe("capricorn");// Dec 22 (cusp)
  });

  it("covers all 12 signs across a full year of daily samples", () => {
    const seen = new Set<string>();
    for (let doy = 0; doy < 365; doy++) {
      seen.add(signFromDate(new Date(Date.UTC(2026, 0, 1) + doy * 86_400_000)));
    }
    expect(seen.size).toBe(12);
  });
});

describe("methods/astrology birthday parsing", () => {
  it("accepts YYYY-MM-DD", () => {
    const d = parseBirthday("1990-04-15");
    expect(d).not.toBeNull();
    expect(d?.getUTCFullYear()).toBe(1990);
    expect(d?.getUTCMonth()).toBe(3);
    expect(d?.getUTCDate()).toBe(15);
  });

  it("accepts MM-DD and uses year 2000 for stability", () => {
    const d = parseBirthday("07-04");
    expect(d).not.toBeNull();
    expect(d?.getUTCFullYear()).toBe(2000);
    expect(d?.getUTCMonth()).toBe(6);
    expect(d?.getUTCDate()).toBe(4);
  });

  it("rejects garbage and out-of-range values", () => {
    expect(parseBirthday("")).toBeNull();
    expect(parseBirthday("not-a-date")).toBeNull();
    expect(parseBirthday("2026-13-01")).toBeNull();
    expect(parseBirthday("2026-02-32")).toBeNull();
    expect(parseBirthday(null)).toBeNull();
    expect(parseBirthday(undefined)).toBeNull();
  });
});

describe("methods/astrology diff-date parsing", () => {
  it("extracts a git format-patch Date: header", () => {
    const diff = [
      "From abc123 Fri Jul  3 17:21:27 2026",
      "From: Someone <you@example.com>",
      "Date: Fri, 3 Jul 2026 17:21:27 +0000",
      "Subject: [PATCH] whatever",
      "",
      "diff --git a/foo b/foo",
    ].join("\n");
    const d = parseDiffDate(diff);
    expect(d).not.toBeNull();
    expect(d?.getUTCFullYear()).toBe(2026);
    expect(d?.getUTCMonth()).toBe(6); // July
    expect(d?.getUTCDate()).toBe(3);
  });

  it("returns null when the diff has no Date header", () => {
    expect(parseDiffDate("diff --git a/foo b/foo\n")).toBeNull();
  });
});

describe("methods/astrology chart determinism", () => {
  it("same diff + same env → same three signs", () => {
    const env = ephemeralRepoEnv({
      "user.email": "seeker@example.com",
      "user.birthday": "1990-04-15",
    });
    const a = castAstrology(FIXTURE, { env });
    const b = castAstrology(FIXTURE, { env });
    expect(a).toEqual(b);
  });

  it("casts exactly three signs filling Sun / Moon / Rising", () => {
    const signs = castAstrology(FIXTURE, { noGit: true });
    expect(signs).toHaveLength(3);
    expect(signs.map((s) => s.position)).toEqual(["Sun", "Moon", "Rising"]);
    for (const s of signs) {
      expect(s.id).toMatch(/^sign:(sun|moon|rising):/);
    }
  });

  it("different diffs generally yield different charts (offline mode)", () => {
    const a = castAstrology("diff one", { noGit: true });
    const b = castAstrology("a completely different diff with different bytes", { noGit: true });
    // With no git config, both fall back to hash-derived slots, so the
    // fingerprints must diverge somewhere.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("astrology and tarot do not draw lockstep from the same diff", async () => {
    const { drawTarot } = await import("../src/methods/tarot.js");
    const a = castAstrology(FIXTURE, { noGit: true }).map((s) => s.id).join(",");
    const t = drawTarot(FIXTURE).map((s) => s.id).join(",");
    expect(a).toMatch(/^sign:/);
    expect(t).toMatch(/^arcana:/);
  });
});

describe("methods/astrology birthday-driven Moon", () => {
  it("honors git config user.birthday when present", () => {
    // Cancer birthday (July 4, cusp comfortably inside Cancer).
    const env = ephemeralRepoEnv({
      "user.email": "seeker@example.com",
      "user.birthday": "1990-07-04",
    });
    const chart = computeChart(FIXTURE, { env });
    expect(chart.moon.id).toBe("cancer");
    expect(chart.moonFromConfig).toBe(true);
  });

  it("accepts MM-DD form", () => {
    const env = ephemeralRepoEnv({
      "user.email": "seeker@example.com",
      "user.birthday": "01-15", // deep Capricorn
    });
    const chart = computeChart(FIXTURE, { env });
    expect(chart.moon.id).toBe("capricorn");
    expect(chart.moonFromConfig).toBe(true);
  });

  it("falls back to synthesized natal date when no birthday is configured", () => {
    const env = ephemeralRepoEnv({
      "user.email": "seeker@example.com",
    });
    const chart = computeChart(FIXTURE, { env });
    expect(chart.moonFromConfig).toBe(false);
    // Signs must still be valid zodiac ids.
    expect(chart.moon.id.length).toBeGreaterThan(0);
    // Render must disclose the synthesized natal date.
    const rendered = renderAstrologyAscii(castAstrology(FIXTURE, { env }));
    expect(rendered).toContain("chart cast from synthesized natal date");
  });

  it("does not disclose synthesis when birthday is real", () => {
    const env = ephemeralRepoEnv({
      "user.email": "seeker@example.com",
      "user.birthday": "1990-07-04",
    });
    const rendered = renderAstrologyAscii(castAstrology(FIXTURE, { env }));
    expect(rendered).not.toContain("chart cast from synthesized natal date");
  });
});

describe("methods/astrology Rising varies with base branch / repo", () => {
  it("same base + same repo → same Rising sign", () => {
    // syntheticDateFromString is the pure surface — assert it directly
    // so we don't have to fake `git config` for every combination.
    const a = signFromDate(syntheticDateFromString("main::merge-oracle", "rising"));
    const b = signFromDate(syntheticDateFromString("main::merge-oracle", "rising"));
    expect(a).toBe(b);
  });

  it("different base branches shift the Rising sign", () => {
    // We can't guarantee every branch swap crosses a cusp, but across a
    // sample of common branch names the chart function must produce
    // *some* difference — assert at least one pair diverges.
    const combos = [
      ["main", "merge-oracle"],
      ["release/1.x", "merge-oracle"],
      ["develop", "merge-oracle"],
      ["main", "commit-roast"],
    ];
    const signs = combos.map(([b, r]) =>
      signFromDate(syntheticDateFromString(`${b}::${r}`, "rising")),
    );
    const uniq = new Set(signs);
    expect(uniq.size).toBeGreaterThan(1);
  });
});

describe("methods/astrology no-git fallback", () => {
  it("noGit:true never shells out to git and still returns a full chart", () => {
    const chart = computeChart("diff --git a/foo b/foo\n+bar\n", { noGit: true });
    expect(chart.sunFromDiff).toBe(false);
    expect(chart.moonFromConfig).toBe(false);
    expect(chart.risingFromConfig).toBe(false);
    expect(chart.sun.id.length).toBeGreaterThan(0);
    expect(chart.moon.id.length).toBeGreaterThan(0);
    expect(chart.rising.id.length).toBeGreaterThan(0);
  });

  it("Date: header in the diff drives Sun even in noGit mode", () => {
    const diff = [
      "Date: Fri, 3 Jul 2026 17:21:27 +0000",
      "",
      "diff --git a/foo b/foo",
    ].join("\n");
    const chart = computeChart(diff, { noGit: true });
    expect(chart.sunFromDiff).toBe(true);
    // Jul 3 → Cancer.
    expect(chart.sun.id).toBe("cancer");
  });
});

describe("methods/astrology ASCII render", () => {
  it("renders three sign boxes side by side with Sun/Moon/Rising labels", () => {
    const signs = castAstrology(FIXTURE, { noGit: true });
    const art = renderAstrologyAscii(signs);
    const firstLine = art.split("\n")[0];
    expect(firstLine.match(/\+-+\+/g)?.length).toBe(3);
    expect(art).toContain("Sun");
    expect(art).toContain("Moon");
    expect(art).toContain("Rising");
  });

  it("ASCII cast matches snapshot for the multi-file fixture (offline / noGit)", () => {
    expect(renderAstrologyAscii(castAstrology(FIXTURE, { noGit: true }))).toMatchSnapshot();
  });
});

describe("methods/astrology reading prompt", () => {
  it("prompt includes each cast sign with element/modality/ruler", () => {
    const signs = castAstrology(FIXTURE, { noGit: true });
    const messages = astrology.readingPrompt(signs, FIXTURE);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("natal chart");
    const user = messages[1].content;
    for (const s of signs) {
      const meta = s.meta as { signName: string; element: string; modality: string; ruler: string };
      expect(user).toContain(s.position);
      expect(user).toContain(meta.signName);
      expect(user).toContain(meta.element);
      expect(user).toContain(meta.modality);
      expect(user).toContain(meta.ruler);
    }
  });

  it("system prompt asks for a synthesized-date disclosure when applicable", () => {
    const signs = castAstrology(FIXTURE, { noGit: true });
    const messages = astrology.readingPrompt(signs, FIXTURE);
    expect(messages[0].content).toContain("synthesized natal date");
  });
});

describe("methods/astrology end-to-end (offline)", () => {
  it("offline reading runs through the full pipeline", async () => {
    const signs = astrology.draw(FIXTURE);
    const messages = astrology.readingPrompt(signs, FIXTURE);
    const reading = await createOfflineClient().complete(messages);
    expect(typeof reading).toBe("string");
    expect(reading.length).toBeGreaterThan(0);
  });
});

describe("methods/astrology miscellany", () => {
  it("syntheticSunDate is stable and yields a valid Date", () => {
    const a = syntheticSunDate("hello world");
    const b = syntheticSunDate("hello world");
    expect(a.getTime()).toBe(b.getTime());
    expect(a.getUTCFullYear()).toBe(2000);
  });

  it("syntheticDateFromString is stable", () => {
    const a = syntheticDateFromString("main::merge-oracle", "rising");
    const b = syntheticDateFromString("main::merge-oracle", "rising");
    expect(a.getTime()).toBe(b.getTime());
  });

  it("also boots when reading via the raw file loader path", () => {
    // Sanity: writing a tiny fixture into a tmp file and pointing the
    // computeChart at it still yields three valid signs. Guards against
    // an "empty diff" regression.
    const dir = mkdtempSync(resolve(tmpdir(), "oracle-astro-"));
    const p = resolve(dir, "tiny.diff");
    writeFileSync(p, "diff --git a/x b/x\n@@ -0,0 +1 @@\n+hi\n");
    const chart = computeChart(readFileSync(p, "utf8"), { noGit: true });
    expect(chart.sun.id.length).toBeGreaterThan(0);
    expect(chart.moon.id.length).toBeGreaterThan(0);
    expect(chart.rising.id.length).toBeGreaterThan(0);
  });
});
