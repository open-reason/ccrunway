---
name: ccrunway
description: Answer how close the user is to the Claude Code 5-hour limit, when it runs out at this pace, what is using it up, and what the next message will cost, from ccrunway's own numbers; check whether ccrunway works; mute, unmute, debug, remove it or turn its menu bar item on or off. Use when the user asks "how close am I to the limit", "when will I run out", "what's draining my usage", "what will my next message cost", "is ccrunway working", or asks to mute, silence, pause, unmute, remove or uninstall ccrunway (or "the runway line").
---

# ccrunway

ccrunway is a status line plus four Claude Code hooks on this computer. It prints one line
under the user's own status line: the pace, the chat size, the 5-hour meter and when the
limit runs out at this pace. Run it with:

```bash
{{CLI}} <command> --json
```

Every command prints one JSON object: `{"schema":1,"ok":true,…}`, or on failure
`{"schema":1,"ok":false,"error":{"code","message","fix"}}`. `{{CLI}} help --json` lists every
command, flag and exit code. Changes apply on the next status line refresh, no restart.

| User asks | Run |
|---|---|
| "how close am I to the limit?" / "when will I run out?" / "what's draining it?" / "what will my next message cost?" | `now --json` |
| "is ccrunway working?" / "why does it say checking…?" | `doctor --json` |
| "is ccrunway on?" | `status --json` |
| "mute / hide the runway line for 2 hours" | `mute 2h` (30m, 2h, 1d; default 1h) |
| "unmute ccrunway" | `unmute` |
| "show the debug numbers" | `debug on` (`debug off` to hide them) |
| "put it in the menu bar" / "show Codex too" | `menubar on` (see rules) |
| "remove the menu bar item" | `menubar off` |
| "remove ccrunway" / "uninstall it" | `uninstall` |
| "update ccrunway" / "is there a new version?" | `update` (`update --check` only reports) |

## Answering from `now --json`

Lead with `claude.summary` (the status line's own words), then the field the question needs:

- how close: `meter_pct` (% used) and `resets_at`
- when it runs out: `state` (`cold` = still checking, `green`, `amber`, `red`, `none` = no
  meter), `run_out_at`, `minutes_early` (red), `spare_pct_at_reset` (green, amber)
- what drains it: `top_drain` (`chat`, `part`, `pct_per_hour`) and `chats[].pace_pct_per_hour`,
  `chats[].helpers`
- next message cost: `chats[].cache.warm`; when false, `chats[].next_send_cost_pct` is the %
  of the limit the next send costs to reload the chat (`next_send_warn` true = worth warning)

`--chat <id|name>` narrows to one chat, `--tool claude|codex` to one tool. Times are ISO 8601;
say them as local clock times.

`doctor --json`: each check is `{id, ok, required, detail, fix}`. A false `meter`, `turns` or
`five_hour_meter` right after install means warming up: send messages in a new session. A
false `menubar_running` means SwiftBar is closed (`open -a SwiftBar`), a warning only. A
failing required check names its fix; re-running install fixes most of them.

## Rules

- Run only what the user asked for. Never mute or uninstall ccrunway on your own initiative.
- Prefer `mute` when the user wants quiet for a while; `uninstall` only on an explicit request.
- Never run `uninstall --purge`, `install --force` or `menubar on --yes` without the user's
  OK. `update` re-runs install, which turns the menu bar item on and installs SwiftBar if it is
  missing; add `--no-menubar` if the user doesn't want that. `menubar on` may install SwiftBar (Homebrew, or a download from GitHub); under `--json`
  it fails with `NEEDS_CONFIRM` instead of asking: tell the user, and add `--yes` only after
  they agree.
- Don't edit ccrunway's entries in settings.json by hand.
- After a change, reply with one line, nothing more.
