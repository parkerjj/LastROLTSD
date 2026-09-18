# LastROWeb Upload and Query API

This document is the external contract for an adapter maintained by another project. It does not describe or include client implementation code.

## Upload

`POST /api/v1/market/upload` requires `Authorization: Bearer <source-api-key>`, `Content-Type: application/json`, and `Idempotency-Key: <batch-id>` (the server derives the canonical `snapshot_id/part_index` batch identity). The authenticated API key determines `source_id`; a JSON `source_id` is ignored and never authorizes a request.

The body is limited to 512 KiB and 16 parts per snapshot. Each item carries structured `options` tuples with `type`, `value`, and `param`; the service does not parse or infer options from display names.

```json
{
  "protocol_version": 1,
  "client_run_id": "redacted-run",
  "snapshot_id": "redacted-snapshot",
  "snapshot_mode": "full",
  "part_index": 0,
  "part_count": 1,
  "observed_at": "2026-09-18T12:00:00Z",
  "shops_seen": ["redacted-shop"],
  "shops": [{
    "shop_key": "redacted-shop",
    "vendor_key": "redacted-vendor",
    "vendor_name": "Example Vendor",
    "title": "Example Shop",
    "shop_type": "sell",
    "map_name": "example-map",
    "x": 100,
    "y": 120,
    "items": [{
      "item_key": "slot-0",
      "item_id": 1234,
      "name": "Example Sword",
      "upgrade": 7,
      "slots": 2,
      "cards": [0, 0, 0, 0],
      "price": 100000,
      "quantity": 1,
      "options": [{"type": 1, "value": 5, "param": 0}]
    }]
  }]
}
```

`full` contains all visible source state and may reconcile missing listings only after every part is accepted. The first complete full snapshot establishes a baseline and creates no sold events. After two consecutive complete full snapshots omit an initialized listing, the service marks it `missing` and records a low-confidence sold event with reason `missing_streak`; a session ending expires remaining listings without counting them as sold. `delta` updates only the supplied shops/items; an omitted delta item is not sold. `heartbeat` updates `shops_seen` only. A repeated batch with the same normalized payload returns the original response with `duplicate: true`; reusing an idempotency key with a different payload returns `409`. If a transient server/database failure leaves a batch rejected, the same canonical idempotency key and identical normalized payload may be retried; the service reclaims that batch and returns `503` only when the retry still cannot be completed. Clients should back off and retry `503` responses, preserving the idempotency key.

Successful responses contain `accepted`, `batch_id`, `duplicate`, processed/changed/sold counts, and `next`. Errors use `{ "error": { "code", "message", "request_id" } }` and never echo bearer tokens or complete payloads.

## Search and history

`GET /api/v1/market/search` accepts bounded text, exact item ID, map, shop type, price range, structured option filters, `limit` (maximum 50), allowlisted sort values, and an opaque keyset `cursor`. Query values are bound parameters; offset pagination and arbitrary SQL sort fields are not accepted. Search responses use `Cache-Control: public, max-age=30, s-maxage=30` and return `nextCursor` for the next keyset page.

`GET /api/v1/options` returns the versioned option dictionary with an ETag and 24-hour cache. `GET /api/v1/market/listings/:id/history` returns bounded price/quantity events and a keyset cursor.
