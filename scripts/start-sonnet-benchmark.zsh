#!/bin/zsh
set -euo pipefail

if (( $# != 1 )); then
  print -u2 "usage: npm run benchmark:start-sonnet -- /absolute/run/path"
  exit 1
fi
if [[ "$1" != /* || ! -d "$1" ]]; then
  print -u2 "benchmark run path must be an existing absolute directory"
  exit 1
fi

export AGENT_PROFILE="claude-sonnet"
export AGENT_TARGET_DIR="$1"
export AGENT_MAX_REQUESTS="12"
export AGENT_MAX_TOKENS="300000"
export AGENT_MAX_USD="0.20"
export AGENT_MAX_OUTPUT_TOKENS="4096"
export AGENT_DEFAULT_OUTPUT_TOKENS="2048"

exec zsh "${0:A:h}/start-frontier-agent.zsh"
