#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
LAB_DIR=${SCRIPT_DIR:h}

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  read -rs "GEMINI_API_KEY?Gemini API key (input hidden): "
  print
  export GEMINI_API_KEY
fi
if (( ${#GEMINI_API_KEY} < 8 )); then
  print -u2 "Gemini API key is unavailable"
  exit 1
fi

export GATEWAY_ACCESS_TOKEN=$(openssl rand -hex 32)
export GATEWAY_LANES_FILE="$LAB_DIR/gateway/lanes.controlled-gemini.json"
export GATEWAY_PINNED_ALIAS="gemini-main"
export GATEWAY_MAX_REQUESTS_PER_RUN="1"
export GATEWAY_MAX_TOKENS_PER_RUN="3000"
export GATEWAY_MAX_USD_PER_RUN="0.01"
export GATEWAY_MAX_OUTPUT_TOKENS="64"
export GATEWAY_DEFAULT_OUTPUT_TOKENS="64"
export GATEWAY_UPSTREAM_TIMEOUT_MS="120000"

GATEWAY_LOG=$(mktemp -t opencode-agent-diagnostic.XXXXXX)
GATEWAY_PID=""
cleanup() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  rm -f "$GATEWAY_LOG"
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
      -d '{"model":"frontier-code","messages":[{"role":"user","content":"Reply exactly: GEMINI DIAGNOSTIC READY"}],"max_tokens":64}' \
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
