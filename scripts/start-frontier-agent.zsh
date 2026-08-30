#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
LAB_DIR=${SCRIPT_DIR:h}
OPENCODE_BIN=${OPENCODE_BIN:-$(command -v opencode || true)}
if [[ -z "$OPENCODE_BIN" && -x "${HOME}/.opencode/bin/opencode" ]]; then
  OPENCODE_BIN="${HOME}/.opencode/bin/opencode"
fi
AGENT_PROFILE=${AGENT_PROFILE:-claude-sonnet}
AGENT_TARGET_DIR=${AGENT_TARGET_DIR:-$LAB_DIR}

if [[ -z "$OPENCODE_BIN" ]]; then
  print -u2 "opencode executable was not found"
  exit 1
fi
if [[ ! -d "$AGENT_TARGET_DIR" ]]; then
  print -u2 "agent target directory does not exist"
  exit 1
fi

read_anthropic_credentials() {
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    read -rs "ANTHROPIC_API_KEY?Claude API key (input hidden): "
    print
    export ANTHROPIC_API_KEY
  fi
  if (( ${#ANTHROPIC_API_KEY} < 8 )); then
    print -u2 "Claude API key is unavailable"
    exit 1
  fi
  if [[ -z "${ANTHROPIC_WORKSPACE_ID:-}" ]]; then
    read "ANTHROPIC_WORKSPACE_ID?Anthropic workspace ID: "
    export ANTHROPIC_WORKSPACE_ID
  fi
  if [[ ! "$ANTHROPIC_WORKSPACE_ID" =~ '^wrkspc_[A-Za-z0-9]+$' ]]; then
    print -u2 "Anthropic workspace ID is invalid"
    exit 1
  fi
}

read_groq_credentials() {
  local name
  for name in GROQ_API_KEY_A GROQ_API_KEY_B GROQ_API_KEY_C; do
    if [[ -z "${(P)name:-}" ]]; then
      read -rs "$name?$name (input hidden): "
      print
      export $name
    fi
    if (( ${#${(P)name}} < 8 )); then
      print -u2 "$name is unavailable"
      exit 1
    fi
  done
}

read_anthropic_credentials
case "$AGENT_PROFILE" in
  claude-sonnet)
    export GATEWAY_LANES_FILE="$LAB_DIR/gateway/lanes.controlled-claude-sonnet.json"
    export GATEWAY_PINNED_ALIAS="anthropic-sonnet-primary"
    export OPENCODE_CONFIG="$LAB_DIR/opencode.claude-gateway.jsonc"
    PROFILE_LABEL="Claude Sonnet 5 controlled"
    ;;
  claude-opus)
    export GATEWAY_LANES_FILE="$LAB_DIR/gateway/lanes.controlled-claude-opus.json"
    export GATEWAY_PINNED_ALIAS="anthropic-opus-escalation"
    export OPENCODE_CONFIG="$LAB_DIR/opencode.claude-opus.jsonc"
    PROFILE_LABEL="Claude Opus 5 escalation"
    ;;
  claude-groq-enhanced)
    read_groq_credentials
    export GATEWAY_LANES_FILE="$LAB_DIR/gateway/lanes.enhanced-claude-groq.example.json"
    unset GATEWAY_PINNED_ALIAS || true
    export OPENCODE_CONFIG="$LAB_DIR/opencode.claude-enhanced.jsonc"
    PROFILE_LABEL="Claude Sonnet 5 plus three Groq recovery lanes"
    ;;
  *)
    print -u2 "unknown agent profile: $AGENT_PROFILE"
    exit 1
    ;;
esac

export GATEWAY_ACCESS_TOKEN=$(openssl rand -hex 32)
export GATEWAY_MAX_REQUESTS_PER_RUN=${AGENT_MAX_REQUESTS:-12}
export GATEWAY_MAX_TOKENS_PER_RUN=${AGENT_MAX_TOKENS:-300000}
export GATEWAY_MAX_USD_PER_RUN=${AGENT_MAX_USD:-0.20}
export GATEWAY_MAX_OUTPUT_TOKENS=${AGENT_MAX_OUTPUT_TOKENS:-4096}
export GATEWAY_DEFAULT_OUTPUT_TOKENS=${AGENT_DEFAULT_OUTPUT_TOKENS:-2048}
export GATEWAY_UPSTREAM_TIMEOUT_MS=${AGENT_UPSTREAM_TIMEOUT_MS:-180000}

GATEWAY_LOG=$(mktemp -t opencode-agent-gateway.XXXXXX)
GATEWAY_PID=""
cleanup() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  rm -f "$GATEWAY_LOG"
  unset ANTHROPIC_API_KEY ANTHROPIC_WORKSPACE_ID
  unset GROQ_API_KEY_A GROQ_API_KEY_B GROQ_API_KEY_C
}
trap cleanup EXIT INT TERM

cd "$LAB_DIR"
node gateway/start-gateway.js >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

for _ in {1..50}; do
  if curl --fail --silent http://127.0.0.1:8787/health >/dev/null 2>&1; then
    print "Frontier gateway ready: $PROFILE_LABEL"
    print "Hard run limits: $GATEWAY_MAX_REQUESTS_PER_RUN requests, $GATEWAY_MAX_TOKENS_PER_RUN estimated tokens, USD $GATEWAY_MAX_USD_PER_RUN"
    "$OPENCODE_BIN" "$AGENT_TARGET_DIR"
    exit $?
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    print -u2 "Gateway failed to start:"
    sed -n '1,80p' "$GATEWAY_LOG" >&2
    exit 1
  fi
  sleep 0.1
done

print -u2 "Gateway health check timed out"
exit 1
