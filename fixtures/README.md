# Fixtures

Everything the mock side of the system needs, as plain files. The code reads these at run time.

| Path | What it is |
|---|---|
| `documents/<name>.fixture` | The "file" that arrives (stand-in for a photo or PDF). Its bytes are the text `DARB-FIXTURE:<name>`, with no trailing newline. **The SHA-256 of these bytes is what `MockExtractor` looks up.** |
| `extractions/<name>.json` | What the mock OCR returns for that file, in the assignment's `ExtractedDocument` shape (`totalAmount` in halalas, `extractionConfidence` 0..1, `documentDate` ISO 8601). `{"throws": "..."}` makes the extractor fail on purpose. |
| `media-map.json` | The `MediaStore` fixture map: WhatsApp `image.id` (e.g. `media_4471`) to a file under `documents/`. An id that is not in the map is a permanent "media not found". |
| `webhooks/*.json` | Sample webhook bodies. `email-alfanar-invoice.json` and `whatsapp-spec-sample.json` are the assignment's own examples (with real bytes in place of the `<base64>` placeholder). |

Edit a fixture by changing the file; hashes are computed at start-up, so there is nothing else to regenerate.
To add a new fixture, add its two files, a `media-map.json` entry, and its name to `FIXTURE_NAMES` in `lib/extraction/fixtures.ts` (a test fails until the list matches the files on disk).
These are deterministic stand-ins: they are not real images, so the real (Claude) extractor cannot read them.
