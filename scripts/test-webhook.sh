#!/usr/bin/env bash

# Test the Telegram bot HTTP Webhook
# Usage: ./scripts/test-webhook.sh [PORT] [AUTH_TOKEN]

PORT=${1:-3000}
TOKEN=${2:-}

echo "Testing Webhook on port $PORT..."

curl_args=()
if [ -n "$TOKEN" ]; then
  curl_args+=("-H" "Authorization: Bearer $TOKEN")
fi

curl -X POST http://localhost:$PORT/api/messages \
  -H "Content-Type: application/json" \
  "${curl_args[@]}" \
  -d '{
    "text": "Hello from external webhook test script!"
  }'

echo -e "\nDone."
