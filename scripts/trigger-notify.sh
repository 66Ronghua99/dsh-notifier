#!/usr/bin/env bash
# Post one DSH Notifier banner right now and print the plugin's answer.
#
#   ./scripts/trigger-notify.sh                 # banner without a target session
#   ./scripts/trigger-notify.sh session-abc123  # banner whose click jumps to that session
#
# Look at the screen immediately after running it: a banner stays for about
# five seconds, after which it waits in Notification Center.
set -euo pipefail

port="${DSH_WEB_PORT:-58208}"
session="${1:-}"
body="$(
  printf '{"sessionId":"%s","title":"DSH 提醒 · 点我","body":"点击应唤起 DSH 并回到对应会话"}' "$session"
)"
curl -s -m 5 -X POST "http://127.0.0.1:${port}/dsh-notifier/test" \
  -H 'content-type: application/json' -d "$body"
echo
curl -s -m 5 "http://127.0.0.1:${port}/dsh-notifier/status" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("lastDelivery:", json.dumps(d.get("lastDelivery"), ensure_ascii=False)); print("lastOpened:  ", json.dumps(d.get("lastOpened"), ensure_ascii=False))' \
  2>/dev/null || true
