import { describe, expect, it } from "vitest";
import { evaluateQuotaThreshold } from "../src/threshold.js";
import type { ProviderId, ProviderQuota, QuotaWindow } from "../src/types.js";

describe("evaluateQuotaThreshold", () => {
  it("passes when every requested provider is measurable and at the floor", () => {
    const result = evaluateQuotaThreshold(
      [
        quota("claude", [window("session", 20)]),
        quota("codex", [window("week", 80)]),
      ],
      20,
    );

    expect(result).toEqual({
      minimumRemainingPercent: 20,
      status: "pass",
      measuredWindows: 2,
      unknownProviders: [],
      breaches: [],
    });
  });

  it("lists every measured window below the floor", () => {
    const result = evaluateQuotaThreshold(
      [
        quota("claude", [window("session", 19), window("week", 8)]),
        quota("codex", [window("session", 60)]),
      ],
      20,
    );

    expect(result.status).toBe("fail");
    expect(result.measuredWindows).toBe(3);
    expect(result.breaches).toEqual([
      {
        provider: "claude",
        id: "session",
        label: "session",
        percentRemaining: 19,
      },
      {
        provider: "claude",
        id: "week",
        label: "week",
        percentRemaining: 8,
      },
    ]);
  });

  it("reports unknown instead of silently passing unmeasurable providers", () => {
    const result = evaluateQuotaThreshold(
      [
        quota("copilot", []),
        quota("grok", [{ id: "credits", label: "credits", kind: "credits" }]),
        quota("codex", [window("session", 70)]),
      ],
      20,
    );

    expect(result.status).toBe("unknown");
    expect(result.measuredWindows).toBe(1);
    expect(result.unknownProviders).toEqual(["copilot", "grok"]);
  });

  it("keeps a known breach authoritative when another provider is unknown", () => {
    const result = evaluateQuotaThreshold(
      [quota("copilot", []), quota("codex", [window("session", 5)])],
      20,
    );

    expect(result.status).toBe("fail");
    expect(result.unknownProviders).toEqual(["copilot"]);
  });
});

function quota(provider: ProviderId, windows: QuotaWindow[]): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "api",
    windows,
    state: {
      status: "fresh",
      stale: false,
      sourcesTried: ["api"],
    },
  };
}

function window(id: string, percentRemaining: number): QuotaWindow {
  return {
    id,
    label: id,
    kind: id === "week" ? "weekly" : "session",
    percentRemaining,
  };
}
