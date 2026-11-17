#!/bin/bash
# <xbar.title>ccrunway</xbar.title>
# <xbar.desc>Claude Code and Codex 5-hour pace in the menu bar</xbar.desc>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
#
# `ccrunway menubar on` links this file into SwiftBar's plugin folder. It lives in
# <CCRUNWAY_HOME>/app/menubar/plugin; the data is in <CCRUNWAY_HOME>.
# SwiftBar runs plugins with a minimal PATH (/usr/bin:/bin:…), so node is looked for where
# it is usually installed, first match with Node 20+ wins:
#   $CCRUNWAY_NODE; the node ccrunway was installed with (install.json or menubar.json
#   `node`); node on the PATH; Homebrew (Apple silicon, Intel); the newest nvm, fnm, Volta
#   and asdf installs.

here="$(cd "$(dirname "$0")" && pwd -P)"
# a symlink into SwiftBar's plugin folder: follow it back to app/menubar/plugin
if [ -L "$0" ]; then
  target="$(readlink "$0")"
  case "$target" in /*) ;; *) target="$here/$target" ;; esac
  here="$(cd "$(dirname "$target")" && pwd -P)"
fi
# this file sits alone in plugin/ because SwiftBar runs every file in its folder as a
# plugin; the code is one level up, the data three
here="$(cd "$here/.." && pwd -P)"
export CCRUNWAY_HOME="${CCRUNWAY_HOME:-$(cd "$here/../.." && pwd -P)}"

ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  local major
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  case "$major" in ''|*[!0-9]*) return 1;; esac
  [ "$major" -ge 20 ]
}

saved() {
  sed -n 's/^ *"node": *"\(.*\)",*$/\1/p' "$CCRUNWAY_HOME/$1" 2>/dev/null | head -1
}

candidates() {
  printf '%s\n' "${CCRUNWAY_NODE:-}"
  saved install.json
  saved menubar.json
  command -v node 2>/dev/null
  printf '%s\n' /opt/homebrew/bin/node /usr/local/bin/node
  ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV
  ls -1d "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -rV
  printf '%s\n' "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node"
}

while IFS= read -r n; do
  if ok "$n"; then
    exec "$n" "$here/menubar.mjs"
  fi
done < <(candidates)

echo "⚠ ccrunway | color=#a8a294"
echo "---"
echo "Node 20 or newer not found | color=#a8a294"
