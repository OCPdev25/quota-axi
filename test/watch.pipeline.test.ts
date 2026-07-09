/**
 * Watch pipeline integration harness (test seat).
 * Pins fixture providers through getWatchSnapshot end to end:
 * fresh / stale / rate_limited / missing-data, red-line thresholds,
 * and the untaxed agent path (default refresh=false never fetches).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCachedProviders } from "../src/cache.js";
import { normalizeAgyQuotaSummary } from "../src/providers/agy.js";
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

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
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
