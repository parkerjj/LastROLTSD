# LastROWeb Upload and Query API

This document is the external contract for the OpenKore market adapter. The upload endpoint accepts only the approved protocol v2 contract. The server does not implement or accept an earlier upload protocol.

## Upload

`POST /api/v1/market/upload` requires `Authorization: Bearer <source-api-key>`, `Content-Type: application/json`, and `Idempotency-Key: <snapshot_id/part_index>`. The authenticated API key determines `source_id`; a JSON `source_id` is never trusted. The body is limited to 512 KiB and each snapshot has at most 16 parts.

```json
{
  "protocol_version": 2,
  "client_run_id": "redacted-run",
  "snapshot_id": "redacted-snapshot",
  "snapshot_mode": "full",
  "part_index": 0,
  "part_count": 1,
  "observed_at": "2026-09-19T12:00:00Z",
  "shops": [{
    "shop_id": "shop_v1_optional-client-cache",
    "uuid": "5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1",
    "shop_status": "opening",
    "vendor_account_id": "redacted-account",
    "vendor_name": "Synthetic Vendor",
    "title": "Synthetic Shop",
    "shop_type": "sell",
    "map_name": "example-map",
    "x": 100,
    "y": 120,
    "items": [{
      "item_key": "item-v1:redacted-slot-0",
      "item_id": 1234,
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

An item contains only live observation data: `item_id`, optional `item_key`, price, quantity, upgrade, slots, card IDs, and raw option tuples. It does not contain an authoritative name, description, alias, or option display text. Unknown item IDs and option types are accepted.

Each shop has a required per-transfer `uuid`, `shop_status` (`opening` or `dismissed`), stable `vendor_account_id`, vendor/shop observation fields, and an `items` array. `shop_id` is optional client cache input and is never identity authority. The server computes a source-scoped canonical identity and returns the canonical `shop_id`.

`dismissed` must contain `items: []`. It atomically closes the current shop session, expires active and missing listings, and writes no sold event. A stale `opening` cannot reopen a newer dismissal; a newer opening creates a new session. Missing shops, incomplete uploads, stop events, and delta omissions are not dismissal.

`full` contains the complete visible state for the shops included in the snapshot and reconciles missing listings only after every part is accepted. The first complete full snapshot establishes a baseline and creates no sold events. After two consecutive complete full snapshots omit an initialized listing, it becomes `missing` and may produce a low-confidence `missing_streak` event. `delta` updates only the supplied shops/items; an omitted delta item is not sold. `heartbeat` uses lightweight opening shop objects and updates liveness without changing the listing collection.

The canonical idempotency key is `snapshot_id/part_index`. A repeated batch with the same normalized v2 payload returns the stored response with `duplicate: true`; reusing the key with a different payload returns `409`. Retry uses the same payload bytes, UUIDs, observed time, and idempotency key. Errors use `{ "error": { "code", "message", "request_id" } }` and never echo bearer tokens or complete payloads.

Successful responses use snake_case and contain `accepted`, `batch_id`, `duplicate`, `processed_shops`, `processed_listings`, `changed_listings`, `sold_events`, ordered `shops` results, and `next`:

```json
{
  "accepted": true,
  "batch_id": "redacted-snapshot/0",
  "duplicate": false,
  "processed_shops": 1,
  "processed_listings": 1,
  "changed_listings": 0,
  "sold_events": 0,
  "shops": [{
    "uuid": "5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1",
    "shop_id": "shop_v1_redacted",
    "shop_status": "opening",
    "applied": true,
    "resolution": "created"
  }],
  "next": null
}
```

## Search and history

`GET /api/v1/market/search` accepts bounded text, exact item ID, map, shop type, price range, structured raw option filters, `limit` (maximum 50), allowlisted sort values, and an opaque keyset `cursor`. Query values are bound parameters; offset pagination and arbitrary SQL sort fields are not accepted. Search responses use `Cache-Control: public, max-age=30, s-maxage=30` and return `nextCursor` for the next keyset page.

Text is normalized with Unicode NFKC, leading/trailing whitespace removal, internal whitespace folding, and lowercase conversion. Empty normalized text disables the text filter. `q` is limited to 80 Unicode code points. One- and two-code-point queries use exact derived `search_short_tokens`; queries of three or more code points use FTS5 trigram indexes. The item index contains server catalog names, approved aliases, and searchable descriptions; the shop index contains the current shop title and vendor name. Search never reads uploaded listing names and does not materialize matching item IDs in TypeScript. The current listing, open session, and non-closed shop state determine whether a listing is returned; `include_stale=true` still excludes closed shops and ended sessions.

Example catalog/alias/shop search:

```http
GET /api/v1/market/search?q=%E6%B3%A2%E5%88%A9&sort=price_asc&limit=20
```

The repeated structured option syntax is:

```text
option=<option_type>:<operator>:<decimal_value>[:<param>]
option_mode=all|any
```

For example, `GET /api/v1/market/search?option=12:gte:50` finds listings whose definition-controlled `SP恢复速度增加` raw option is at least 50%. Operator names are `eq`, `neq`, `gt`, `gte`, `lt`, and `lte`; the equivalent symbols `=`, `!=`, `>`, `>=`, `<`, and `<=` are also accepted. Every requested operator must be present in that option definition's `allowed_operators`. Operators are mapped through a server allowlist and are never inserted from the request into SQL.

`option_mode=all` requires all conditions and `option_mode=any` requires at least one. Repeated conditions for one type follow its server `repeat_policy`: `same` requires one option occurrence to satisfy all same-type conditions, while `distinct` requires different occurrences. Decimal values for `scaled_integer` definitions are converted exactly using the definition scale; exponent notation and excess precision are rejected. A param is accepted only when the definition's `param_policy` permits it, and `required_exact` requires it.

The legacy exact raw tuple query remains available through 2026-10-31 only when all three parameters are supplied together: `option_type=12&option_value=50&option_param=0`. It has exact equality semantics. Mixing legacy parameters with `option=` returns `400`; incomplete legacy tuples return `400`. New integrations must use structured `option=`. Unknown option types remain stored and displayed, but structured queries for an unknown type return the standard `bad_request` error envelope.

Search cursors are HMAC-signed and bind the normalized q and q mode, catalog/option/search-index versions, every scalar filter, normalized option conditions and mode, sort, last sort value, and last listing ID. Reusing a cursor with a different q, option condition, definition/catalog version, or sort returns `400`.

`GET /api/v1/options` returns stable type-level metadata, an ETag, and `Cache-Control: public, max-age=86400`. It does not enumerate every exact value/param tuple:

```json
{
  "version": "options-lastro-70.83",
  "options": [{
    "type": 12,
    "handle": "VAR_SPACCELERATION",
    "label_zh": "SP恢复速度增加数值%",
    "description_template": "SP恢复速度增加{value}%",
    "value_kind": "integer",
    "unit": "",
    "scale": 1,
    "allowed_operators": ["eq", "neq", "gt", "gte", "lt", "lte"],
    "param_policy": {"mode": "ignored", "filterable": false},
    "repeat_policy": "same",
    "display_template": "SP恢复速度增加{value}%",
    "search_tokens": ["VAR_SPACCELERATION", "SP恢复速度增加数值%"]
  }]
}
```

Listing responses preserve `type`, `value`, and `param` and add server-generated `display`. Known displays come from the current definition template and raw tuple. Unknown options use `未知词条 type=<type> value=<value> param=<param>`; client-supplied display text is never trusted.

The search implementation performs one versioned definition lookup, one bounded listing query, and at most one JSON1 option-hydration query. A request has at most eight structured option conditions and 50 results; generated SQL is checked against 100 KiB and bound values against 100. Index generation deduplicates one/two-code-point tokens, uses bounded catalog batches/JSON1 writes, and rejects any single catalog item that exceeds the configured statement budget.

`GET /api/v1/market/listings/:id/history` returns bounded price/quantity events, inferred-sale evidence, and a keyset cursor. `inferredSales` contains `observedAt`, `soldQuantity`, `fromQuantity`, `toQuantity`, and a reason (`quantity_decrease`, `sold_out`, or low-confidence `missing_streak`). It is derived from immutable `sold_events` and is never inferred from an omitted delta item.

## Item catalog

The server-owned catalog is authoritative and keyed by `item_id`. Existing listings resolve names at read time through `item_catalog`, so a catalog rename changes the displayed name without another upload. Unknown IDs use the deterministic fallback `未知物品 #<item_id>`. Cards use the same catalog and fallback.

`GET /api/v1/items?q=<text>&limit=<1..20>` searches catalog names and aliases only. It returns `{ version, items: [{ itemId, name, aliases }] }`, uses `Cache-Control: public, max-age=86400`, and sends an ETag derived from the versioned response. Empty `q` returns no item matches; the endpoint never searches live listings or client-uploaded names.

The item catalog endpoint uses bounded D1 search structures: one- or two-code-point normalized Chinese queries use `search_short_tokens`, while queries of three or more code points use the indexed FTS path. Matching stays inside D1 with `EXISTS` predicates; the Worker does not build an application-side item-ID `IN` list.
