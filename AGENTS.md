# ccrunway for AI agents

Steps for an AI coding agent (Claude Code, Codex, …) asked to install or use ccrunway, and the
reference for its JSON output. The short version is in the README's
[For AI agents](README.md#for-ai-agents). Every command takes `--json`;
`npx ccrunway help --json` is the authoritative list of commands, flags, exit codes, verdict
states and environment variables.

## 1. Check preconditions

```bash
uname          # must print Darwin
node --version # must be v20 or newer
```

On another OS, stop and tell the user ccrunway supports macOS only. Don't pass `--force`
unless the user asks for it after hearing that it is untested. The user also needs a Claude
plan with a 5-hour limit (Pro or Max); with an API key there is nothing to forecast.

## 2. Preview, then install

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
 "restores":"~/.ccrunway/settings.2026-11-17T11-24-32-833Z.json",
 "app":"~/.ccrunway/app","node":"/opt/homebrew/bin/node","version":"0.4.4",
 "menubar":{"on":true,"detail":"~/.ccrunway/menubar/ccrunway.5s.sh (SwiftBar's plugin folder, set by ccrunway)","code":null,"hint":"npx ccrunway menubar off","swiftbar_installed":"brew"},
 "next_step":"open a new Claude Code session",
 "next_steps":["open a new Claude Code session","npx ccrunway doctor"]}
```

`backup` is the settings.json copy this run made; `restores` is the one uninstall puts back
(the first install's, on a re-install). `wraps` is the user's earlier status line (null if
none); it keeps printing above the runway line.

`menubar`: install turns the menu bar item on and, when SwiftBar is missing, installs it
(`swiftbar_installed`: `brew` or `download`) without asking under `--json`. Tell the user
before running install; pass `--no-menubar` if they don't want SwiftBar. A SwiftBar failure
does not fail the install: `menubar.on` is false, `menubar.code` is one of the `menubar on`
codes below (`SWIFTBAR_CHECKSUM_MISMATCH`, …), and `menubar.hint` is the command to retry.
`install --dry-run --json` says what it would do in `menubar_would`: `on`,
`install SwiftBar and turn on`, or `skip` (`--no-menubar`, or not macOS). `skill` is null, with `skill_note`, when `~/.claude/skills/ccrunway` exists and is not
ccrunway's. If node comes from nvm or fnm, suggest `--node` with a path that survives node
upgrades (see the README's [Install](README.md#install)); install already swaps fnm's per-shell
temp path (`fnm_multishells`) for the real one.

If `CCRUNWAY_HOME` is set when install runs, every command it writes carries it:
`CCRUNWAY_HOME="/path/to/data" "/opt/homebrew/bin/node" "/path/to/data/app/hook.mjs"`, and the
skill's command too. Claude Code does not need the variable; the CLI commands you run do
(`now`, `mute`, `uninstall`, …), so keep it set in the shell you run them from.

## 3. Tell the user to open a new Claude Code session and send a message

The status line and hooks load in new sessions. Data starts with the first message.

## 4. Verify

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
 {"id":"menubar","ok":null,"required":false,"detail":"off","fix":null},
 {"id":"menubar_running","ok":null,"required":false,"detail":"menu bar off","fix":null}]}
```

Each check is `{id, ok, required, detail, fix}`. `ok` is `true`, `false`, or `null` (does not
apply). Top-level `ok` is false, and the exit code 1, only when a `required` check is not
true. `required` is fixed per id, except `wrapped` and `menubar`, which are required only when
they apply (see the table). Right after install, `meter`, `turns` and `five_hour_meter` are not
required: false or null there means warming up, not broken. They turn true once the user has sent messages in a
new session. If `five_hour_meter` stays false after that, the session has no 5-hour limit (an
API key or a plan without one).

