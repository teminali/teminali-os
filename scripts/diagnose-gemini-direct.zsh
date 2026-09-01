#!/bin/zsh
set -euo pipefail

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  read -rs "GEMINI_API_KEY?Gemini API key (input hidden): "
  print
  export GEMINI_API_KEY
fi
if (( ${#GEMINI_API_KEY} < 8 )); then
  print -u2 "Gemini API key is unavailable"
  exit 1
fi

{
  print -r -- "Authorization: Bearer $GEMINI_API_KEY"
  print -r -- "Content-Type: application/json"
} | curl --silent --show-error --max-time 120 \
  -H @- \
  -d '{"model":"gemini-3.7-flash","messages":[{"role":"user","content":"Reply exactly: GEMINI DIRECT READY"}],"max_tokens":64,"stream":false}' \
  -w '\nHTTP_STATUS=%{http_code}\n' \
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

unset GEMINI_API_KEY
