#!/bin/zsh
# Constrain the Ollama daemon's memory behaviour on a shared-memory Mac.
#
# Guardian's sweep unloads idle and superseded models, but it only runs while
# Studio's server is up. These two values are the floor underneath it: they hold
# whenever Ollama is running, including when something else starts a model.
#
#   OLLAMA_MAX_LOADED_MODELS=1  Never hold two sets of weights at once. On a
#                               24 GB machine a second resident model is not a
#                               slowdown, it is the difference between fitting
#                               and swapping.
#   OLLAMA_KEEP_ALIVE=2m        Ollama's own default is 5 minutes. Five minutes
#                               of holding 9-15 GB after the last token is the
#                               window the lag was living in.
#
# Ollama is launched by launchd here — either the desktop app or, on this
# machine, the Homebrew service — not by your shell, so exporting these in
# .zshrc does nothing for it. launchctl setenv reaches both: a launchd job
# inherits the session environment for every key its own plist does not set,
# and the Homebrew plist sets only OLLAMA_FLASH_ATTENTION and
# OLLAMA_KV_CACHE_TYPE. It also survives `brew services restart`, which
# regenerates that plist from the formula and would discard a hand edit.
set -euo pipefail

MAX_LOADED=${OLLAMA_MAX_LOADED_MODELS:-1}
KEEP_ALIVE=${OLLAMA_KEEP_ALIVE:-2m}

launchctl setenv OLLAMA_MAX_LOADED_MODELS "$MAX_LOADED"
launchctl setenv OLLAMA_KEEP_ALIVE "$KEEP_ALIVE"

print "launchctl: OLLAMA_MAX_LOADED_MODELS=$MAX_LOADED OLLAMA_KEEP_ALIVE=$KEEP_ALIVE"

# launchd hands the environment to a process at spawn, so a daemon that is
# already running kept the old values and has to be restarted. How depends on
# which Ollama this is, so detect rather than guess.
if brew services list 2>/dev/null | grep -qE '^ollama[[:space:]]+started'; then
  print "Restarting the Homebrew ollama service to pick these up..."
  brew services restart ollama
elif pgrep -qx "Ollama"; then
  print "Restarting the Ollama desktop app to pick these up..."
  osascript -e 'quit app "Ollama"' || true
  open -a Ollama
elif pgrep -qf "ollama serve"; then
  print "A shell-started 'ollama serve' is running; these apply when you restart it."
else
  print "Ollama is not running; it will start with these values."
fi

# Report what the daemon actually received rather than what we asked for.
sleep 2
OLLAMA_PID=$(pgrep -f "ollama serve" | head -1)
if [[ -n "$OLLAMA_PID" ]]; then
  print "Environment in pid $OLLAMA_PID:"
  ps eww "$OLLAMA_PID" | tr ' ' '\n' | grep '^OLLAMA' | sed 's/^/  /'
fi
