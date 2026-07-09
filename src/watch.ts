import type { WatchSnapshot, WatchSnapshotOptions } from "./snapshot.js";
import { renderWatchPane, type WatchRenderOptions } from "./watch-render.js";

export type WatchLoopDeps = {
  getSnapshot: (options: WatchSnapshotOptions) => Promise<WatchSnapshot>;
  write: (chunk: string) => void;
  clear?: () => void;
  sleep?: (ms: number) => Promise<void>;
  isTty?: boolean;
  shouldContinue?: () => boolean;
  onSignal?: (handler: () => void) => () => void;
};

export type WatchLoopOptions = {
  intervalMs: number;
  snapshot: WatchSnapshotOptions;
  render: WatchRenderOptions;
  /** When true, paint once and exit (test / smoke). */
  once?: boolean;
};

/**
 * Live watch loop: fetch snapshot, repaint pane, sleep, repeat.
 * All I/O is injected so tests never touch providers.
 */
export async function runWatchLoop(
  options: WatchLoopOptions,
  deps: WatchLoopDeps,
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const isTty = deps.isTty ?? false;
  const shouldContinue = deps.shouldContinue ?? (() => true);
  let stopped = false;

  const stop = () => {
    stopped = true;
  };
  const detach = deps.onSignal?.(stop);

  try {
    do {
      const snapshot = await deps.getSnapshot(options.snapshot);
      const pane = renderWatchPane(snapshot, {
        ...options.render,
        color: options.render.color ?? isTty,
      });
      if (deps.clear && isTty) deps.clear();
      deps.write(`${pane}\n`);
      if (options.once || stopped || !shouldContinue()) break;
      await sleep(options.intervalMs);
    } while (!stopped && shouldContinue());
  } finally {
    detach?.();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type WatchCliFlags = {
  intervalSeconds: number;
  providers?: string;
  refresh: boolean;
  full: boolean;
  json: boolean;
  allowKeychainPrompt: boolean;
  once: boolean;
};

export function defaultWatchIntervalSeconds(): number {
  return 30;
}
