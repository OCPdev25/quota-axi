# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- quota-axi is data only.
- It reports local Claude and Codex quota windows, and it must never route, recommend, proxy, intercept, log in, import browser cookies, or mutate provider state.
- Claude quota windows can include `five_hour`, `seven_day`, `seven_day_opus`, and `extra_usage`.
- Codex quota windows can include `five_hour` and `weekly`, plus optional credit balance data.
- Default stdout is compact TOON.
- `--json` emits the normalized model, and `--full` is required before account identity or per-source attempts are shown.
- JSON provider reports include `provider`, `label`, `source`, `windows`, and `state`; `state.retryAfter` can appear for provider rate limits.
- macOS Claude Keychain reads are skipped by default because they can prompt.
- `--allow-keychain-prompt` is the only v1 opt-in for that behavior.
- Codex uses `$CODEX_HOME/auth.json` or `~/.codex/auth.json` OAuth before the CLI fallback.
- Codex `auth.json` support is OAuth-token only; never treat `OPENAI_API_KEY` as valid quota auth or send API keys to ChatGPT quota endpoints.
- Never launch the Claude CLI to probe quota, because that would spend the quota being measured.
- The read-only Codex app-server JSON-RPC probe is the only CLI fallback.
- The cache path is `~/.cache/quota-axi/quotas.json`, or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set.
- Cache files must be `0600` and contain only normalized non-secret snapshots.
- Only fresh provider snapshots with windows are cached.
- Failed providers, stale providers, account identity, and source attempts are not cached.
- Do not cache raw provider responses or credential headers.
- CodexBar is a reference only, not a runtime dependency.
- Substantial translated CodexBar adapter behavior must preserve MIT attribution to Peter Steinberger.

## Development

```sh
pnpm install
pnpm run build
pnpm test
```
