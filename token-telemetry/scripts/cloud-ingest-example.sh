#!/usr/bin/env bash
# Example: log one cloud/SDK run into the same CSV as IDE hooks.
# Usage: ./cloud-ingest-example.sh < run-result.json
#
# run-result.json shape:
# {
#   "run_id": "…",
#   "agent_id": "bc-…",
#   "model": "composer-2",
#   "conversation": "☁ my agent",
#   "usage": {
#     "inputTokens": 1000,
#     "outputTokens": 200,
#     "cacheReadTokens": 0,
#     "cacheWriteTokens": 0
#   }
# }

set -euo pipefail
HOOK="${HOME}/.cursor/hooks/token_count_hook.py"
if [[ ! -f "$HOOK" ]]; then
  echo "Install Token Telemetry hooks first (token_count_hook.py missing)." >&2
  exit 1
fi
for py in python3.12 python3.11 python3; do
  if command -v "$py" >/dev/null 2>&1; then
    exec "$py" "$HOOK" --ingest
  fi
done
echo "python3 not found" >&2
exit 1
