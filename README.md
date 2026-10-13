# Darb Portal: receipt and invoice matching

Documents arrive by email and WhatsApp webhooks, are OCR'd (mocked by default), and are matched to card
transactions with a confidence score. High-confidence matches are attached automatically. Ambiguous ones go to a
review page. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for how and why it works, including the scoring design,
thresholds, assumptions, trade-offs and threat model.

Stack: Next.js 15 (App Router), TypeScript (strict), Prisma 7 + SQLite, Zod, next-safe-action, Tailwind + shadcn/ui, Jest.

## Quick start

Requires Node 20.19+ (Prisma 7); developed on Node 22.

```bash
npm install                  # also runs `prisma generate`
cp .env.example .env
npm run db:deploy            # apply migrations to ./dev.db
npm run db:seed              # demo clients, drivers and transactions
npm run dev                  # http://localhost:3000  (redirects to /review)
```

### Try it end to end

With the dev server running, in a second terminal:

```bash
./scripts/send-fixtures.sh   # sends every fixture through the real webhooks, then prints the outcome of each
```

Or use [webhooks.http](webhooks.http) (VS Code REST Client / JetBrains). Then open <http://localhost:3000/review>
to confirm or reject the candidates the matcher was not sure about.

To exercise HMAC signing, set the secrets for both the server and the script:

```bash
export EMAIL_WEBHOOK_SECRET=e WHATSAPP_APP_SECRET=w TRANSACTIONS_WEBHOOK_SECRET=t WHATSAPP_VERIFY_TOKEN=v
npm run dev                      # terminal 1 (inherits the variables)
./scripts/send-fixtures.sh       # terminal 2, signs every request with the same secrets
```

The script is safe to re-run (message ids are unique per run). To start from a clean slate run `npm run db:seed` again;
it wipes and re-creates the demo data.

## Tests and checks

```bash
npm test             # 575 tests, ~1 s. Matcher and helpers need no DB; ingestion/handler/action tests use a real SQLite file per test file
npm run typecheck
npm run lint
npm run build
```

## Endpoints

| Endpoint | Purpose | Signature header (HMAC-SHA256 of the raw body) |
|---|---|---|
| `POST /api/webhooks/email` | Provider-neutral JSON: `messageId`, `from`, `to`, `attachments[]` (base64) | `x-signature-256: sha256=<hex>` |
| `GET /api/webhooks/whatsapp` | Meta subscription handshake (`hub.challenge`) | n/a (verify token) |
| `POST /api/webhooks/whatsapp` | Meta Cloud API envelope, image and document messages | `x-hub-signature-256: sha256=<hex>` |
| `POST /api/webhooks/transactions` | Card transaction feed. New transactions trigger re-matching of unmatched documents | `x-signature-256: sha256=<hex>` |
| `/review` | Review page: ranked candidates, confirm / reject | none (see limitations) |

Responses: `200` accepted/ignored/duplicate, `400` invalid payload (field paths only), `401` bad signature,
`413` body too large, `503` + `Retry-After` when the provider should retry. Request-handling errors are mapped to 4xx/503. The one remaining `500` path is a misconfigured environment (e.g. production without its secrets), which deliberately refuses to serve.

## Configuration

See [.env.example](.env.example). Everything is validated lazily by `lib/env.ts`.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | SQLite file, relative to the project root |
| `EMAIL_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET`, `TRANSACTIONS_WEBHOOK_SECRET`, `WHATSAPP_VERIFY_TOKEN` | **Required when `NODE_ENV=production`** (fail closed: the app errors on first use rather than serving unauthenticated). Outside production a missing secret skips that check and logs a warning |
| `WHATSAPP_ACCESS_TOKEN` | Used to download media from Meta. Without it, development uses a fixture-backed fetcher (media id `fixture:<name>`). **In production a missing token makes WhatsApp media fetches fail with 503** |
| `EXTRACTOR` | `mock` (default) or `claude`. `claude` requires `ANTHROPIC_API_KEY` and **fails on first use without it** instead of falling back to the mock |
| `BLOB_DIR`, `MAX_BODY_BYTES` | Where document bytes are stored (content-addressed) and the request size cap (default 10 MB) |

## Seed data and fixtures

`npm run db:seed` creates two clients, three drivers and ten transactions. The mock extractor recognises 13 fixture
files by SHA-256 (`npx tsx scripts/print-fixtures.ts` lists them). Each fixture exercises a matcher edge case: exact
match, two identical transactions (ambiguous), the same pair disambiguated by card last4, tip, rounding, pre-VAT total,
no matching transaction, garbage extraction, low OCR confidence, an Arabic merchant, an already-confirmed
transaction, and a forced extractor failure.

## Layout

```
app/api/webhooks/*       thin route files (wiring only)
app/review/              review page and client components
lib/webhooks/            HMAC, Zod schemas, body reader, handlers (testable without Next)
lib/services/            ingestion, match pipeline, matcher (pure), re-match, blob store, media fetcher
lib/matching/            normalization, similarity, per-signal scoring (pure)
lib/extraction/          DocumentExtractor interface, MockExtractor, fixtures, ClaudeExtractor
lib/actions/             review confirm/reject (core logic + next-safe-action wrappers)
prisma/                  schema, migration (with the partial unique index), seed
tests/                   matcher, helpers, ingestion, handlers, actions, db constraints
```

## Notes

- `ClaudeExtractor` is covered by unit tests with a stubbed client only. It has **not** been run against the real API.
- The review actions and `/review` page have no authentication. They are intended to sit behind the portal's existing auth.
- Dependency notes (Prisma pinned to stable 7.10.0, Next 15 audit advisory, `better-sqlite3` version alignment) are in IMPLEMENTATION.md.