| id | required | when it fails | fix (doctor's own string) |
|---|---|---|---|
| `platform` | yes | not macOS | none; `--force` only with the user's OK |
| `node` | yes | node under 20, or the hooks' node is gone or does not run | `npx ccrunway install --node <path to node 20+>` |
| `settings` | yes | no settings.json, or not valid JSON | `npx ccrunway install`, or `fix the JSON in <file> by hand` |
| `status_line` | yes | statusLine is not ccrunway's, or its node is gone | `npx ccrunway install` |
| `wrapped` | yes, when there is an earlier status line and a session has run | run as the status line runs it (`/bin/sh -c`, 4 s) on the last session's status-line input, it exits non-zero or takes over 4 s; only the runway line prints. Skipped (`null`) before the first session: there is no real input to test with | ``fix `<cmd>` so it prints within 4 s, or reinstall (npx ccrunway install) after changing statusLine`` |
| `hooks` | yes | one of the four hooks is missing, or its node is gone | `npx ccrunway install` |
| `app` | yes | `~/.ccrunway/app` is missing or another version | `npx ccrunway install` |
| `data_dir` | yes | `~/.ccrunway` is missing or not writable | `npx ccrunway install`, or `make <dir> writable by you` |
| `meter` | no | no 5-hour reading in the last 15 min | send a message in Claude Code |
| `turns` | no | no turn booked in the last hour | send a message in a new session |
| `five_hour_meter` | no | Claude Code sends no 5-hour limit | none: API key or plan without one |
| `menubar` | yes, after `menubar on` | link gone, SwiftBar missing, or SwiftBar reading another folder | `npx ccrunway menubar on` |
| `menubar_running` | no | SwiftBar is installed but not running, so the item does not show (skipped when the menu bar is off or SwiftBar is missing) | `open -a SwiftBar` |

Re-running `npx ccrunway install` is the fix for most failures; don't uninstall first.

## 5. Answer the user's questions

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
  "top_drain":{"chat":"fix-login-flow","chat_id":"3f1a9c2e-…","part":"helpers","share":0.81,"pct_per_hour":4.7},
  "outside":false,
  "chats":[{"id":"3f1a9c2e-…","name":"fix-login-flow","model":"Opus 5.5","context_tokens":200157,
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

## 6. Update

```bash
npx ccrunway update --check --json   # report only
npx ccrunway update --json           # install the latest if it is newer
```

```json
{"schema":1,"ok":true,"installed":"0.4.1","running":"0.4.1","latest":"0.4.2",
 "update_available":true,"updated":true,"command":"npx -y ccrunway@0.4.2 install --json",
 "message":"updated to 0.4.2","install":{…install's own object…}}
```

`installed` is the installed copy's version (null when not installed), `running` the CLI you
ran. Without `--check`, when `latest` is newer than `installed` (or nothing is installed),
update runs `npx -y ccrunway@<latest> install` and embeds its result as `install`;
`--settings`, `--node` and `--no-menubar` are passed on. That install turns the menu bar on
like any install. Already the latest: `updated` false, `message` `ccrunway <v> is the latest`.
The check is one GET to `https://registry.npmjs.org/ccrunway/latest` (5 s timeout).

## JSON contract

- Every `--json` output is one object with `"schema": 1` and `"ok"`.
- A failure is `{"schema":1,"ok":false,"error":{"code","message","fix"}}`; `fix` is a command to
  run, a step to take, or null. `doctor` is the exception: failed checks come back with
  `"ok": false` and the checks, not an `error`.
- `fix` strings that name a ccrunway command spell it `npx ccrunway <command>`.
- Exit codes: 0 ok; 1 failed (`error.code` says why; for doctor, a required check failed);
  2 bad usage (`USAGE`); 3 not installed, for `mute`, `unmute`, `debug` (`NOT_INSTALLED`);
  `now --exit-code` adds 10 (amber) and 11 (red).
- Nothing waits for an answer under `--json` or without a terminal. A step that needs consent
  fails with `NEEDS_CONFIRM` and names the `--yes` command in `fix`: ask the user, and re-run
  with `--yes` only after they agree.

| code | from | meaning | what to do |
|---|---|---|---|
| `USAGE` | any | unknown command, flag or argument | `npx ccrunway help` |
| `NOT_INSTALLED` | mute, unmute, debug | ccrunway is not in that settings.json | `npx ccrunway install` |
| `NO_SUCH_CHAT` | now | `--chat` matches no chat from the last 20 min | `npx ccrunway now` (without `--chat`) |
| `UNSUPPORTED_OS` | install | not macOS | stop; `--force` only with the user's OK |
| `NODE_TOO_OLD` | install | this node is under 20 | run with node 20+, or `--node <path to node 20+>` |
| `BAD_NODE` | install | `--node` is not an absolute path to a node 20+ that runs | pass an absolute path to node 20+ |
| `SETTINGS_UNREADABLE` | install, uninstall | settings.json is not valid JSON | ask the user to fix the JSON; don't overwrite it |
| `NO_SETTINGS` | uninstall | no settings.json at that path | nothing to uninstall |
| `UNSAFE_PURGE` | uninstall --purge | the data folder is `/`, the home folder, or holds files ccrunway did not write; nothing was changed | `npx ccrunway uninstall` without `--purge` |
| `UPDATE_CHECK_FAILED` | update | the npm registry did not answer with a version (offline, timeout) | retry, or `npx ccrunway@latest install` |
| `UPDATE_FAILED` | update | the `npx ccrunway@<latest> install` it ran failed without its own error | read `install`, then `npx ccrunway@latest install` |
| `NEEDS_CONFIRM` | menubar on | SwiftBar must be installed and nobody could be asked | ask the user, then `npx ccrunway menubar on --yes` |
| `DECLINED` | menubar on | the user answered no to installing SwiftBar | nothing |
| `NOT_MACOS` | menubar on | not macOS | none |
| `MACOS_TOO_OLD` | menubar on | the SwiftBar download needs macOS 12+ | none |
| `SWIFTBAR_INSTALL_FAILED` | menubar on | brew or unpacking failed | `brew install --cask swiftbar`, then retry |
| `SWIFTBAR_DOWNLOAD_FAILED` | menubar on | the download failed | retry `npx ccrunway menubar on --yes` |
| `SWIFTBAR_CHECKSUM_MISMATCH` | menubar on, install's `menubar.code` | the download's SHA-256 is wrong; nothing installed | stop and tell the user |
| `PLUGIN_FOLDER_MISSING` | menubar on | SwiftBar's plugin folder does not exist | tell the user |
| `PLUGIN_FILE_TAKEN` | menubar on | a file of the user's has the plugin's name | tell the user; ccrunway left it alone |
| `FAILED` | menubar | any other failure | read `message` |

## Don't

- Edit ccrunway's entries in settings.json by hand. Use `install` and `uninstall`.
- Uninstall to "repair": re-run `install`.
- Run `install` (or `update`) without telling the user it may install SwiftBar (Homebrew,
  or a download from GitHub) for the menu bar item, change SwiftBar's plugin folder and
  restart it; under `--json` it does not ask. Pass `--no-menubar` if they don't want it.
- Run `menubar on --yes` without the user's OK.
- Pass `--force` on a non-macOS system, or `--purge`, without the user's OK.
- Mute or uninstall on your own initiative.
