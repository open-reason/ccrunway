---
name: ccrunway
description: Mute, unmute, check, remove or debug ccrunway, or turn its macOS menu bar item on or off, the status line that says when the Claude Code 5-hour limit runs out at the current pace. Use when the user asks to mute, silence, pause, unmute, remove or uninstall ccrunway (or "the runway line"), asks whether it is on, or wants its debug numbers.
---

# ccrunway control

ccrunway is a status line plus four Claude Code hooks on this computer. It prints one line
under the user's own status line: the pace, the chat size, the 5-hour meter and when the
limit runs out at this pace. Control it with one command; changes apply on the next status
line refresh, no restart needed.

```bash
{{CLI}} <command>
```

| User says | Run |
|---|---|
| "is ccrunway on" / "runway status" | `status` |
| "mute / hide the runway line for 2 hours" | `mute 2h` (30m, 2h, 1d; default 1h) |
| "unmute ccrunway" | `unmute` |
| "remove ccrunway" / "uninstall it" | `uninstall` |
| "show the debug numbers" | `debug on` (`debug off` to hide them) |
| "put it in the menu bar" / "show Codex too" | `menubar on` (see below) |
| "remove the menu bar item" | `menubar off` |

Rules:
- Run only what the user asked for. Never mute or remove ccrunway on your own initiative.
- Prefer `mute` when the user wants quiet for a while and `uninstall` only when they want it gone.
- `menubar on` may need to install SwiftBar (Homebrew, or a download from GitHub). Without a
  terminal it stops and says so: tell the user, and add `--yes` only after they agree.
- After a change, reply with the command's one-line output, nothing more.
