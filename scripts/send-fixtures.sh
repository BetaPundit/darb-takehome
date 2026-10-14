#!/usr/bin/env bash
# Sends every mock-extractor fixture through the real webhooks of a running dev server, then prints what happened.
# WhatsApp media ids and email attachment bytes come from fixtures/ (media-map.json, documents/*.fixture).
#   npm run db:seed && npm run dev      (terminal 1)
#   ./scripts/send-fixtures.sh          (terminal 2)
# Secrets default to the ones in .env.example-style dev values; if the server has none set, signatures are skipped.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
FIXTURES_DIR="$(cd "$(dirname "$0")/../fixtures" && pwd)"
EMAIL_SECRET="${EMAIL_WEBHOOK_SECRET:-}"
WA_SECRET="${WHATSAPP_APP_SECRET:-}"
TX_SECRET="${TRANSACTIONS_WEBHOOK_SECRET:-}"

sign() { # sign <secret> <body>  -> "sha256=<hex>" (HMAC-SHA256 over the exact bytes sent)
  printf 'sha256=%s' "$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" -hex | sed 's/^.* //')"
}

media_id() { # media_id <fixture> -> the WhatsApp media id fixtures/media-map.json gives documents/<fixture>.fixture
  node -e 'const m = require(process.argv[1]); const id = Object.keys(m).find((k) => m[k] === `documents/${process.argv[2]}.fixture`);
    if (!id) { console.error(`no media id for fixture ${process.argv[2]} in media-map.json`); process.exit(1); } console.log(id);' "$FIXTURES_DIR/media-map.json" "$1"
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
    atts+="$sep{\"filename\":\"$f.jpg\",\"contentType\":\"image/jpeg\",\"contentBase64\":\"$(base64 < "$FIXTURES_DIR/documents/$f.fixture" | tr -d '\n')\"}"
    sep=","
  done
  local body="{\"messageId\":\"$id\",\"from\":\"$from\",\"to\":[\"receipts@darb.sa\"],\"subject\":\"invoice\",\"attachments\":[$atts]}"
  printf '%-34s -> ' "email $id ($*)"; post /api/webhooks/email x-signature-256 "$EMAIL_SECRET" "$body"; echo
}

send_whatsapp() { # send_whatsapp <wamid> <digits-phone> <fixture>
  local media; media="$(media_id "$3")"
  local body="{\"object\":\"whatsapp_business_account\",\"entry\":[{\"id\":\"W\",\"changes\":[{\"field\":\"messages\",\"value\":{\"messaging_product\":\"whatsapp\",\"metadata\":{\"phone_number_id\":\"1\"},\"messages\":[{\"id\":\"$1\",\"from\":\"$2\",\"timestamp\":\"1760000000\",\"type\":\"image\",\"image\":{\"id\":\"$media\",\"mime_type\":\"image/jpeg\"}}]}}]}]}"
  printf '%-34s -> ' "whatsapp $1 ($3)"; post /api/webhooks/whatsapp x-hub-signature-256 "$WA_SECRET" "$body"; echo
}

send_sample() { # send_sample <file in fixtures/webhooks> <path> <header-name> <secret> <message id in the file> <new message id> <label>
  # The assignment's own sample bodies, unchanged except that the provider message id is made unique per run.
  local body; body="$(sed "s/$5/$6/" "$FIXTURES_DIR/webhooks/$1")"
  printf '%-34s -> ' "$7"; post "$2" "$3" "$4" "$body"; echo
}

RUN="${RUN_ID:-$(date +%s)}" # unique message ids so the script can be re-run (content dedupe still applies per sender)

echo "== WhatsApp drivers (Al Noor: +966501111111, +966502222222; Desert Fleet: +966503333333)"
send_whatsapp "wamid.$RUN.exact"          966501111111 exact
send_whatsapp "wamid.$RUN.ambiguous"      966501111111 ambiguous
send_whatsapp "wamid.$RUN.ambiguous_last4" 966501111111 ambiguous_last4
send_whatsapp "wamid.$RUN.prevat"         966501111111 prevat
send_whatsapp "wamid.$RUN.no_transaction" 966501111111 no_transaction
send_whatsapp "wamid.$RUN.already"        966501111111 already_confirmed  # its transaction already has a confirmed document => NEEDS_REVIEW (possible duplicate)
send_whatsapp "wamid.$RUN.garbage"        966501111111 garbage
send_whatsapp "wamid.$RUN.tip"            966502222222 tip
send_whatsapp "wamid.$RUN.restaurant_tip" 966502222222 restaurant_tip   # 57.50 receipt vs 63.25 charge => NEEDS_REVIEW (tip)
send_whatsapp "wamid.$RUN.rounding"       966502222222 rounding
send_whatsapp "wamid.$RUN.lowconf"        966502222222 low_confidence
send_whatsapp "wamid.$RUN.arabic"         966503333333 arabic
send_whatsapp "wamid.$RUN.failure"        966501111111 forced_failure

echo "== Email"
send_email "<$RUN.1@alnoor>"  ap@alnoor.example exact                       # same receipt as the WhatsApp 'exact', now by email: its transaction is already confirmed => NEEDS_REVIEW (possible duplicate)
send_email "<$RUN.2@desert>"  accounts@desertfleet.example email_exact
send_email "<$RUN.3@desert>"  accounts@desertfleet.example email_exact       # new message id, same bytes => duplicate
send_email "<$RUN.4@alnoor>"  ap@alnoor.example rounding tip                 # multi-attachment
send_email "<$RUN.5@evil>"    stranger@evil.example exact                    # unknown sender => ignored

echo "== The assignment's sample payloads (fixtures/webhooks): its email (string 'to', from billing@alfanar-fuel.com.sa) and its WhatsApp body (no object or metadata)"
send_sample email-alfanar-invoice.json /api/webhooks/email x-signature-256 "$EMAIL_SECRET" msg_8f2a1 "msg_$RUN" "email msg_$RUN (alfanar_invoice)"   # AUTO-matched to txn_alfanar
send_sample whatsapp-spec-sample.json /api/webhooks/whatsapp x-hub-signature-256 "$WA_SECRET" 'wamid.HBgMOTY2NT...' "wamid.HBgMOTY2NT.$RUN" "whatsapp 966551234567 (spec sample)" # unknown driver => UNMATCHED

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
echo "Open $BASE_URL/review to confirm or reject what needs review."

