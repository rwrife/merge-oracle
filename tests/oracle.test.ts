import { describe, it, expect } from "vitest";
import { hello, VERSION } from "../src/oracle.js";

describe("oracle", () => {
  it("greets a named seeker", () => {
    expect(hello("ryan")).toContain("ryan");
    expect(hello("ryan")).toContain("🔮");
  });

  it("falls back to 'seeker' when no name is provided", () => {
    expect(hello("   ")).toContain("seeker");
  });

  it("exposes a version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
