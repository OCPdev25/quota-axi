import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWatchSnapshot, levelForRemaining } from "../src/snapshot.js";
import { isRedLine, renderWatchPane } from "../src/watch-render.js";
import type { WatchSnapshot } from "../src/snapshot.js";
import type { ProviderQuota } from "../src/types.js";
import { runWatchLoop } from "../src/watch.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): WatchSnapshot {
  const raw = readFileSync(join(here, "fixtures", "watch", name), "utf-8");
  return JSON.parse(raw) as WatchSnapshot;
}

describe("renderWatchPane", () => {
  it("renders schema sample with remaining, reset, burn, and trust", () => {
    const snapshot = loadFixture("sample.json");
    const pane = renderWatchPane(snapshot, { color: false });

    expect(pane).toContain("quota-axi watch");
    expect(pane).toContain("mode=cache");
    expect(pane).toContain("Antigravity");
    expect(pane).toContain("cached");
    expect(pane).toContain("Gemini 5-hour");
    expect(pane).toContain("rem  91%");
    expect(pane).toContain("1.80%/h");
    expect(pane).toContain("n/a");
    expect(pane).toContain("Claude");
    expect(pane).toContain("unavailable");
    expect(pane).toContain("credentials_missing");
    expect(pane).not.toMatch(/\$\d/);
    expect(pane).not.toContain("USD");
    expect(pane).not.toContain("RED LINE");
  });

  it("surfaces red-line WARN when a window is hot", () => {
    const snapshot = loadFixture("warn.json");
    const pane = renderWatchPane(snapshot, { color: false });

    expect(pane).toContain("WARN");
    expect(pane).toContain("RED LINE");
    expect(pane).toContain("agy/gemini_5h remaining 20%");
    expect(pane).not.toMatch(/\$\d/);
  });

  it("surfaces red-line CRIT when a window is critical", () => {
    const snapshot = loadFixture("critical.json");
    const pane = renderWatchPane(snapshot, { color: false });

    expect(pane).toContain("CRIT");
    expect(pane).toContain("RED LINE");
    expect(pane).toContain("agy/gemini_5h remaining 5%");
  });

  it("never prints USD markers outside --full", () => {
    const snapshot = loadFixture("sample.json");
    const polluted: WatchSnapshot = {
      ...snapshot,
      providers: snapshot.providers.map((provider) => ({
        ...provider,
        plan: provider.plan ? `${provider.plan} $99 USD` : "$12",
      })),
    };
    const pane = renderWatchPane(polluted, { color: false, full: false });
    expect(pane).not.toMatch(/\$\d/);
  });

  it("marks primary window with *", () => {
    const snapshot = loadFixture("sample.json");
    const pane = renderWatchPane(snapshot, { color: false });
    expect(pane).toMatch(/\* ok .*Gemini 5-hour/);
  });
});

describe("red-line thresholds (data contract)", () => {
  it("maps remaining to ok/warn/critical", () => {
    expect(levelForRemaining(50)).toBe("ok");
    expect(levelForRemaining(25)).toBe("warn");
    expect(levelForRemaining(20)).toBe("warn");
    expect(levelForRemaining(10)).toBe("critical");
    expect(levelForRemaining(5)).toBe("critical");
    expect(levelForRemaining(undefined)).toBe("ok");
  });

  it("isRedLine only for warn and critical", () => {
    expect(isRedLine("ok")).toBe(false);
    expect(isRedLine("warn")).toBe(true);
    expect(isRedLine("critical")).toBe(true);
  });
});

describe("runWatchLoop", () => {
  it("paints once with injectable snapshot and never calls providers", async () => {
    const snapshot = loadFixture("sample.json");
    let fetches = 0;
    const chunks: string[] = [];

    await runWatchLoop(
      {
        intervalMs: 1,
        snapshot: { refresh: false },
        render: { color: false },
        once: true,
      },
      {
        getSnapshot: async () => {
          fetches += 1;
          return snapshot;
        },
        write: (chunk) => {
          chunks.push(chunk);
        },
        isTty: false,
      },
    );

    expect(fetches).toBe(1);
    expect(chunks.join("")).toContain("Antigravity");
    expect(chunks.join("")).toContain("mode=cache");
  });

  it("stops when shouldContinue becomes false", async () => {
    const snapshot = loadFixture("warn.json");
    let fetches = 0;
    let ticks = 0;

    await runWatchLoop(
      {
        intervalMs: 1,
        snapshot: { refresh: false },
        render: { color: false },
      },
      {
        getSnapshot: async () => {
          fetches += 1;
          return snapshot;
        },
        write: () => undefined,
        sleep: async () => {
          ticks += 1;
        },
        shouldContinue: () => ticks < 2,
        isTty: false,
      },
    );

    expect(fetches).toBeGreaterThanOrEqual(2);
    expect(fetches).toBeLessThanOrEqual(3);
  });
});

describe("buildWatchSnapshot levels feed renderer", () => {
  it("critical remaining paints CRIT via snapshot build", () => {
    const providers: ProviderQuota[] = [
      {
        provider: "codex",
        label: "Codex",
        source: "cache",
        windows: [
          {
            id: "five_hour",
            label: "session",
            kind: "session",
            percentRemaining: 5,
            percentUsed: 95,
            resetsAt: "2026-07-09T20:00:00.000Z",
            windowSeconds: 5 * 3600,
          },
        ],
        state: {
          status: "stale",
          stale: true,
          refreshedAt: "2026-07-09T10:00:00.000Z",
          sourcesTried: ["cache"],
        },
      },
    ];
    const snapshot = buildWatchSnapshot(providers, {
      now: new Date("2026-07-09T11:20:00.000Z"),
      mode: "cache",
    });
    const pane = renderWatchPane(snapshot, { color: false });
    expect(snapshot.providers[0].windows[0].level).toBe("critical");
    expect(pane).toContain("CRIT");
    expect(pane).toContain("RED LINE");
  });
});
