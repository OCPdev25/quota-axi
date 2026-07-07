import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeClaudeApiUsage } from "../../src/providers/claude.js";

const fixtureDir = join(import.meta.dirname, "..", "fixtures", "claude");

describe("Claude quota parsing", () => {
  it("normalizes OAuth usage windows and extra usage", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth.json"), "utf8"),
    ) as unknown;
    const result = normalizeClaudeApiUsage(raw, "Pro");

    expect(result?.plan).toBe("Pro");
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        kind: "session",
        percentUsed: 18,
        percentRemaining: 82,
        resetsAt: "2026-07-06T22:15:00Z",
      },
      {
        id: "seven_day",
        kind: "weekly",
        percentUsed: 36,
        percentRemaining: 64,
        resetsAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "seven_day_opus",
        kind: "model",
        percentUsed: 7,
        percentRemaining: 93,
      },
      {
        id: "extra_usage",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
        spentUsd: 5,
        limitUsd: 20,
      },
    ]);
  });
});
