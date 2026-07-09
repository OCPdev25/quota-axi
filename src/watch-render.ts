import type {
  BurnRate,
  ProviderSnapshot,
  SnapshotLevel,
  SnapshotWindow,
  WatchSnapshot,
} from "./snapshot.js";

export type WatchRenderOptions = {
  /** When true, allow USD/credit figures if present on the snapshot. */
  full?: boolean;
  /** Emit ANSI color for warn/critical when true. */
  color?: boolean;
  /** Fixed clock for countdown formatting in tests. */
  now?: Date;
};

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  bold: "\u001b[1m",
} as const;

/**
 * Pure presentation layer for `quota-axi watch`.
 * Renders remaining %, reset countdown, burn rate, and trust/staleness.
 * No USD figures unless options.full is set (captain Q5: level + burn + reset, no USD).
 * Never performs I/O.
 */
export function renderWatchPane(
  snapshot: WatchSnapshot,
  options: WatchRenderOptions = {},
): string {
  const color = Boolean(options.color);
  const full = Boolean(options.full);
  const lines: string[] = [];

  lines.push(
    paint(
      color,
      "bold",
      `quota-axi watch  ${snapshot.generatedAt}  mode=${snapshot.mode}`,
    ),
  );
  lines.push(paint(color, "dim", "─".repeat(72)));

  if (snapshot.providers.length === 0) {
    lines.push("  (no providers)");
    return lines.join("\n");
  }

  for (const provider of snapshot.providers) {
    lines.push(...renderProvider(provider, { color }));
  }

  const hot = snapshot.providers.flatMap((provider) =>
    provider.windows
      .filter(
        (window) => window.level === "warn" || window.level === "critical",
      )
      .map((window) => ({ provider: provider.provider, window })),
  );
  if (hot.length > 0) {
    lines.push(paint(color, "dim", "─".repeat(72)));
    lines.push(paint(color, "bold", "RED LINE"));
    for (const item of hot) {
      const tag = levelTag(item.window.level, color);
      const remaining =
        item.window.percentRemaining === undefined
          ? "?"
          : `${item.window.percentRemaining}%`;
      lines.push(
        `  ${tag} ${item.provider}/${item.window.id} remaining ${remaining}`,
      );
    }
  }

  const pane = lines.join("\n");
  // Q5: no USD outside --full. Snapshot has no USD fields; still scrub $ markers.
  return full ? pane : scrubUsd(pane);
}

function renderProvider(
  provider: ProviderSnapshot,
  options: { color: boolean },
): string[] {
  const { color } = options;
  const lines: string[] = [];
  const trust = paintTrust(provider.trust, color);
  const plan = provider.plan ? `  plan=${provider.plan}` : "";
  lines.push(
    `${paint(color, "bold", provider.label)}  [${provider.provider}]  ${trust}  ${provider.status}${plan}`,
  );

  if (provider.error) {
    lines.push(paint(color, "dim", `  error: ${provider.error}`));
  }
  if (provider.reason && provider.remedyCommand) {
    lines.push(
      paint(
        color,
        "dim",
        `  remedy: ${provider.remedyCommand} (${provider.reason})`,
      ),
    );
  }
  if (provider.refreshedAt) {
    lines.push(paint(color, "dim", `  refreshed: ${provider.refreshedAt}`));
  }

  if (provider.windows.length === 0) {
    lines.push(paint(color, "dim", "  (no windows)"));
    lines.push("");
    return lines;
  }

  const primaryId = provider.primary?.id;
  for (const window of provider.windows) {
    const isPrimary = primaryId !== undefined && window.id === primaryId;
    lines.push(renderWindowLine(window, { color, isPrimary }));
  }
  lines.push("");
  return lines;
}

function renderWindowLine(
  window: SnapshotWindow,
  options: { color: boolean; isPrimary: boolean },
): string {
  const { color, isPrimary } = options;
  const tag = levelTag(window.level, color);
  const mark = isPrimary ? "*" : " ";
  const remaining =
    window.percentRemaining === undefined
      ? "  ?%"
      : `${String(window.percentRemaining).padStart(3)}%`;
  const reset = formatReset(window);
  const burn = formatBurn(window.burnRate);
  const label = window.label.padEnd(18).slice(0, 18);
  return `${mark}${tag} ${label}  rem ${remaining}  reset ${reset}  burn ${burn}`;
}

function scrubUsd(text: string): string {
  return text.replace(/\$[\d,.]+/g, "[hidden]").replace(/\bUSD\b/gi, "");
}

function formatReset(window: SnapshotWindow): string {
  if (window.resetInSeconds === null || window.resetInSeconds === undefined) {
    return window.resetText?.trim() || "unknown";
  }
  if (window.resetInSeconds <= 0) return "now";
  return formatDuration(window.resetInSeconds);
}

function formatBurn(burn: BurnRate): string {
  if (!burn.available) {
    return burn.reason === "insufficient_data" ? "n/a" : "—";
  }
  const value = burn.percentPerHour;
  if (!Number.isFinite(value)) return "n/a";
  const rounded = Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded}%/h`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function levelTag(level: SnapshotLevel, color: boolean): string {
  switch (level) {
    case "critical":
      return paint(color, "red", "CRIT");
    case "warn":
      return paint(color, "yellow", "WARN");
    default:
      return paint(color, "green", " ok ");
  }
}

function paintTrust(trust: ProviderSnapshot["trust"], color: boolean): string {
  switch (trust) {
    case "fresh":
      return paint(color, "green", "fresh");
    case "cached":
      return paint(color, "dim", "cached");
    case "stale":
      return paint(color, "yellow", "stale");
    case "unavailable":
      return paint(color, "red", "unavailable");
    default:
      return trust;
  }
}

function paint(color: boolean, style: keyof typeof ANSI, text: string): string {
  if (!color || style === "reset") return text;
  return `${ANSI[style]}${text}${ANSI.reset}`;
}

/** Exported for tests: red-line threshold labels only (levels come from data seat). */
export function isRedLine(level: SnapshotLevel): boolean {
  return level === "warn" || level === "critical";
}
