import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeAccountAndLimits,
  normalizeCodexUsage,
} from "../../src/providers/codex.js";

const fixtureDir = join(import.meta.dirname, "..", "fixtures", "codex");

describe("Codex quota parsing", () => {
  it("normalizes snake-case OAuth usage responses", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth-snake.json"), "utf8"),
    ) as unknown;
    const result = normalizeCodexUsage(raw);

    expect(result?.plan).toBe("plus");
    expect(result?.account).toMatchObject({
      email: "person@example.invalid",
      accountId: "acct_fixture",
    });
    expect(result?.credits).toEqual({
      remaining: 12,
      unlimited: false,
      unit: "credits",
    });
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        label: "session",
        percentUsed: 29,
        percentRemaining: 71,
        windowSeconds: 18000,
      },
      { id: "weekly", label: "week", percentUsed: 57, percentRemaining: 43 },
    ]);
  });

  it("normalizes camel-case OAuth usage responses", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth-camel.json"), "utf8"),
    ) as unknown;
    const result = normalizeCodexUsage(raw);

    expect(result?.plan).toBe("team");
    expect(result?.account).toMatchObject({
      email: "person@example.invalid",
      accountId: "acct_fixture",
    });
    expect(result?.credits).toEqual({
      remaining: 5,
      unlimited: true,
      unit: "credits",
    });
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        label: "session",
        percentUsed: 10,
        percentRemaining: 90,
        resetsAt: "2026-07-06T21:45:00.000Z",
        windowSeconds: 18000,
      },
      { id: "weekly", label: "week", percentUsed: 90, percentRemaining: 10 },
    ]);
  });

  it("merges app-server account and rate limit RPC responses", () => {
    const merged = mergeAccountAndLimits(
      { account: { email: "person@example.invalid", planType: "pro" } },
      { rate_limit: { primary_window: { used_percent: 20 } } },
    );
    const result = normalizeCodexUsage(merged);

    expect(result?.plan).toBe("pro");
    expect(result?.account?.email).toBe("person@example.invalid");
    expect(result?.windows[0]).toMatchObject({
      id: "five_hour",
      percentRemaining: 80,
    });
  });
});
