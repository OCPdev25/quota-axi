# validation transcript redaction check

This check reads the committed `HEAD` copy of `.no-mistakes/evidence/fm/quota-axi-build-b1/validation-cli-transcript.md`.
It verifies that absolute local no-mistakes worktree paths are absent while the synthetic fixture quota, account, and cache evidence remains present.

```console
$ node <<'NODE'
const { execFileSync } = require('node:child_process');
const file = '.no-mistakes/evidence/fm/quota-axi-build-b1/validation-cli-transcript.md';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const content = execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' });
const checks = [
  ['absolute Kun home path leaks', /\/Users\/kunchen/g],
  ['absolute no-mistakes worktree leaks', /\/Users\/[^\s`]+\.no-mistakes\/worktrees\/[^\s`)]+/g],
  ['raw no-mistakes worktree ids', /\.no-mistakes\/worktrees\/[0-9A-Za-z_-]{8,}\/[0-9A-Za-z_-]{8,}/g],
];
const required = [
  '<worktree>/bin/quota-axi.ts',
  '<worktree>/.no-mistakes/evidence/fm/quota-axi-build-b1/runtime.bHkAr4/cache/quota-axi/quotas.json',
  'claude,seven_day_opus,opus week,93,"2026-07-11T09:30:00Z",fresh',
  'claude,extra_usage,extra usage,75,unknown,fresh',
  'codex,person@example.invalid,none,acct_fixture',
  '"remaining": 12',
  '$ grep -ciE "access[_-]?token|authorization|bearer|sk-" "$XDG_CACHE_HOME/quota-axi/quotas.json"\n0',
];
console.log(`file: ${file}`);
console.log(`commit: ${commit}`);
for (const [label, pattern] of checks) {
  const matches = content.match(pattern) ?? [];
  console.log(`${label}: ${matches.length}`);
  if (matches.length > 0) process.exitCode = 1;
}
for (const value of required) {
  const present = content.includes(value);
  console.log(`${present ? 'present' : 'missing'}: ${value}`);
  if (!present) process.exitCode = 1;
}
NODE
file: .no-mistakes/evidence/fm/quota-axi-build-b1/validation-cli-transcript.md
commit: 21cc3dbefc39abf8a4e9c9ce23a288792195a36d
absolute Kun home path leaks: 0
absolute no-mistakes worktree leaks: 0
raw no-mistakes worktree ids: 0
present: <worktree>/bin/quota-axi.ts
present: <worktree>/.no-mistakes/evidence/fm/quota-axi-build-b1/runtime.bHkAr4/cache/quota-axi/quotas.json
present: claude,seven_day_opus,opus week,93,"2026-07-11T09:30:00Z",fresh
present: claude,extra_usage,extra usage,75,unknown,fresh
present: codex,person@example.invalid,none,acct_fixture
present: "remaining": 12
present: $ grep -ciE "access[_-]?token|authorization|bearer|sk-" "$XDG_CACHE_HOME/quota-axi/quotas.json"
0
```
