/**
 * Watch pipeline integration harness (test seat).
 * Pins fixture providers through getWatchSnapshot → renderWatchPane / CLI
 * watch end to end: fresh / stale / rate_limited / missing-data, red-line
 * thresholds, and the untaxed agent path (default refresh=false never fetches).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCachedProviders } from "../src/cache.js";
import { main } from "../src/cli.js";
import { normalizeAgyQuotaSummary } from "../src/providers/agy.js";
import { PROVIDERS } from "../src/providers/index.js";
import {
  buildWatchSnapshot,
  getWatchSnapshot,
  levelForRemaining,
  type WatchSnapshot,
} from "../src/snapshot.js";
import type {
  ProviderId,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
} from "../src/types.js";
import { renderWatchPane } from "../src/watch-render.js";

const originalClaudeProvider = PROVIDERS.claude;
const originalCodexProvider = PROVIDERS.codex;
const originalCursorProvider = PROVIDERS.cursor;
const originalCopilotProvider = PROVIDERS.copilot;
const originalGrokProvider = PROVIDERS.grok;
const originalAgyProvider = PROVIDERS.agy;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  PROVIDERS.claude = originalClaudeProvider;
  PROVIDERS.codex = originalCodexProvider;
  PROVIDERS.cursor = originalCursorProvider;
  PROVIDERS.copilot = originalCopilotProvider;
  PROVIDERS.grok = originalGrokProvider;
  PROVIDERS.agy = originalAgyProvider;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
});

const NOW = new Date("2026-07-09T12:00:00.000Z");

describe("watch pipeline: fixture providers e2e", () => {
  it("builds a multi-provider snapshot for fresh, stale, throttled, and missing-data cases", async () => {
    const agyWindows =
      normalizeAgyQuotaSummary(fixture("agy/quota-summary.json"))?.windows ??
      [];
    expect(agyWindows.length).toBeGreaterThan(0);

    const fixtures: ProviderQuota[] = [
      quota("agy", {
        windows: agyWindows.map((window) => ({
          ...window,
          // Keep resets in the future so countdown/burn can compute.
          resetsAt: "2026-07-09T17:00:00.000Z",
          windowSeconds: window.windowSeconds ?? 18000,
        })),
        status: "fresh",
        source: "cli-rpc",
        refreshedAt: "2026-07-09T11:55:00.000Z",
        plan: "Google AI Pro",
      }),
      quota("claude", {
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            kind: "session",
            percentUsed: 40,
            percentRemaining: 60,
            resetsAt: "2026-07-09T15:00:00.000Z",
            windowSeconds: 18000,
          },
        ],
        status: "stale",
        source: "cache",
        stale: true,
        refreshedAt: "2026-07-09T08:00:00.000Z",
      }),
      quota("codex", {
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            kind: "session",
            percentUsed: 70,
            percentRemaining: 30,
            resetsAt: "2026-07-09T14:00:00.000Z",
            windowSeconds: 18000,
          },
        ],
        status: "rate_limited",
        source: "api",
        error: "retry_after",
        retryAfter: "2026-07-09T12:05:00.000Z",
      }),
      quota("grok", {
        windows: [],
        status: "auth_required",
        source: "unavailable",
        error: "credentials_missing",
      }),
    ];

    const snapshot = buildWatchSnapshot(fixtures, {
      mode: "refresh",
      now: NOW,
      generatedAt: NOW.toISOString(),
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.mode).toBe("refresh");
    expect(snapshot.providers).toHaveLength(4);

    const byId = Object.fromEntries(
      snapshot.providers.map((provider) => [provider.provider, provider]),
    );

    // fresh live source
    expect(byId.agy).toMatchObject({
      trust: "fresh",
      status: "fresh",
      source: "cli-rpc",
      plan: "Google AI Pro",
    });
    expect(byId.agy.windows.length).toBeGreaterThan(0);
    expect(byId.agy.primary?.kind).toBe("session");
    expect(byId.agy.windows.every((window) => window.level)).toBeTruthy();

    // stale cached
    expect(byId.claude).toMatchObject({
      trust: "stale",
      status: "stale",
      source: "cache",
    });
    expect(byId.claude.windows[0]?.resetInSeconds).toBe(3 * 3600);

    // throttled / rate_limited
    expect(byId.codex).toMatchObject({
      trust: "unavailable",
      status: "rate_limited",
      error: "retry_after",
    });
    expect(byId.codex.windows[0]?.percentRemaining).toBe(30);

    // missing data / auth required
    expect(byId.grok).toMatchObject({
      trust: "unavailable",
      status: "auth_required",
      windows: [],
      error: "credentials_missing",
    });
    expect(byId.grok.primary).toBeUndefined();
  });

  it("refresh path fetches fixture providers once and writes cache", async () => {
    useTempCache();
    const live = quota("cursor", {
      windows: [
        {
          id: "included_usage",
          label: "included",
          kind: "monthly",
          percentUsed: 12,
          percentRemaining: 88,
          resetsAt: "2026-08-01T00:00:00.000Z",
          windowSeconds: 30 * 86400,
        },
      ],
      status: "fresh",
      source: "web",
      refreshedAt: NOW.toISOString(),
    });
    const fetchProvider = vi.fn(
      async (_provider: ProviderId, _options: ProviderOptions) => live,
    );
    const writeCache = vi.fn();

    const snapshot = await getWatchSnapshot(
      { providers: ["cursor"], refresh: true, now: NOW },
      {
        fetchProvider,
        writeCache,
        nowIso: () => NOW.toISOString(),
      },
    );

    expect(fetchProvider).toHaveBeenCalledOnce();
    expect(writeCache).toHaveBeenCalledWith([live]);
    expect(snapshot).toMatchObject({
      mode: "refresh",
      generatedAt: NOW.toISOString(),
      providers: [{ provider: "cursor", trust: "fresh", status: "fresh" }],
    });
  });
});

describe("watch pipeline: red-line thresholds", () => {
  it.each([
    { remaining: 50, level: "ok" as const },
    { remaining: 26, level: "ok" as const },
    { remaining: 25, level: "warn" as const },
    { remaining: 11, level: "warn" as const },
    { remaining: 10, level: "critical" as const },
    { remaining: 0, level: "critical" as const },
    { remaining: undefined, level: "ok" as const },
  ])("remaining $remaining maps to $level", ({ remaining, level }) => {
    expect(levelForRemaining(remaining)).toBe(level);
  });

  it("propagates red-line levels through buildWatchSnapshot for ok/warn/critical", () => {
    const snapshot = buildWatchSnapshot(
      [
        quota("claude", {
          windows: [
            sessionWindow("ok", 50),
            sessionWindow("warn", 20),
            sessionWindow("critical", 5),
          ],
          status: "fresh",
          source: "oauth",
        }),
      ],
      { mode: "refresh", now: NOW },
    );

    const levels = snapshot.providers[0].windows.map((window) => ({
      id: window.id,
      level: window.level,
    }));
    expect(levels).toEqual([
      { id: "ok", level: "ok" },
      { id: "warn", level: "warn" },
      { id: "critical", level: "critical" },
    ]);
    // Primary is most urgent session window.
    expect(snapshot.providers[0].primary?.id).toBe("critical");
    expect(snapshot.providers[0].primary?.level).toBe("critical");
  });
});

describe("watch pipeline: agent read path untaxed", () => {
  it("default getWatchSnapshot uses cache only and never fetches providers", async () => {
    useTempCache();
    writeCachedProviders([
      quota("claude", {
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            kind: "session",
            percentUsed: 15,
            percentRemaining: 85,
            resetsAt: "2026-07-09T16:00:00.000Z",
            windowSeconds: 18000,
          },
        ],
        status: "fresh",
        source: "oauth",
        refreshedAt: "2026-07-09T11:00:00.000Z",
      }),
    ]);

    const fetchProvider = vi.fn(async () => {
      throw new Error("live provider must not be called on agent path");
    });

    const snapshot = await getWatchSnapshot(
      { providers: ["claude", "agy"], now: NOW },
      { fetchProvider },
    );

    expect(fetchProvider).not.toHaveBeenCalled();
    expect(snapshot.mode).toBe("cache");
    expect(snapshot.providers).toHaveLength(2);
    expect(snapshot.providers[0]).toMatchObject({
      provider: "claude",
      trust: "cached",
      status: "fresh",
    });
    expect(snapshot.providers[1]).toMatchObject({
      provider: "agy",
      trust: "unavailable",
      error: "cache_miss",
      windows: [],
    });
  });

  it("render-ready snapshot from cache path carries levels without live I/O", async () => {
    useTempCache();
    writeCachedProviders([
      quota("codex", {
        windows: [sessionWindow("hot", 8), sessionWindow("warm", 22)],
        status: "fresh",
        source: "oauth",
        refreshedAt: "2026-07-09T10:00:00.000Z",
      }),
    ]);

    const fetchProvider = vi.fn();
    const snapshot = await getWatchSnapshot(
      { providers: ["codex"], refresh: false, now: NOW },
      { fetchProvider },
    );

    expect(fetchProvider).not.toHaveBeenCalled();
    assertRenderReady(snapshot);
    expect(snapshot.providers[0].windows.map((w) => w.level)).toEqual([
      "critical",
      "warn",
    ]);
  });
});

describe("watch pipeline: snapshot → render e2e", () => {
  it("renders red-line markers for multi-provider fixture matrix", () => {
    const snapshot = buildWatchSnapshot(
      [
        quota("agy", {
          windows: [
            {
              ...sessionWindow("gemini_5h", 5),
              label: "Gemini 5-hour",
            },
          ],
          status: "fresh",
          source: "cli-rpc",
          plan: "Google AI Pro",
        }),
        quota("claude", {
          windows: [
            {
              ...sessionWindow("five_hour", 20),
              label: "5-hour",
            },
          ],
          status: "stale",
          source: "cache",
          stale: true,
          refreshedAt: "2026-07-09T08:00:00.000Z",
        }),
        quota("codex", {
          windows: [
            {
              ...sessionWindow("five_hour", 55),
              label: "5-hour",
            },
          ],
          status: "rate_limited",
          source: "api",
          error: "retry_after",
        }),
        quota("grok", {
          windows: [],
          status: "auth_required",
          source: "unavailable",
          error: "credentials_missing",
        }),
      ],
      { mode: "cache", now: NOW, generatedAt: NOW.toISOString() },
    );

    const pane = renderWatchPane(snapshot, { color: false });

    expect(pane).toContain("quota-axi watch");
    expect(pane).toContain("mode=cache");
    expect(pane).toContain("Antigravity");
    expect(pane).toContain("CRIT");
    expect(pane).toContain("WARN");
    expect(pane).toContain("RED LINE");
    expect(pane).toContain("agy/gemini_5h remaining 5%");
    expect(pane).toContain("claude/five_hour remaining 20%");
    expect(pane).toContain("unavailable");
    expect(pane).toContain("credentials_missing");
    expect(pane).toContain("retry_after");
    expect(pane).not.toMatch(/\$\d/);
    expect(pane).not.toContain("USD");
  });

  it("cache getWatchSnapshot output paints without live provider calls", async () => {
    useTempCache();
    writeCachedProviders([
      quota("agy", {
        windows: [
          {
            id: "gemini_5h",
            label: "Gemini 5-hour",
            kind: "session",
            percentUsed: 95,
            percentRemaining: 5,
            resetsAt: "2026-07-09T17:00:00.000Z",
            windowSeconds: 18000,
          },
        ],
        status: "fresh",
        source: "cli-rpc",
        refreshedAt: "2026-07-09T11:00:00.000Z",
      }),
    ]);

    const fetchProvider = vi.fn(async () => {
      throw new Error("live provider must not be called on render path");
    });
    const snapshot = await getWatchSnapshot(
      { providers: ["agy"], refresh: false, now: NOW },
      { fetchProvider },
    );
    const pane = renderWatchPane(snapshot, { color: false });

    expect(fetchProvider).not.toHaveBeenCalled();
    expect(snapshot.mode).toBe("cache");
    expect(pane).toContain("CRIT");
    expect(pane).toContain("RED LINE");
    expect(pane).toContain("rem   5%");
  });
});

describe("watch pipeline: CLI default path untaxed", () => {
  it("quota-axi watch uses cache snapshot and never calls PROVIDERS", async () => {
    useTempCache();
    writeCachedProviders([
      quota("codex", {
        windows: [
          {
            id: "five_hour",
            label: "session",
            kind: "session",
            percentUsed: 80,
            percentRemaining: 20,
            resetsAt: "2026-07-09T17:00:00.000Z",
            windowSeconds: 18000,
          },
        ],
        status: "fresh",
        source: "oauth",
        refreshedAt: "2026-07-09T11:00:00.000Z",
      }),
    ]);

    let providerFetches = 0;
    const boom = async () => {
      providerFetches += 1;
      throw new Error("live provider must not be called on default watch");
    };
    for (const id of [
      "claude",
      "codex",
      "cursor",
      "copilot",
      "grok",
      "agy",
    ] as const) {
      PROVIDERS[id] = {
        id,
        label: id,
        fetchQuota: boom,
        inspectAuth: async () => ({ provider: id, sources: [] }),
      };
    }

    const chunks: string[] = [];
    await main({
      argv: ["watch", "--provider", "codex", "--once"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
        isTTY: false,
      },
      // Intentionally no watchDeps.getSnapshot: exercise real cache path.
    });

    const output = chunks.join("");
    expect(providerFetches).toBe(0);
    expect(output).toContain("quota-axi watch");
    expect(output).toContain("mode=cache");
    expect(output).toContain("WARN");
    expect(output).toContain("RED LINE");
    expect(output).toContain("rem  20%");
    expect(output).not.toMatch(/\$\d/);
  });
});

function assertRenderReady(snapshot: WatchSnapshot): void {
  expect(snapshot.schemaVersion).toBe(1);
  expect(["cache", "refresh"]).toContain(snapshot.mode);
  expect(typeof snapshot.generatedAt).toBe("string");
  for (const provider of snapshot.providers) {
    expect(provider.provider).toBeTruthy();
    expect(provider.trust).toMatch(/^(fresh|cached|stale|unavailable)$/);
    for (const window of provider.windows) {
      expect(window.level).toMatch(/^(ok|warn|critical)$/);
      expect(
        window.burnRate.available === true ||
          window.burnRate.available === false,
      ).toBe(true);
      expect(
        window.resetInSeconds === null ||
          typeof window.resetInSeconds === "number",
      ).toBe(true);
    }
  }
}

function sessionWindow(id: string, percentRemaining: number): QuotaWindow {
  return {
    id,
    label: id,
    kind: "session",
    percentRemaining,
    percentUsed: 100 - percentRemaining,
    resetsAt: "2026-07-09T17:00:00.000Z",
    windowSeconds: 18000,
  };
}

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-watch-pipeline-"));
  process.env.XDG_CACHE_HOME = tempDir;
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"),
  ) as unknown;
}

function quota(
  provider: ProviderId,
  args: {
    windows: QuotaWindow[];
    status: ProviderQuota["state"]["status"];
    source: ProviderQuota["source"];
    plan?: string;
    stale?: boolean;
    refreshedAt?: string;
    error?: string;
    retryAfter?: string;
  },
): ProviderQuota {
  return {
    provider,
    label: providerLabel(provider),
    source: args.source,
    plan: args.plan,
    windows: args.windows,
    state: {
      status: args.status,
      stale: args.stale ?? false,
      refreshedAt: args.refreshedAt,
      error: args.error,
      retryAfter: args.retryAfter,
      sourcesTried: [args.source],
    },
  };
}

function providerLabel(provider: ProviderId): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "copilot":
      return "GitHub Copilot";
    case "agy":
      return "Antigravity";
    case "grok":
      return "Grok";
  }
}
