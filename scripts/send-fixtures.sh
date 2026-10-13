#!/usr/bin/env bash
# Sends every mock-extractor fixture through the real webhooks of a running dev server, then prints what happened.
#   npm run db:seed && npm run dev      (terminal 1)
#   ./scripts/send-fixtures.sh          (terminal 2)
# Secrets default to the ones in .env.example-style dev values; if the server has none set, signatures are skipped.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
EMAIL_SECRET="${EMAIL_WEBHOOK_SECRET:-}"
WA_SECRET="${WHATSAPP_APP_SECRET:-}"
TX_SECRET="${TRANSACTIONS_WEBHOOK_SECRET:-}"

sign() { # sign <secret> <body>  -> "sha256=<hex>" (HMAC-SHA256 over the exact bytes sent)
  printf 'sha256=%s' "$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" -hex | sed 's/^.* //')"
}

post() { # post <path> <header-name> <secret> <body>
  local path="$1" header="$2" secret="$3" body="$4" args=(-sS -o /dev/stderr -w '%{http_code}' -H 'content-type: application/json')
  [[ -n "$secret" ]] && args+=(-H "$header: $(sign "$secret" "$body")")
  curl "${args[@]}" -X POST --data-binary "$body" "$BASE_URL$path" 2>&1 >/dev/null || true
}

send_email() { # send_email <message-id> <from> <fixture...>
  local id="$1" from="$2"; shift 2
  local atts="" sep=""
  for f in "$@"; do
    atts+="$sep{\"filename\":\"$f.jpg\",\"contentType\":\"image/jpeg\",\"contentBase64\":\"$(printf 'DARB-FIXTURE:%s' "$f" | base64)\"}"
    sep=","
  done
  local body="{\"messageId\":\"$id\",\"from\":\"$from\",\"to\":[\"receipts@darb.sa\"],\"subject\":\"invoice\",\"attachments\":[$atts]}"
  printf '%-34s -> ' "email $id ($*)"; post /api/webhooks/email x-signature-256 "$EMAIL_SECRET" "$body"; echo
}

send_whatsapp() { # send_whatsapp <wamid> <digits-phone> <fixture>
  local body="{\"object\":\"whatsapp_business_account\",\"entry\":[{\"id\":\"W\",\"changes\":[{\"field\":\"messages\",\"value\":{\"messaging_product\":\"whatsapp\",\"metadata\":{\"phone_number_id\":\"1\"},\"messages\":[{\"id\":\"$1\",\"from\":\"$2\",\"timestamp\":\"1760000000\",\"type\":\"image\",\"image\":{\"id\":\"fixture:$3\",\"mime_type\":\"image/jpeg\"}}]}}]}]}"
  printf '%-34s -> ' "whatsapp $1 ($3)"; post /api/webhooks/whatsapp x-hub-signature-256 "$WA_SECRET" "$body"; echo
}

RUN="${RUN_ID:-$(date +%s)}" # unique message ids so the script can be re-run (content dedupe still applies per sender)

echo "== WhatsApp drivers (Al Noor: +966501111111, +966502222222; Desert Fleet: +966503333333)"
send_whatsapp "wamid.$RUN.exact"          966501111111 exact
send_whatsapp "wamid.$RUN.ambiguous"      966501111111 ambiguous
send_whatsapp "wamid.$RUN.ambiguous_last4" 966501111111 ambiguous_last4
send_whatsapp "wamid.$RUN.prevat"         966501111111 prevat
send_whatsapp "wamid.$RUN.no_transaction" 966501111111 no_transaction
send_whatsapp "wamid.$RUN.already"        966501111111 already_confirmed
send_whatsapp "wamid.$RUN.garbage"        966501111111 garbage
send_whatsapp "wamid.$RUN.tip"            966502222222 tip
send_whatsapp "wamid.$RUN.rounding"       966502222222 rounding
send_whatsapp "wamid.$RUN.lowconf"        966502222222 low_confidence
send_whatsapp "wamid.$RUN.arabic"         966503333333 arabic
send_whatsapp "wamid.$RUN.failure"        966501111111 forced_failure

echo "== Email"
send_email "<$RUN.1@alnoor>"  ap@alnoor.example exact                       # same receipt as the WhatsApp 'exact', now by email: its transaction is already confirmed, so it lands UNMATCHED (known cross-channel limitation)
send_email "<$RUN.2@desert>"  accounts@desertfleet.example email_exact
send_email "<$RUN.3@desert>"  accounts@desertfleet.example email_exact       # new message id, same bytes => duplicate
send_email "<$RUN.4@alnoor>"  ap@alnoor.example rounding tip                 # multi-attachment
send_email "<$RUN.5@evil>"    stranger@evil.example exact                    # unknown sender => ignored

echo "== Idempotency: redeliver the first WhatsApp message (expect 200, no new document)"
send_whatsapp "wamid.$RUN.exact" 966501111111 exact

echo "== Late transaction: the 'no_transaction' receipt (Saudi Electricity, 999.99 SAR) is UNMATCHED. Deliver its card transaction:"
TX="[{\"externalRef\":\"feed-$RUN\",\"clientId\":\"client_alnoor\",\"driverPhone\":\"+966501111111\",\"merchantName\":\"SAUDI ELECTRICITY CO\",\"amountMinor\":99999,\"currency\":\"SAR\",\"occurredAt\":\"2026-10-02T10:00:00+03:00\"}]"
printf '%-34s -> ' "transactions feed"; post /api/webhooks/transactions x-signature-256 "$TX_SECRET" "$TX"; echo

echo "== Forged signature (expect 401)"
printf '%-34s -> ' "whatsapp wrong secret"
body='{"object":"whatsapp_business_account","entry":[]}'
curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-hub-signature-256: sha256=$(printf 'f%.0s' {1..64})" --data-binary "$body" "$BASE_URL/api/webhooks/whatsapp"; echo

sleep 2 # processing runs after the response
echo; echo "== Results"
npx tsx scripts/report.ts
