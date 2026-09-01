#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
LAB_DIR=${SCRIPT_DIR:h}

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  read -rs "ANTHROPIC_API_KEY?Claude API key (input hidden): "
  print
  export ANTHROPIC_API_KEY
fi
if [[ -z "${ANTHROPIC_WORKSPACE_ID:-}" ]]; then
  read "ANTHROPIC_WORKSPACE_ID?Anthropic workspace ID: "
  export ANTHROPIC_WORKSPACE_ID
fi

export GATEWAY_ACCESS_TOKEN=$(openssl rand -hex 32)
export GATEWAY_LANES_FILE="$LAB_DIR/gateway/lanes.controlled-claude-opus.json"
export GATEWAY_PINNED_ALIAS="anthropic-opus-escalation"
export GATEWAY_MAX_REQUESTS_PER_RUN="1"
export GATEWAY_MAX_TOKENS_PER_RUN="3000"
export GATEWAY_MAX_USD_PER_RUN="0.005"
export GATEWAY_MAX_OUTPUT_TOKENS="128"
export GATEWAY_DEFAULT_OUTPUT_TOKENS="128"
export GATEWAY_UPSTREAM_TIMEOUT_MS="120000"

GATEWAY_LOG=$(mktemp -t opencode-claude-opus-diagnostic.XXXXXX)
GATEWAY_PID=""
cleanup() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  rm -f "$GATEWAY_LOG"
  unset ANTHROPIC_API_KEY ANTHROPIC_WORKSPACE_ID
}
trap cleanup EXIT INT TERM

cd "$LAB_DIR"
node gateway/start-gateway.js >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!
for _ in {1..50}; do
  if curl --fail --silent http://127.0.0.1:8787/health >/dev/null 2>&1; then
    {
      print -r -- "Authorization: Bearer $GATEWAY_ACCESS_TOKEN"
      print -r -- "Content-Type: application/json"
    } | curl --silent --show-error \
      -H @- \
      -d '{"model":"frontier-code","messages":[{"role":"user","content":"Reply exactly: CLAUDE OPUS 5 READY"}],"max_tokens":128,"stream":false}' \
      -w '\nHTTP_STATUS=%{http_code}\n' \
      http://127.0.0.1:8787/v1/chat/completions
    print
    exit 0
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
