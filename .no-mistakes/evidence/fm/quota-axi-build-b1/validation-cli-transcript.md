# quota-axi validation CLI transcript

Captured on 2026-07-07 against commit aac804fa3c2b0e18d13d73fb673610b574f04e8a.
Each prompt below is the `quota-axi` CLI entrypoint executed from source with `node --import tsx bin/quota-axi.ts` so the target TypeScript is exercised directly without running a build or static-analysis step.
Provider calls are fixture-backed through a Node preload, with fake homes and throwaway cache directories.
The run did not use personal Claude or Codex credentials, did not allow a Keychain prompt, and did not contact provider services.

## Help output

```console
$ quota-axi --help
usage: quota-axi [auth] [flags]
commands[2]:
  (none)=quota, auth
flags[6]:
  --provider <claude,codex>, --json, --full, --allow-keychain-prompt, --help, -v/--version
examples:
  quota-axi
  quota-axi --provider claude
  quota-axi --json
  quota-axi --full
  quota-axi auth
$ echo $?
0
```

## Version output

```console
$ quota-axi --version
quota-axi 0.1.0
$ echo $?
0
```

## Default quota report with fixture credentials

```console
$ quota-axi
bin: /Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KWXB99P4NFCYGKPZM1TJZRRX/bin/quota-axi.ts
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2035-01-15T12:00:00.000Z"
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,pro,oauth,fresh,"2035-01-15T12:00:00.000Z"
  codex,plus,oauth,fresh,"2035-01-15T12:00:00.000Z"
windows[6]{provider,id,label,percentRemaining,resetsAt,state}:
  claude,five_hour,session,82,"2026-07-06T22:15:00Z",fresh
  claude,seven_day,week,64,"2026-07-10T16:00:00Z",fresh
  claude,seven_day_opus,opus week,93,"2026-07-11T09:30:00Z",fresh
  claude,extra_usage,extra usage,75,unknown,fresh
  codex,five_hour,session,71,"2026-07-06T21:45:00.000Z",fresh
  codex,weekly,week,43,"2035-01-15T13:00:00.000Z",fresh
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
$ echo $?
0
```

## Auth source availability without secrets

```console
$ quota-axi auth
bin: /Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KWXB99P4NFCYGKPZM1TJZRRX/bin/quota-axi.ts
description: Inspect local quota auth sources without printing secret values
auth[4]{provider,source,path,status,error}:
  claude,oauth-file,~/.claude/.credentials.json,available,none
  claude,keychain,none,skipped,keychain_prompt_required
  codex,auth-json,~/.codex/auth.json,available,none
  codex,cli-rpc,none,missing,none
help[1]:
  Run `quota-axi --allow-keychain-prompt auth` to permit macOS Keychain access
$ echo $?
0
```

## JSON output redacts accounts and attempts by default

```console
$ quota-axi --provider codex --json
{
  "generatedAt": "2035-01-15T12:00:00.000Z",
  "schemaVersion": 1,
  "providers": [
    {
      "provider": "codex",
      "label": "Codex",
      "source": "oauth",
      "plan": "plus",
      "windows": [
        {
          "id": "five_hour",
          "label": "session",
          "kind": "session",
          "percentUsed": 29,
          "resetsAt": "2026-07-06T21:45:00.000Z",
          "windowSeconds": 18000,
          "percentRemaining": 71
        },
        {
          "id": "weekly",
          "label": "week",
          "kind": "weekly",
          "percentUsed": 57,
          "resetsAt": "2035-01-15T13:00:00.000Z",
          "percentRemaining": 43
        }
      ],
      "credits": {
        "remaining": 12,
        "unlimited": false,
        "unit": "credits"
      },
      "state": {
        "status": "fresh",
        "stale": false,
        "refreshedAt": "2035-01-15T12:00:00.000Z",
        "sourcesTried": [
          "oauth"
        ]
      }
    }
  ]
}
$ echo $?
0
```

## Full output includes fake account and source attempts

```console
$ quota-axi --full
bin: /Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KWXB99P4NFCYGKPZM1TJZRRX/bin/quota-axi.ts
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2035-01-15T12:00:00.000Z"
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,pro,oauth,fresh,"2035-01-15T12:00:00.000Z"
  codex,plus,oauth,fresh,"2035-01-15T12:00:00.000Z"
windows[6]{provider,id,label,percentRemaining,resetsAt,state}:
  claude,five_hour,session,82,"2026-07-06T22:15:00Z",fresh
  claude,seven_day,week,64,"2026-07-10T16:00:00Z",fresh
  claude,seven_day_opus,opus week,93,"2026-07-11T09:30:00Z",fresh
  claude,extra_usage,extra usage,75,unknown,fresh
  codex,five_hour,session,71,"2026-07-06T21:45:00.000Z",fresh
  codex,weekly,week,43,"2035-01-15T13:00:00.000Z",fresh
accounts[2]{provider,email,organization,accountId}:
  claude,hidden,none,none
  codex,person@example.invalid,none,acct_fixture
attempts[3]{provider,source,status,error}:
  claude,keychain,skipped,keychain_prompt_required
  claude,oauth,success,none
  codex,oauth,success,none
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
$ echo $?
0
```

