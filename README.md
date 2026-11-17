# ccrunway

ccrunway tells you when your Claude Code 5-hour limit runs out at your current pace, which chat
and what part of it is using the limit up, and what the next send will cost before you send it.
It adds one line under your Claude Code status line and keeps whatever status line you already
have.

```
ccrunway · pace ▮▯▯▯   4%/h · Opus 5.5 · 40k · 5h 1% · checking… · resets 2:35pm
ccrunway · pace ▮▮▯▯  12%/h · Opus 5.5 · 120k · 5h 45% · ✓ on track · ~15% spare at 2:35pm
ccrunway · pace ▮▮▮▯  21%/h · Opus 5.5 · 140k · 5h 55% · ⚠ tight · ~3% spare at 2:35pm
ccrunway · pace ▮▮▮▮  30%/h · Fable 5.2 · 180k · 5h 62% · ✗ runs out 1:55pm, 40 min early
         · top drain: this chat, browser 58%/h
```

## Install

macOS, Node 20 or newer, Claude Code with a Pro or Max plan. The menu bar also needs
[SwiftBar](https://github.com/swiftbar/SwiftBar), a free app; `ccrunway menubar on` installs it
for you if it is missing (below).

```bash
npx ccrunway install
```

Then open a new Claude Code session. Install backs up `~/.claude/settings.json`, prints the
backup's path, and copies itself to `~/.ccrunway/app`, so clearing the npx cache breaks nothing.
If you already have a status line (ccusage, ccstatusline, your own script), it keeps running
with the same input and prints first; the runway line goes under it.

## What the line means

- **pace ▮▮▯▯ 12%/h**: this chat's rate, in % of the 5-hour limit per hour. The bars compare it
  with the rate that would use up what is left exactly at the reset: three bars is about that
  rate, four is faster.
- **Opus 5.5 · 120k · 5h 45%**: the model, the chat's size (amber over 150k) and how much of
  the 5-hour limit is used.
- **The verdict**, from the meter's rise over the last 20 minutes:
  - grey `checking…`: under 5 minutes of readings so far
  - green `✓ on track · ~15% spare at 2:35pm`: at this pace, about 15% of the limit is left
    when it resets
  - amber `⚠ tight`: the limit runs out within 15 minutes of the reset
  - red `✗ runs out 1:55pm, 40 min early`: the limit runs out before the reset
- **top drain** (amber and red only): what is using the limit most, across all your chats:
  a chat and its biggest part (`browser`, `long chat`, `helpers`, `long answers`), or
  `outside Claude Code` when the meter rose more than your chats explain.
- **big result: Read 50k**: the last turn had one tool result over 10k tokens.
- **Before a costly send**, in place of the verdict:
  `⚠ next send costs ≈14% (reloads chat) · would run out 1:50pm` when the prompt cache has
  expired on a long chat, and `⚠ model switch costs ≈8% (resends chat)` when you switch models.

Costs come from per-model weights measured against the real 5-hour meter
(`claude-five-weights.json`); cache reads cost nothing, cache writes and output do.

## Menu bar (Claude Code and Codex)

```bash
npx ccrunway menubar on
```

Puts both tools' pace in the macOS menu bar: `[Anthropic] ▮▮▯▯ [OpenAI] ▮▯▯▯`, with the
verdict, the top drain and every chat's %/h in the dropdown. Codex is read from
`~/.codex/sessions`; it works without Claude Code installed too. The item is drawn by
[SwiftBar](https://github.com/swiftbar/SwiftBar). If you don't have it, ccrunway asks, then
installs it with `brew install --cask swiftbar`, or without Homebrew downloads SwiftBar 2.1.1
from its GitHub release and checks the file's SHA-256 before installing it. If your SwiftBar
already has a plugin folder, ccrunway adds one link to it and never overwrites a file.

`ccrunway menubar off` undoes only what `on` did: the link, the plugin folder setting, the
login item, and SwiftBar itself only if ccrunway downloaded it.

## Commands

```bash
ccrunway status [--json]     # installed or not, the status line it wraps, mute, debug, menu bar
ccrunway doctor [--json]     # is it working? one line per check, with the fix
ccrunway mute 2h             # show "muted" instead of the line (30m, 2h, 1d)
ccrunway unmute
ccrunway debug on|off        # add the reset's seconds and the meter reading's age
ccrunway menubar on|off      # the macOS menu bar item (--yes skips the SwiftBar question)
ccrunway uninstall
```

Run them with `npx ccrunway …`, or ask Claude Code ("mute ccrunway for an hour"): install adds
a `ccrunway` skill that knows these commands. `install` and `uninstall` take
`--settings <path>` and `--dry-run`.

## Privacy

No telemetry. The only network call is the one-time SwiftBar download, and only if you turn
on the menu bar without Homebrew and say yes. ccrunway reads the status line input Claude
Code gives it, your local chat transcripts and, for the menu bar, Codex's session files, and
keeps what it works out in `~/.ccrunway` (`CCRUNWAY_HOME` moves it).

## Uninstall

```bash
npx ccrunway uninstall
npx ccrunway uninstall --purge   # also deletes ~/.ccrunway: the data and the installed copy
```

Uninstall removes only ccrunway's hooks and status line (and the menu bar item) and puts your
earlier status line back.
If nothing else changed in the file, it is byte-for-byte the backup.

## Works alongside ccusage

[ccusage](https://github.com/ccusage/ccusage) reports what you spent. ccrunway predicts when
you hit the limit and why. Use both: keep ccusage's status line and ccrunway prints under it.

## License

MIT
