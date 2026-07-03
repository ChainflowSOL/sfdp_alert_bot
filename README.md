# SFDP Alert Bot

A Telegram alert bot for Solana validators enrolled in the **Solana Foundation
Delegation Program (SFDP)**. It watches the SFDP required-versions API and pages
you when the required agave / firedancer versions change — and, optionally, when
one of your own validators drifts out of compliance.

It is a single self-contained TypeScript file with no runtime dependencies (only
Node's built-in `fetch`, `AbortController`, and `parseArgs`), so it runs happily
under cron, systemd, or Docker.

## What it alerts on

| Trigger | Message |
| --- | --- |
| A required version for a tracked epoch is edited | ⚠️ `SFDP required version CHANGED` |
| A new explicit future requirement is published | 🆕 `New SFDP required version published` |
| Your validator is below the min / above the max in force | 🚨 `Validator NON-COMPLIANT` |
| A future epoch will require an upgrade you haven't done | 🔔 `Validator upgrade needed soon` |
| Your validator's RPC stops responding | 📵 `Validator UNREACHABLE` |
| A previously-unreachable validator comes back healthy | ✅ `Validator back online & compliant` |
| First run | ✅ one-time baseline summary of current requirements |
| Configured quiet period elapses with no other alert | 💓 `SFDP monitor heartbeat` |

Alerts fire only on **transitions** — the bot persists a state file and dedupes,
so a standing condition (e.g. a validator that stays non-compliant) is not
re-sent every poll. It *is* re-sent if the underlying requirement tightens
further, so you always know when the target moves.

Version comparison is full semver, including pre-releases — e.g. it correctly
orders `4.0.0-beta7 < 4.0.0-rc1 < 4.0.0`.

## Requirements

- Node.js **>= 18.17** (for the global `fetch` / `AbortController`)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather)) and the chat
  ID(s) you want alerts delivered to

## Install

```bash
npm install
npm run build      # compiles src/ -> dist/
```

## Configure

Copy the example and fill it in:

```bash
cp config.example.json config.json
```

```jsonc
{
  "telegram": {
    "bot_token": "PASTE_BOT_TOKEN_FROM_BOTFATHER",
    "chat_ids": ["-1001234567890"]        // one or more chat/channel IDs
  },

  "poll_interval_seconds": 300,           // how often to poll (loop mode)
  "heartbeat_interval_hours": 24,         // 0 disables the heartbeat
  "clusters": ["mainnet-beta", "testnet"],
  "state_file": "sfdp_state.json",        // resolved relative to config.json

  "validators": [                         // optional; omit for pure version tracking
    {
      "name": "my-testnet-val",
      "cluster": "testnet",
      "client": "agave",                  // "agave" | "firedancer"
      "rpc_url": "http://127.0.0.1:8899"  // must be YOUR validator's own RPC
    }
  ]
}
```

`config.json` and `sfdp_state.json` are git-ignored.

> **Point `rpc_url` at your own validator**, not a public endpoint like
> `api.mainnet-beta.solana.com`. A public RPC reports the Foundation's version,
> not yours, so compliance checks would be meaningless. The bot warns once per
> run if it detects a known public host.

### Environment overrides (handy for systemd / Docker)

Secrets can be supplied via the environment instead of the config file:

| Variable | Effect |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Overrides `telegram.bot_token` |
| `TELEGRAM_CHAT_IDS` | Comma-separated; overrides `telegram.chat_ids` |
| `CONFIG_FILE` | Default path for `--config` |

## Run

```bash
npm start                 # loop forever, polling every poll_interval_seconds
npm run once              # a single poll then exit (good for cron)
npm run dev               # run from source with tsx (no build step)

node dist/sfdpAlertBot.js --test       # send a test message and exit
node dist/sfdpAlertBot.js --dry-run    # print alerts to stdout, send nothing
```

### CLI flags

| Flag | Description |
| --- | --- |
| `--config <path>` | Config file path (default `config.json`, or `$CONFIG_FILE`) |
| `--once` | Run one polling cycle and exit |
| `--test` | Send a test Telegram message and exit |
| `--dry-run` | Print alerts to stdout instead of sending them |
| `--verbose` | Enable debug logging |

## Deploy

### cron (using `--once`)

```cron
*/5 * * * * cd /opt/sfdp-alert-bot && /usr/bin/node dist/sfdpAlertBot.js --once >> bot.log 2>&1
```

### systemd (long-running loop)

```ini
# /etc/systemd/system/sfdp-alert-bot.service
[Unit]
Description=SFDP required-version alert bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/sfdp-alert-bot
ExecStart=/usr/bin/node dist/sfdpAlertBot.js --config /opt/sfdp-alert-bot/config.json
Environment=TELEGRAM_BOT_TOKEN=xxxxx
Environment=TELEGRAM_CHAT_IDS=-1001234567890
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now sfdp-alert-bot
journalctl -u sfdp-alert-bot -f
```

The state file is written atomically (temp file + rename) and persisted after
each cluster, so a restart mid-poll never re-fires already-processed alerts.

## Test

```bash
npm test          # runs the logic suite with tsx
```

The suite covers version comparison, requirement diffing, and the compliance
state machine (non-compliance, requirement tightening, unreachable → recovery).

## How it works

Each poll:

1. Fetches `GET /api/community/v1/sfdp_required_versions?cluster=<cluster>` for
   every configured cluster and diffs it against the saved state, emitting change
   / new-requirement alerts. Diffing is field-agnostic — any `*_min_version` /
   `*_max_version` field the API adds is picked up automatically.
2. For each configured validator, queries its RPC (`getVersion`, `getEpochInfo`)
   and checks the running version against the requirement in force plus any
   upcoming ones. Emits compliance, unreachable, and recovery alerts on
   transition.
3. If enabled and the quiet period has elapsed with no other message, sends a
   heartbeat summary so "no news" is distinguishable from "bot is dead".

API reference: <https://solana.org/delegation-api-docs>

## License

Apache License 2.0 — see [LICENSE](LICENSE).
