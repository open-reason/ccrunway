# ccrunway

ccrunway tells you when your Claude Code 5-hour limit runs out at your current pace, which chat
and what part of it is using the limit up, and what the next send will cost before you send it.
It adds one line under your Claude Code status line and keeps whatever status line you already
have. AI coding agents: see [For AI agents](#for-ai-agents).

```
ccrunway · pace ▮▮▯▯  12%/h · Opus 5.5 · 40k · 5h 1% · checking… · resets 2:35pm
ccrunway · pace ▮▮▯▯  18%/h · Opus 5.5 · 120k · 5h 45% · ✓ on track · ~15% spare at 2:35pm
ccrunway · pace ▮▮▮▯  21%/h · Opus 5.5 · 140k · 5h 55% · ⚠ tight · ~3% spare at 2:35pm
ccrunway · pace ▮▮▮▮  30%/h · Fable 5.2 · 180k · 5h 62% · ✗ runs out 1:55pm, 40 min early
         · top drain: this chat, browser 7%/h
```

`ccrunway menubar on` also puts Claude Code's and Codex's pace in the macOS menu bar.

## Install

Requirements:

- macOS. Install refuses other systems; `--force` tries anyway, untested.
- Node 20 or newer.
- Claude Code on a plan with a 5-hour limit (Pro or Max). API-key sessions have no 5-hour
  meter, so there is nothing to forecast.

```bash
npx ccrunway install
```

Then open a new Claude Code session and send a message. Check it with:

```bash
npx ccrunway doctor
```

What install changes:

- `~/.claude/settings.json`: `statusLine` becomes ccrunway's, with `refreshInterval: 5`
  (replacing yours). Your previous status line (ccusage, ccstatusline, your own script) is
  saved and still runs with the same input; its output prints above the runway line.
- Four hooks in the same file: `UserPromptSubmit`, `Stop`, `PostToolUse`, `PreModelSwitch`,
  each in its own group with a 5 s timeout, run by the absolute path of the node that ran
  install. Other hooks stay as they are.
- `~/.claude/skills/ccrunway/SKILL.md`: a skill, so you can ask Claude Code "how close am I to
  the limit?" or "mute ccrunway for an hour".
- `~/.ccrunway/app`: a copy of the code, so clearing the npx cache breaks nothing.
- `~/.ccrunway/settings.<timestamp>.json`: a backup of your settings.json before the change,
  and `~/.ccrunway/install.json`: what install changed, which uninstall reads.

Running install again is safe: it replaces its own entries and keeps pointing uninstall at the
first backup. Use it to repair or update; there is no need to uninstall first.

If you use nvm, fnm or another version manager, the hooks keep the node path install saw, and
that path can disappear when you upgrade node. Pass a path that survives upgrades, for example
`npx ccrunway install --node /opt/homebrew/bin/node`, or re-run install after you switch.
`doctor` reports a missing node.

Don't edit ccrunway's entries in settings.json by hand. Uninstall finds them by their exact
commands and restores your backup byte for byte only when the rest of the file matches it.

## Reading the line

- **pace ▮▮▯▯ 12%/h**: this chat's rate, in % of the 5-hour limit per hour. The bars compare it
  with the rate that would use up what is left exactly at the reset: three bars is about that
  rate, four is faster. `pace ▯▯▯▯ –%/h` means no rate: nothing spent in the last 20 minutes,
  or no 5-hour meter.
- **Opus 5.5 · 120k · 5h 45%**: the model, the chat's size (amber over 150k) and how much of
  the 5-hour limit is used.
- **The verdict**, from how fast the meter rose over the last 20 minutes:
  - grey `checking… · resets 2:35pm`: no forecast yet. The meter has to rise across about
    5 minutes of readings first, which depends on use, not on the clock; it also shows when
    the window has just reset or the meter has not risen at all.
  - green `✓ on track · ~15% spare at 2:35pm`: at this pace, about 15% of the limit is left
    when it resets.
  - amber `⚠ tight · ~3% spare at 2:35pm`: the limit runs out within 15 minutes after the
    reset, too close to count on.
  - red `✗ runs out 1:55pm, 40 min early`: the limit runs out before the reset.
- **top drain** (amber and red only, on a second line): what is using the limit most across
  all your chats: a chat and its biggest part (`browser`, `long chat`, `helpers`,
  `long answers`), or `outside Claude Code` when the meter rose more than your chats explain.
- **big result: Read 50k**: the last turn had one tool result over 10k tokens.
- **Before a costly send**, in place of the verdict:
  `⚠ next send costs ≈14% (reloads chat) · would run out 1:50pm` when the prompt cache has
  expired on a chat over 150k, and `⚠ model switch costs ≈8% (resends chat) · still on track`
  when you switch models.
- **muted until 3:05pm**: `ccrunway mute` is on; the data keeps updating.

## Commands

Run them with `npx ccrunway <command>`, or ask Claude Code.

| Command | What it does | Flags |
|---|---|---|
| `now` | each tool's 5-hour meter, pace, verdict, top drain and chats, with a cold cache's next-send cost; works before install | `--tool claude\|codex`, `--chat <id\|name>`, `--exit-code`, `--settings` |
| `status` | installed or not, the wrapped status line, mute, debug, menu bar | `--settings` |
| `doctor` | checks the install one check at a time and names the fix; exits 1 when a required check fails | `--settings` |
| `install` | adds the status line and hooks to settings.json | `--dry-run`, `--node <abs path>`, `--force`, `--settings` |
| `uninstall` | removes them, puts your status line back, turns the menu bar item off | `--dry-run`, `--purge`, `--settings` |
| `mute [<time>]` | shows "muted" instead of the line for `30m`, `2h`, `1d` (default 1h) | `--settings` |
| `unmute` | shows the line again | `--settings` |
| `debug on\|off` | adds the reset's seconds and the meter reading's age to the line | `--settings` |
| `menubar [status\|on\|off]` | the macOS menu bar item; no argument shows its state | `--yes` |
| `help` | the help | |
| `version` | the version | |

Every command takes `--json` and then prints one JSON object on stdout, nothing else.
`--settings <path>` points at another settings.json (default `~/.claude/settings.json`);
`--dry-run` prints the resulting settings and writes nothing.

Environment: `CCRUNWAY_HOME` moves the data folder (default `~/.ccrunway`; set it where Claude
Code starts too, since the hooks read it), `CODEX_HOME` is Codex's folder (default
`~/.codex`), `NO_COLOR` turns colour off.

