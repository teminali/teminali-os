#!/bin/zsh
set -euo pipefail

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  read -rs "ANTHROPIC_API_KEY?Claude API key (input hidden): "
  print
  export ANTHROPIC_API_KEY
fi
if [[ -z "${ANTHROPIC_WORKSPACE_ID:-}" ]]; then
  read "ANTHROPIC_WORKSPACE_ID?Anthropic workspace ID: "
  export ANTHROPIC_WORKSPACE_ID
fi

{
  print -r -- "Authorization: Bearer $ANTHROPIC_API_KEY"
  print -r -- "anthropic-workspace-id: $ANTHROPIC_WORKSPACE_ID"
  print -r -- "Content-Type: application/json"
} | curl --silent --show-error --max-time 120 \
  -H @- \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"Reply exactly: CLAUDE SONNET DIRECT READY"}],"max_tokens":64,"stream":false,"output_config":{"effort":"low"}}' \
  -w '\nHTTP_STATUS=%{http_code}\n' \
  "https://api.anthropic.com/v1/chat/completions"

unset ANTHROPIC_API_KEY ANTHROPIC_WORKSPACE_ID