## Cache file privacy and permissions

```console
$ stat -f "%Lp %N" "$XDG_CACHE_HOME/quota-axi" "$XDG_CACHE_HOME/quota-axi/quotas.json"
700 /Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KWXB99P4NFCYGKPZM1TJZRRX/.no-mistakes/evidence/fm/quota-axi-build-b1/runtime.bHkAr4/cache/quota-axi
600 /Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KWXB99P4NFCYGKPZM1TJZRRX/.no-mistakes/evidence/fm/quota-axi-build-b1/runtime.bHkAr4/cache/quota-axi/quotas.json
$ grep -ciE "access[_-]?token|authorization|bearer|sk-" "$XDG_CACHE_HOME/quota-axi/quotas.json"
0
$ cat "$XDG_CACHE_HOME/quota-axi/quotas.json"
{
  "generatedAt": "2035-01-15T12:00:00.000Z",
  "schemaVersion": 1,
  "providers": [
    {
      "provider": "claude",
      "label": "Claude",
      "source": "oauth",
      "windows": [
        {
          "id": "five_hour",
          "label": "session",
          "kind": "session",
          "percentUsed": 18,
          "percentRemaining": 82,
          "resetsAt": "2026-07-06T22:15:00Z"
        },
        {
          "id": "seven_day",
          "label": "week",
          "kind": "weekly",
          "percentUsed": 36,
          "percentRemaining": 64,
          "resetsAt": "2026-07-10T16:00:00Z"
        },
        {
          "id": "seven_day_opus",
          "label": "opus week",
          "kind": "model",
          "percentUsed": 7,
          "percentRemaining": 93,
          "resetsAt": "2026-07-11T09:30:00Z"
        },
        {
          "id": "extra_usage",
          "label": "extra usage",
          "kind": "credits",
          "percentUsed": 25,
          "percentRemaining": 75,
          "spentUsd": 5,
          "limitUsd": 20
        }
      ],
      "state": {
        "status": "fresh",
        "stale": false,
        "sourcesTried": [
          "keychain",
          "oauth"
        ],
        "refreshedAt": "2035-01-15T12:00:00.000Z"
      },
      "plan": "pro"
    },
    {
      "provider": "codex",
      "label": "Codex",
      "source": "oauth",
      "windows": [
        {
          "id": "five_hour",
          "label": "session",
          "kind": "session",
          "percentUsed": 29,
          "percentRemaining": 71,
          "resetsAt": "2026-07-06T21:45:00.000Z",
          "windowSeconds": 18000
        },
        {
          "id": "weekly",
          "label": "week",
          "kind": "weekly",
          "percentUsed": 57,
          "percentRemaining": 43,
          "resetsAt": "2035-01-15T13:00:00.000Z"
        }
      ],
      "state": {
        "status": "fresh",
        "stale": false,
        "sourcesTried": [
          "oauth"
        ],
        "refreshedAt": "2035-01-15T12:00:00.000Z"
      },
      "plan": "plus",
      "credits": {
        "remaining": 12,
        "unlimited": false,
        "unit": "credits"
      }
    }
  ]
}
```

## Stale cache fallback with no auth files and no codex binary

```console
$ quota-axi
bin: /Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KWXB99P4NFCYGKPZM1TJZRRX/bin/quota-axi.ts
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2035-01-15T12:00:00.000Z"
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,pro,cache,stale,"2035-01-15T12:00:00.000Z"
  codex,plus,cache,stale,"2035-01-15T12:00:00.000Z"
windows[6]{provider,id,label,percentRemaining,resetsAt,state}:
  claude,five_hour,session,82,"2026-07-06T22:15:00Z",stale
  claude,seven_day,week,64,"2026-07-10T16:00:00Z",stale
  claude,seven_day_opus,opus week,93,"2026-07-11T09:30:00Z",stale
  claude,extra_usage,extra usage,75,unknown,stale
  codex,five_hour,session,71,"2026-07-06T21:45:00.000Z",stale
  codex,weekly,week,43,"2035-01-15T13:00:00.000Z",stale
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
$ echo $?
0
```

## All providers failed returns exit code 1

```console
$ quota-axi
bin: /Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KWXB99P4NFCYGKPZM1TJZRRX/bin/quota-axi.ts
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2035-01-15T12:00:00.000Z"
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,unknown,unavailable,auth_required,none
  codex,unknown,unavailable,error,none
windows[0]:
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
$ echo $?
1
```

## Usage errors return exit code 2

```console
$ quota-axi --bogus-flag
error: "unknown argument: --bogus-flag"
code: usage
help[1]:
  Run `quota-axi --help` for supported commands and flags
$ echo $?
2
```