## Menu bar (Claude Code and Codex)

```bash
npx ccrunway menubar on
```

Puts both tools' pace in the macOS menu bar: `[Anthropic] ▮▮▯▯ [OpenAI] ▮▯▯▯`, with the
verdict, the top drain and every chat's %/h in the dropdown. Codex is read from
`~/.codex/sessions`; the menu bar works without the Claude Code install too. The item is drawn
by [SwiftBar](https://github.com/swiftbar/SwiftBar). If it is missing, ccrunway asks, then
installs it with `brew install --cask swiftbar`, or without Homebrew downloads SwiftBar 2.1.1
from its GitHub release into `~/Applications` and checks the file's SHA-256 before installing
it (macOS 12 or newer). Without a terminal it does not ask: it stops with `NEEDS_CONFIRM`, and
`--yes` answers yes. If your SwiftBar already has a plugin folder, ccrunway adds one link to
it and never overwrites a file.

`ccrunway menubar off` undoes only what `on` did: the link, the plugin folder setting, the
login item, and SwiftBar itself only if ccrunway downloaded it.

## For AI agents

Steps for an AI coding agent (Claude Code, Codex, …) asked to install or use ccrunway. Every
command takes `--json`; `npx ccrunway help --json` is the authoritative list of commands,
flags, exit codes, verdict states and environment variables.

### 1. Check preconditions

```bash
uname          # must print Darwin
node --version # must be v20 or newer
```

On another OS, stop and tell the user ccrunway supports macOS only. Don't pass `--force`
unless the user asks for it after hearing that it is untested. The user also needs a Claude
plan with a 5-hour limit (Pro or Max); with an API key there is nothing to forecast.

### 2. Preview, then install

```bash
npx ccrunway install --dry-run --json
```

Prints the settings.json that install would write, and writes nothing:

```json
{"schema":1,"ok":true,"dry_run":true,"settings":"~/.claude/settings.json",
 "settings_after":{"model":"opus",
  "statusLine":{"type":"command","command":"\"/opt/homebrew/bin/node\" \"~/.ccrunway/app/statusline.mjs\"","refreshInterval":5},
  "hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"\"/opt/homebrew/bin/node\" \"~/.ccrunway/app/hook.mjs\"","timeout":5}]}],
   "Stop":[…same…],"PostToolUse":[…same…],"PreModelSwitch":[…same…]}}}
```

(Paths are absolute in real output; `~` here stands for the home folder.) Check that the rest
of the user's settings are unchanged, then:

```bash
npx ccrunway install --json
```

```json
{"schema":1,"ok":true,"settings":"~/.claude/settings.json",
 "backup":"~/.ccrunway/settings.2026-11-17T11-24-32-833Z.json",
 "wraps":"ccusage statusline","skill":"~/.claude/skills/ccrunway/SKILL.md",
 "app":"~/.ccrunway/app","node":"/opt/homebrew/bin/node","version":"0.3.0",
 "next_step":"open a new Claude Code session",
 "next_steps":["open a new Claude Code session","npx ccrunway doctor"]}
```

`wraps` is the user's earlier status line (null if none); it keeps printing above the runway
line. `skill` is null, with `skill_note`, when `~/.claude/skills/ccrunway` exists and is not
ccrunway's. If node comes from nvm or fnm, suggest `--node` with a path that survives node
upgrades (see [Install](#install)).

### 3. Tell the user to open a new Claude Code session and send a message

The status line and hooks load in new sessions. Data starts with the first message.

### 4. Verify

```bash
npx ccrunway doctor --json
```

```json
{"schema":1,"ok":true,"checks":[
 {"id":"platform","ok":true,"required":true,"detail":"macOS","fix":null},
 {"id":"node","ok":true,"required":true,"detail":"v22.11.0; hooks run /opt/homebrew/bin/node (node 22)","fix":null},
 …,
 {"id":"meter","ok":false,"required":false,"detail":"no 5-hour reading yet — open Claude Code and send a message","fix":null},
 {"id":"turns","ok":false,"required":false,"detail":"no turn booked yet — send a message in a new Claude Code session","fix":null},
 {"id":"five_hour_meter","ok":null,"required":false,"detail":"no status-line snapshot yet","fix":null},
 {"id":"menubar","ok":null,"required":false,"detail":"off","fix":null}]}
```

Each check is `{id, ok, required, detail, fix}`. `ok` is `true`, `false`, or `null` (does not
apply). Top-level `ok` is false, and the exit code 1, only when a `required` check is not
true. Right after install, `meter`, `turns` and `five_hour_meter` are not required: false or
null there means warming up, not broken. They turn true once the user has sent messages in a
new session. If `five_hour_meter` stays false after that, the session has no 5-hour limit (an
API key or a plan without one).

| id | required | when it fails | fix (doctor's own string) |
|---|---|---|---|
| `platform` | yes | not macOS | none; `--force` only with the user's OK |
| `node` | yes | node under 20, or the hooks' node is gone or does not run | `npx ccrunway install --node <path to node 20+>` |
| `settings` | yes | no settings.json, or not valid JSON | `npx ccrunway install`, or `fix the JSON in <file> by hand` |
| `status_line` | yes | statusLine is not ccrunway's, or its node is gone | `npx ccrunway install` |
| `wrapped` | yes, when there is an earlier status line | it exits non-zero or takes over 4 s; only the runway line prints | ``fix `<cmd>` so it prints within 4 s, or reinstall (npx ccrunway install) after changing statusLine`` |
| `hooks` | yes | one of the four hooks is missing, or its node is gone | `npx ccrunway install` |
| `app` | yes | `~/.ccrunway/app` is missing or another version | `npx ccrunway install` |
| `data_dir` | yes | `~/.ccrunway` is missing or not writable | `npx ccrunway install`, or `make <dir> writable by you` |
| `meter` | no | no 5-hour reading in the last 15 min | send a message in Claude Code |
| `turns` | no | no turn booked in the last hour | send a message in a new session |
| `five_hour_meter` | no | Claude Code sends no 5-hour limit | none: API key or plan without one |
| `menubar` | yes, after `menubar on` | link gone, SwiftBar missing, not running, or reading another folder | `npx ccrunway menubar on`, or `open -a SwiftBar` |

Re-running `npx ccrunway install` is the fix for most failures; don't uninstall first.

### 5. Answer the user's questions

"How close am I to the limit?", "when will I run out?", "what's draining it?", "what will my
next message cost?":

```bash
npx ccrunway now --json [--tool claude] [--chat <id|name>]
```

```json
{"schema":1,"ok":true,"at":"2026-11-17T12:24:24+01:00","installed":true,"muted_until":null,
 "claude":{"state":"green","summary":"✓ on track · ~75% spare at 2:50pm","meter_pct":11,
  "resets_at":"2026-11-17T14:50:00+01:00","run_out_at":"2026-11-18T03:35:36+01:00",
  "minutes_early":null,"spare_pct_at_reset":75,"pace_pct_per_hour":5.8,
  "top_drain":{"chat":"fix-login-flow","chat_id":"70c925fb-…","part":"helpers","share":0.81,"pct_per_hour":4.7},
  "outside":false,
  "chats":[{"id":"70c925fb-…","name":"fix-login-flow","model":"Opus 5.5","context_tokens":200157,
   "pace_pct_per_hour":5.8,"now_pct_per_hour":10,
   "cache":{"warm":true,"expires_at":"2026-11-17T13:23:58+01:00"},
   "next_send_cost_pct":null,"next_send_warn":false,
   "helpers":[{"name":"Write the tests","model":"Opus","pct_per_hour":3.4}]}]},
 "codex":{…same shape…}}
```

Lead with `summary`: it is the status line's own words. The fields:

- `state`: `none` (no 5-hour meter reading for this tool), `cold` (checking: no forecast yet),
  `green`, `amber`, `red`.
- `meter_pct`: % of the 5-hour limit used. `resets_at`: when it resets (ISO 8601, local
  offset).
- `run_out_at`: when it runs out at this pace. `minutes_early`: red only, how long before the
  reset. `spare_pct_at_reset`: green and amber, % left at the reset.
- `pace_pct_per_hour`: the tool's rate, % of the limit per hour.
- `top_drain`: the chat and part using the most (`part` like `browser`, `helpers`, or
  `outside Claude Code` with `chat` null), `share` of the rate (0–1) and its `pct_per_hour`.
  Present whatever the state; the status line shows it on amber and red only.
- `outside`: the meter rose more than this tool's chats explain (other use of the same
  account).
- `chats[]`: chats active in the last 20 minutes, with `pace_pct_per_hour`, `context_tokens`
  and `helpers` (subagents). Claude only: `cache.warm` and `cache.expires_at` (the prompt
  cache), and when the cache is cold, `next_send_cost_pct`, the % of the limit the next send
  costs to reload the chat; `next_send_warn` is true where the status line warns. Codex:
  `cache` is null.

`--exit-code` adds an exit code for scripts: 0 none/cold/green, 10 amber, 11 red (the worst
tool shown).

Other requests: "is ccrunway working?" → `doctor --json`; "is it on?" → `status --json`;
`mute 2h`, `unmute`, `debug on|off`, `menubar` (status).

### JSON contract

- Every `--json` output is one object with `"schema": 1` and `"ok"`.
- A failure is `{"schema":1,"ok":false,"error":{"code","message","fix"}}`; `fix` is a command to
  run, a step to take, or null. `doctor` is the exception: failed checks come back with
  `"ok": false` and the checks, not an `error`.
- Exit codes: 0 ok; 1 failed (`error.code` says why; for doctor, a required check failed);
  2 bad usage (`USAGE`); 3 not installed, for `mute`, `unmute`, `debug` (`NOT_INSTALLED`);
  `now --exit-code` adds 10 (amber) and 11 (red).
- Nothing waits for an answer under `--json` or without a terminal. A step that needs consent
  fails with `NEEDS_CONFIRM` and names the `--yes` command in `fix`: ask the user, and re-run
  with `--yes` only after they agree.

| code | from | meaning | what to do |
|---|---|---|---|
| `USAGE` | any | unknown command, flag or argument | `npx ccrunway help --json` |
| `NOT_INSTALLED` | mute, unmute, debug | ccrunway is not in that settings.json | `npx ccrunway install` |
| `NO_SUCH_CHAT` | now | `--chat` matches no chat from the last 20 min | run `now` without `--chat` |
| `UNSUPPORTED_OS` | install | not macOS | stop; `--force` only with the user's OK |
| `NODE_TOO_OLD` | install | this node is under 20 | run with node 20+, or `--node <path to node 20+>` |
| `BAD_NODE` | install | `--node` is not an absolute path to a node 20+ that runs | pass an absolute path to node 20+ |
| `SETTINGS_UNREADABLE` | install, uninstall | settings.json is not valid JSON | ask the user to fix the JSON; don't overwrite it |
| `NO_SETTINGS` | uninstall | no settings.json at that path | nothing to uninstall |
| `UNSAFE_PURGE` | uninstall --purge | the data folder is `/`, the home folder, or holds files ccrunway did not write; nothing was changed | `npx ccrunway uninstall` without `--purge` |
| `NEEDS_CONFIRM` | menubar on | SwiftBar must be installed and nobody could be asked | ask the user, then `menubar on --yes` |
| `DECLINED` | menubar on | the user answered no to installing SwiftBar | nothing |
| `NOT_MACOS` | menubar on | not macOS | none |
| `MACOS_TOO_OLD` | menubar on | the SwiftBar download needs macOS 12+ | none |
| `SWIFTBAR_INSTALL_FAILED` | menubar on | brew or unpacking failed | `brew install --cask swiftbar`, then retry |
| `SWIFTBAR_DOWNLOAD_FAILED` | menubar on | the download failed | retry `menubar on --yes` |
| `SWIFTBAR_CHECKSUM_MISMATCH` | menubar on | the download's SHA-256 is wrong; nothing installed | stop and tell the user |
| `PLUGIN_FOLDER_MISSING` | menubar on | SwiftBar's plugin folder does not exist | tell the user |
| `PLUGIN_FILE_TAKEN` | menubar on | a file of the user's has the plugin's name | tell the user; ccrunway left it alone |
| `FAILED` | menubar | any other failure | read `message` |

### Don't

- Edit ccrunway's entries in settings.json by hand. Use `install` and `uninstall`.
- Uninstall to "repair": re-run `install`.
- Run `menubar on` without the user's OK: it may install SwiftBar (Homebrew or a download),
  change SwiftBar's plugin folder and restart it.
- Pass `--force` on a non-macOS system, or `--purge`, without the user's OK.
- Mute or uninstall on your own initiative.

## Uninstall

```bash
npx ccrunway uninstall
```

Removes ccrunway's hooks and status line and puts your earlier status line back (with its own
`refreshInterval`). If the rest of the file is as it was at install, the file is the backup,
byte for byte; if you changed other settings since, those changes stay. It also removes the
`ccrunway` skill and turns the menu bar item off if it was on. Your data stays in
`~/.ccrunway`.

```bash
npx ccrunway uninstall --purge
```

Also deletes `~/.ccrunway` (the data and the installed copy). It refuses, before changing
anything, when that folder is `/` or your home folder, has no `install.json` or `pace.json`,
or holds files ccrunway did not write.

## Privacy

No telemetry. Apart from npx fetching the package, ccrunway makes no network calls. The only
exception is `menubar on`
when SwiftBar is missing and you say yes: it runs `brew install --cask swiftbar`, or without
Homebrew downloads SwiftBar from its GitHub release. ccrunway reads the status line input
Claude Code gives it, your local Claude Code transcripts and, for `now` and the menu bar,
Codex's session files, and keeps what it works out in `~/.ccrunway` (`CCRUNWAY_HOME` moves
it).

## How the forecast works

Claude Code passes the 5-hour meter (the % used and the reset time) to the status line.
ccrunway records each rise and takes the rate over the last 20 minutes: run-out time = now +
(100 − meter) ÷ that rate. Idle minutes add no rises, so the run-out time moves later while
you are not working. The verdict compares the run-out time with the reset.

Per-chat pace, the top drain and next-send costs come from your transcripts, priced with
per-model weights measured against the real 5-hour meter on one Max seat
(`claude-five-weights.json`): output and cache writes cost, cache reads cost nothing. A
reload after the prompt cache expires rewrites the whole chat to the cache, which is why a
long chat's next send can cost several percent.

## Works alongside ccusage

[ccusage](https://github.com/ccusage/ccusage) reports what you spent. ccrunway predicts when
you hit the limit and why. Use both: keep ccusage's status line and ccrunway prints under it.

## License

MIT
