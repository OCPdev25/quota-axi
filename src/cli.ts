import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { annotateQuotaAdvice } from "./advice.js";
import { writeCachedProviders } from "./cache.js";
import { nowIso } from "./lib/time.js";
import { PROVIDERS, parseProviders } from "./providers/index.js";
import {
  redactedResponse,
  renderAuthToon,
  renderError,
  renderQuotaToon,
} from "./render.js";
import { getWatchSnapshot } from "./snapshot.js";
import type {
  AuthProviderReport,
  ProviderId,
  ProviderOptions,
  ProviderQuota,
  QuotaAxiResponse,
} from "./types.js";
import {
  defaultWatchIntervalSeconds,
  runWatchLoop,
  type WatchLoopDeps,
} from "./watch.js";

export const DESCRIPTION =
  "Report local agent-provider quota windows for routing-aware agents.";

export const TOP_HELP = `usage: quota-axi [auth|watch] [flags]
commands[3]:
  (none)=quota, auth, watch
flags[9]:
  --provider <claude,codex,cursor,copilot,grok,agy>, --json, --full, --allow-keychain-prompt, --interval <seconds>, --refresh, --once, --help, -v/--version
examples:
  quota-axi
  quota-axi --provider claude
  quota-axi --provider agy
  quota-axi --provider cursor,copilot,grok,agy
  quota-axi --json
  quota-axi --full
  quota-axi auth
  quota-axi watch
  quota-axi watch --interval 15 --provider codex,grok
  quota-axi watch --refresh --once
`;

type MainOptions = {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  binPath?: string;
  watchDeps?: Partial<WatchLoopDeps>;
};

type ParsedArgs = {
  command: "quota" | "auth" | "watch" | "help" | "version";
  providers: ProviderId[];
  json: boolean;
  full: boolean;
  allowKeychainPrompt: boolean;
  intervalSeconds: number;
  refresh: boolean;
  once: boolean;
};

export async function main(options: MainOptions = {}): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const binPath = options.binPath ?? process.argv[1] ?? "quota-axi";
  try {
    const parsed = parseArgs(options.argv ?? process.argv.slice(2));
    if (parsed.command === "help") {
      stdout.write(TOP_HELP);
      return;
    }
    if (parsed.command === "version") {
      stdout.write(`quota-axi ${readPackageVersion()}\n`);
      return;
    }
    const providerOptions: ProviderOptions = {
      allowKeychainPrompt: parsed.allowKeychainPrompt,
    };
    if (parsed.command === "auth") {
      const reports = await inspectAuth(parsed.providers, providerOptions);
      if (parsed.json) {
        stdout.write(
          `${JSON.stringify({ generatedAt: nowIso(), schemaVersion: 1, auth: reports }, null, 2)}\n`,
        );
      } else {
        stdout.write(`${renderAuthToon(reports, binPath)}\n`);
      }
      return;
    }
    if (parsed.command === "watch") {
      await runWatchCommand(parsed, stdout, options.watchDeps);
      return;
    }

    const response = await fetchQuota(parsed.providers, providerOptions);
    const rendered = parsed.json
      ? JSON.stringify(redactedResponse(response, parsed.full), null, 2)
      : renderQuotaToon(
          redactedResponse(response, parsed.full),
          binPath,
          parsed.full,
        );
    stdout.write(`${rendered}\n`);

    if (response.providers.every((provider) => isFailed(provider))) {
      process.exitCode = 1;
    }
    writeCachedProvidersBestEffort(response.providers);
  } catch (error) {
    stdout.write(
      `${renderError(
        error instanceof Error ? error.message : "quota-axi failed",
        "usage",
        ["Run `quota-axi --help` for supported commands and flags"],
      )}\n`,
    );
    process.exitCode = 2;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  let command: ParsedArgs["command"] = "quota";
  let providerValue: string | undefined;
  let json = false;
  let full = false;
  let allowKeychainPrompt = false;
  let intervalSeconds = defaultWatchIntervalSeconds();
  let refresh = false;
  let once = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "auth") {
      command = "auth";
      continue;
    }
    if (arg === "watch") {
      command = "watch";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      command = "help";
      continue;
    }
    if (arg === "--version" || arg === "-v" || arg === "-V") {
      command = "version";
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--full") {
      full = true;
      continue;
    }
    if (arg === "--allow-keychain-prompt") {
      allowKeychainPrompt = true;
      continue;
    }
    if (arg === "--refresh") {
      refresh = true;
      continue;
    }
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--interval" || arg === "-i") {
      const value = argv[index + 1];
      if (!value) throw new Error("--interval requires seconds");
      intervalSeconds = parseIntervalSeconds(value);
      index++;
      continue;
    }
    if (arg.startsWith("--interval=")) {
      intervalSeconds = parseIntervalSeconds(arg.slice("--interval=".length));
      continue;
    }
    if (arg === "--provider") {
      const value = argv[index + 1];
      if (!value)
        throw new Error("--provider requires a comma-separated provider list");
      providerValue = value;
      index++;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      providerValue = arg.slice("--provider=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    command,
    providers: parseProviders(providerValue),
    json,
    full,
    allowKeychainPrompt,
    intervalSeconds,
    refresh,
    once,
  };
}

