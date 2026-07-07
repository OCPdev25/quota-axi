import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFile } from "../lib/fs.js";
import { commandExists, execFileText, spawnTextSession } from "../lib/process.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, staleFromCache, statusFromError, successProvider, withRemaining } from "./common.js";

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const API_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 15_000;
const CREDENTIAL_FILE = join(homedir(), ".claude", ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials";

type ClaudeCredentials = {
  source: "oauth-file" | "keychain";
  accessToken: string;
  plan?: string;
  expiresAt?: number;
};

type AvailableCredentialState = { status: "available"; credentials: ClaudeCredentials };
type UnavailableCredentialState = { status: "missing" | "invalid" | "expired"; source: AuthSourceReport };
type SkippedCredentialState = { status: "skipped"; source: AuthSourceReport };
type CredentialState = AvailableCredentialState | UnavailableCredentialState | SkippedCredentialState;

function isSkippedCredentialState(state: CredentialState): state is SkippedCredentialState {
  return state.status === "skipped";
}

type RawUsageWindow = {
  utilization?: unknown;
  resets_at?: unknown;
  reset_at?: unknown;
};

type ExtraUsageWindow = RawUsageWindow & {
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
};

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  label: "Claude",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(options: ProviderOptions): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError = "Claude quota unavailable";
  let retryAfter: string | undefined;

  const credentialStates = await readCredentialStates(options);
  const credentials = credentialStates
    .filter((state): state is AvailableCredentialState => state.status === "available")
    .map((state) => state.credentials)
    .sort((a, b) => {
      if (process.platform === "darwin") {
        if (a.source === "keychain" && b.source !== "keychain") return -1;
        if (b.source === "keychain" && a.source !== "keychain") return 1;
      }
      return (b.expiresAt ?? 0) - (a.expiresAt ?? 0);
    });

  for (const skipped of credentialStates.filter(isSkippedCredentialState)) {
    attempts.push({ source: skipped.source.source, status: "skipped", error: skipped.source.error });
    finalError = skipped.source.error ?? finalError;
  }

  if (credentials.length > 0) {
    for (const credential of credentials) {
      attempts.push({ source: "oauth", status: "failed" });
      try {
        const quota = await fetchOauthUsage(credential);
        attempts[attempts.length - 1] = { source: "oauth", status: "success" };
        return successProvider({
          provider: "claude",
          label: "Claude",
          source: "oauth",
          plan: quota.plan,
          account: quota.account,
          windows: quota.windows,
          refreshedAt: quota.refreshedAt,
          sourcesTried: sourceNames(attempts),
          attempts,
        });
      } catch (error) {
        const message = errorMessage(error);
        attempts[attempts.length - 1] = { source: "oauth", status: "failed", error: message };
        finalError = message;
        if (error instanceof RateLimitError) retryAfter = error.retryAfter;
        if (message === "Claude sign-in required") {
          continue;
        }
      }
    }
  }

  attempts.push({ source: "cli-pty", status: "failed" });
  try {
    const quota = await probeClaudeCli();
    attempts[attempts.length - 1] = { source: "cli-pty", status: "success" };
    return successProvider({
      provider: "claude",
      label: "Claude",
      source: "cli-pty",
      plan: quota.plan,
      account: quota.account,
      windows: quota.windows,
      refreshedAt: quota.refreshedAt,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[attempts.length - 1] = { source: "cli-pty", status: "failed", error: message };
    finalError = finalError === "Claude quota unavailable" ? message : finalError;
  }

  const cached = readCachedProvider("claude");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "claude",
    label: "Claude",
    status: retryAfter ? "rate_limited" : statusFromError(finalError),
    error: finalError,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(options: ProviderOptions): Promise<AuthProviderReport> {
  const states = await readCredentialStates(options);
  const sources = states.map((state): AuthSourceReport => {
    if (state.status === "available") {
      return {
        source: state.credentials.source,
        path: state.credentials.source === "oauth-file" ? CREDENTIAL_FILE : undefined,
        status: "available",
      };
    }
    return state.source;
  });
  sources.push({
    source: "cli-pty",
    status: (await commandExists("claude")) ? "available" : "missing",
  });
  return { provider: "claude", sources };
}

export function normalizeClaudeApiUsage(raw: unknown, plan?: string): { plan?: string; windows: QuotaWindow[]; refreshedAt: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const windows = [
    normalizeWindow(data.five_hour, "five_hour", "session", "session"),
    normalizeWindow(data.seven_day, "seven_day", "week", "weekly"),
    normalizeWindow(data.seven_day_opus, "seven_day_opus", "opus week", "model"),
    normalizeExtraUsage(data.extra_usage),
  ].filter((window): window is QuotaWindow => Boolean(window));
  if (windows.length === 0) return undefined;
  return { plan, windows, refreshedAt: nowIso() };
}

export function parseClaudeCliUsage(output: string): { plan?: string; account?: ProviderQuota["account"]; windows: QuotaWindow[]; refreshedAt: string } | undefined {
  const text = stripAnsi(output);
  const sessionBlock = extractBlock(text, /Current\s+session/i);
  const weekBlock = extractBlock(text, /Current\s+week/i);
  const windows: QuotaWindow[] = [];
  const sessionPercent = parsePercentUsed(sessionBlock);
  const weekPercent = parsePercentUsed(weekBlock);

  if (sessionPercent !== undefined) {
    windows.push(
      withRemaining({
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: sessionPercent,
        resetText: parseResetText(sessionBlock),
      }),
    );
  }
  if (weekPercent !== undefined) {
    windows.push(
      withRemaining({
        id: "seven_day",
        label: "week",
        kind: "weekly",
        percentUsed: weekPercent,
        resetText: parseResetText(weekBlock),
      }),
    );
  }
  if (windows.length === 0) return undefined;

  return {
    account: { email: parseLine(text, /^\s*Account:\s*(.+)$/im) },
    plan: parseLine(text, /^\s*(?:Org|Organization):\s*(.+)$/im),
    windows,
    refreshedAt: nowIso(),
  };
}

async function readCredentialStates(options: ProviderOptions): Promise<CredentialState[]> {
  const states: CredentialState[] = [];

  const fileState = extractCredentialState(readJsonFile(CREDENTIAL_FILE), "oauth-file", CREDENTIAL_FILE);
  states.push(fileState);

  if (process.platform === "darwin") {
    if (!options.allowKeychainPrompt) {
      states.push({
        status: "skipped",
        source: {
          source: "keychain",
          status: "skipped",
          error: "keychain_prompt_required",
        },
      });
    } else {
      states.push(await readKeychainCredentialState());
    }
  }

  return states;
}

async function readKeychainCredentialState(): Promise<CredentialState> {
  try {
    const blob = await execFileText("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], API_TIMEOUT_MS);
    return extractCredentialState(JSON.parse(blob), "keychain");
  } catch {
    return {
      status: "missing",
      source: { source: "keychain", status: "missing" },
    };
  }
}

function extractCredentialState(raw: unknown, source: ClaudeCredentials["source"], path?: string): CredentialState {
  if (!existsSync(path ?? "")) {
    if (source === "oauth-file") {
      return { status: "missing", source: { source, path, status: "missing" } };
    }
  }
  if (!raw || typeof raw !== "object") return { status: "missing", source: { source, path, status: "missing" } };
  const data = raw as Record<string, unknown>;
  const oauth =
    data.claudeAiOauth && typeof data.claudeAiOauth === "object"
      ? (data.claudeAiOauth as Record<string, unknown>)
      : data;
  const accessToken = stringValue(oauth.accessToken) ?? stringValue(oauth.access_token);
  if (!accessToken) return { status: "invalid", source: { source, path, status: "invalid" } };
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined;
  if (expiresAt && expiresAt <= Date.now()) return { status: "expired", source: { source, path, status: "expired" } };
  const plan = stringValue(oauth.subscriptionType) ?? stringValue(data.subscriptionType);
  return { status: "available", credentials: { source, accessToken, plan, expiresAt } };
}

async function fetchOauthUsage(credentials: ClaudeCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  // 429 retry-after handling is translated from CodexBar's MIT-licensed
  // ClaudeOAuthUsageFetcher by Peter Steinberger. See licenses/CodexBar-MIT.txt.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw new Error("Claude sign-in required");
    if (response.status === 429) throw new RateLimitError(retryAfterToIso(response.headers.get("retry-after")));
    if (!response.ok) throw new Error(`Claude quota unavailable (${response.status})`);
    const quota = normalizeClaudeApiUsage(await response.json(), credentials.plan);
    if (!quota) throw new Error("Claude quota unavailable");
    return quota;
  } finally {
    clearTimeout(timer);
  }
}

async function probeClaudeCli(): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  if (!(await commandExists("claude"))) throw new Error("Claude quota unavailable");
  const output = await spawnTextSession(
    "claude",
    ["--allowed-tools", ""],
    (stdin) => {
      stdin.write("/usage\n");
      stdin.writeAfter(1_500, "\n");
    },
    CLI_TIMEOUT_MS,
    (buffer) => /Current\s+(session|week)|usage/i.test(stripAnsi(buffer)),
  );
  const quota = parseClaudeCliUsage(output);
  if (!quota) throw new Error("Claude quota unavailable");
  return quota;
}

function normalizeWindow(raw: unknown, id: string, label: string, kind: QuotaWindow["kind"]): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as RawUsageWindow;
  const used = typeof data.utilization === "number" ? data.utilization : undefined;
  if (used === undefined) return undefined;
  return withRemaining({
    id,
    label,
    kind,
    percentUsed: clampPercent(used),
    resetsAt: stringValue(data.resets_at) ?? stringValue(data.reset_at),
  });
}

function normalizeExtraUsage(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as ExtraUsageWindow;
  if (data.is_enabled !== true) return undefined;
  const spentUsd = typeof data.used_credits === "number" ? data.used_credits / 100 : undefined;
  const limitUsd = typeof data.monthly_limit === "number" ? data.monthly_limit / 100 : undefined;
  const percentUsed =
    typeof data.utilization === "number"
      ? clampPercent(data.utilization)
      : spentUsd !== undefined && limitUsd && limitUsd > 0
        ? clampPercent((spentUsd / limitUsd) * 100)
        : undefined;
  return withRemaining({
    id: "extra_usage",
    label: "extra usage",
    kind: "credits",
    percentUsed,
    spentUsd,
    limitUsd,
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function extractBlock(text: string, heading: RegExp): string {
  const match = heading.exec(text);
  if (!match || match.index === undefined) return "";
  const rest = text.slice(match.index);
  const next = /\n\s*(Current\s+(?:session|week)|Account|Org|Organization)\b/i.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest.slice(0, 800);
}

function parsePercentUsed(block: string): number | undefined {
  const percentMatches = [...block.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(left|remaining|remain|used)?/gi)];
  for (const match of percentMatches) {
    const value = Number(match[1]);
    const axis = match[2]?.toLowerCase();
    if (!Number.isFinite(value)) continue;
    if (axis === "left" || axis === "remaining" || axis === "remain") return clampPercent(100 - value);
    if (axis === "used" || axis === undefined) return clampPercent(value);
  }
  return undefined;
}

function parseResetText(block: string): string | undefined {
  return /(resets?\s+(?:in|at)[^\n]+)/i.exec(block)?.[1]?.trim();
}

function parseLine(text: string, label: RegExp): string | undefined {
  return label.exec(text)?.[1]?.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Claude quota request timed out";
  return error instanceof Error ? error.message : "Claude quota unavailable";
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Claude quota endpoint rate limited");
  }
}