async function runWatchCommand(
  parsed: ParsedArgs,
  stdout: Pick<NodeJS.WriteStream, "write" | "isTTY">,
  watchDeps?: Partial<WatchLoopDeps>,
): Promise<void> {
  const isTty = Boolean(
    watchDeps?.isTty ??
    ("isTTY" in stdout ? stdout.isTTY : process.stdout.isTTY),
  );
  const getSnapshot =
    watchDeps?.getSnapshot ??
    ((options) =>
      getWatchSnapshot({
        ...options,
        providers: parsed.providers,
        refresh: parsed.refresh,
        allowKeychainPrompt: parsed.allowKeychainPrompt,
      }));

  if (parsed.json) {
    const snapshot = await getSnapshot({
      providers: parsed.providers,
      refresh: parsed.refresh,
      allowKeychainPrompt: parsed.allowKeychainPrompt,
    });
    stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  await runWatchLoop(
    {
      intervalMs: parsed.intervalSeconds * 1000,
      snapshot: {
        providers: parsed.providers,
        refresh: parsed.refresh,
        allowKeychainPrompt: parsed.allowKeychainPrompt,
      },
      render: {
        full: parsed.full,
        color: isTty,
      },
      once: parsed.once || !isTty,
    },
    {
      getSnapshot,
      write: (chunk) => {
        stdout.write(chunk);
      },
      clear:
        watchDeps?.clear ??
        (() => {
          if (isTty) stdout.write("\u001b[H\u001b[2J");
        }),
      sleep: watchDeps?.sleep,
      isTty,
      shouldContinue: watchDeps?.shouldContinue,
      onSignal:
        watchDeps?.onSignal ??
        ((handler) => {
          const onSig = () => handler();
          process.once("SIGINT", onSig);
          process.once("SIGTERM", onSig);
          return () => {
            process.off("SIGINT", onSig);
            process.off("SIGTERM", onSig);
          };
        }),
    },
  );
}

function parseIntervalSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--interval must be a positive number of seconds");
  }
  return seconds;
}

async function fetchQuota(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<QuotaAxiResponse> {
  const results = await Promise.all(
    providers.map((provider) => PROVIDERS[provider].fetchQuota(options)),
  );
  return annotateQuotaAdvice({
    generatedAt: nowIso(),
    providers: results,
  });
}

async function inspectAuth(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<AuthProviderReport[]> {
  return Promise.all(
    providers.map((provider) => PROVIDERS[provider].inspectAuth(options)),
  );
}

function isFailed(provider: ProviderQuota): boolean {
  return !["fresh", "stale"].includes(provider.state.status);
}

function writeCachedProvidersBestEffort(providers: ProviderQuota[]): void {
  try {
    writeCachedProviders(providers);
  } catch {
    return;
  }
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0)
      return parsed.version;
  }
  return "0.0.0";
}
