# LastROWeb Upload and Query API

This document is the external contract for the OpenKore market adapter. The upload endpoint accepts only the approved protocol v2 contract. The server does not implement or accept an earlier upload protocol.

## Account and authentication APIs

Account authentication is enabled only when `AUTH_ENABLED=true` and its server configuration is valid. Account cookies and endpoints are separate from market upload credentials and game passwords. The account routes are:

| Method and path | Access |
| --- | --- |
| `GET /api/v1/auth/csrf` | Anonymous CSRF bootstrap; returns `csrf_token` and an HttpOnly CSRF cookie |
| `POST /api/v1/auth/register`, `POST /api/v1/auth/login` | Anonymous, CSRF-protected writes |
| `GET /api/v1/auth/me` | Current session; a `PENDING_EMAIL` account receives `mail_availability` |
| `POST /api/v1/auth/session/refresh`, `/api/v1/auth/logout`, `/api/v1/auth/logout-all` | Current session; refresh and logout-all require its session CSRF token |
| `POST /api/v1/auth/email-verification/request`, `/api/v1/auth/email-verification/confirm` | Current account session; confirmation must use that same user's session |
| `POST /api/v1/auth/password/change` | Current account session and current password |
| `POST /api/v1/auth/password-reset/request`, `/api/v1/auth/password-reset/confirm` | Anonymous request; confirmation requires a one-use reset token and CSRF token |
| `PATCH /api/v1/account/profile`, `PUT /api/v1/account/avatar`, `DELETE /api/v1/account/avatar` | Current account session and session CSRF token; only the caller's profile can be changed |
| `GET /api/v1/users/:id/avatar` | Public avatar read; `v` is the avatar version used for cache invalidation |

For browser writes, send `Origin` matching the configured `AUTH_SITE_URL` and the CSRF token in `X-CSRF-Token`. The anonymous token is paired with the CSRF cookie; after login, use the session-bound token returned by login or `/me`. Account writes reject missing or untrusted origins and cross-site fetches. The account namespace does not use the public market API's wildcard CORS rule. Authentication and mutation responses use `Cache-Control: no-store`.

Unverified users can sign in as `PENDING_EMAIL`, read their own session, update their own display name/avatar, request verification again, and log out. Pending status does not grant verified-account status; the response keeps `mail_availability` visible so the client can explain delivery quotas. Registration and password-reset requests return the same accepted shape for existing and unknown email addresses and do not expose a user or mail-job identifier.

JSON bodies for ordinary account operations are limited to 8 KiB. Registration and avatar writes are limited to 64 KiB. Passwords are 5–256 Unicode code points and are not trimmed; display names are trimmed to 1–32 code points. An avatar is plain Base64 for one static 256×256 WebP image, at most 32 KiB (43,692 Base64 characters); do not send a data URL, animation, or original image. GET only renders an action form; email verification or password reset consumes its one-use token on POST.

## KE commerce orders

Commerce endpoints require a signed-in `ACTIVE` account with `permission_level >= 1`. Browser writes require the session CSRF token and trusted `Origin`; authenticated GETs do not require CSRF. Responses are private and `no-store`.

| Method and path | Behavior |
| --- | --- |
| `POST /api/v1/commerce/quotes` | Price a selected set of instance credits, renewals, or the account-level offline KoreEngine feature. Quote results are previews and do not create an order. |
| `POST /api/v1/commerce/orders` | Fix an immutable order from `{ "quote_id": "…" }`; requires `Idempotency-Key`. Returns the order ID, Checkout URL, expiry, and initial payment status. |
| `GET /api/v1/commerce/orders?cursor=…` | Read up to 20 of the caller's orders, newest first. `nextCursor` is opaque; pass it unchanged to fetch the next page. |
| `GET /api/v1/commerce/orders/:orderId` | Read the caller's saved order snapshot, actual delivered dates, payment and fulfillment state, and refund adjustments. An order owned by another account returns the same 404 as a missing order. |
| `GET /api/v1/commerce/orders/:orderId?status_only=1` | Read the local payment and fulfillment state for Checkout-return polling without contacting Stripe or returning a Checkout URL. |

The order detail retains the purchase-time amounts and terms even if catalog prices later change. It also reports each item's persisted delivery window and refund-projection deductions. Payment state is `unpaid`, `processing`, `paid`, or `failed`; a failed delayed payment leaves the immutable order in history and the buyer can return to `/ke/buy` to create a new order. Stripe Checkout returns to `/ke/buy` with `checkout=success` or `checkout=cancelled` and the fixed `order_id`; clients must use the authenticated order endpoint to inspect that order. A browser-supplied `session_id` is not used to identify or authorize an order. Canceling Checkout leaves the pending order unchanged and available until its stored expiry.

Commerce purchases use the dedicated `COMMERCE_STRIPE_SECRET_KEY`; it is required and never falls back to `STRIPE_SECRET_KEY`, which remains for the `/sponsor` donation honor roll. Store both API keys and the webhook signing secret as Worker secrets; set account ID, Product IDs, pricing version, payment-method configuration ID, site origin, mode, and sales switch as environment-scoped variables. The production GitHub Actions workflow reads these values from the GitHub `production` Environment and passes non-secret values to Wrangler; do not duplicate them in `wrangler.toml`. `COMMERCE_STRIPE_LIVEMODE` must be `false` in local/staging and `true` in production. Buyer routes also require the existing account authentication configuration to be valid and enabled (`AUTH_ENABLED=true`). Set `COMMERCE_ENABLED=true` only after the production Environment contains all required commerce variables and the Commerce API key and `COMMERCE_STRIPE_WEBHOOK_SECRET` secrets. With sales disabled, new quote and order requests return a fixed unavailable response while configured webhooks and background reconciliation continue.

The configured Stripe payment-method configuration must be active and expose Alipay. Each Product must carry `metadata.ltsd_commerce_product_key=slots` or `module:standalone`, matching its configured ID. Managed Payments, recurring prices, subscriptions, and automatic tax are not used. Checkout creates one-time dynamic `price_data` against the configured Products because renewals and align-to-date purchases can have different durations and amounts; the immutable LTSD order is the price source of truth.

## KE configuration profiles and hall

The KE editor and profile hall use the signed-in web session. `PENDING_EMAIL` and `ACTIVE` accounts may use them regardless of `permission_level`; email verification and KE runtime entitlements are not required. Disabled accounts and expired or revoked sessions remain blocked. Responses use `Cache-Control: no-store`. Write requests require an `Origin` matching `AUTH_SITE_URL`.

The existing personal profile routes remain compatible. `POST /api/v1/ke/profiles` keeps its `{ "id": number }` response and `PUT /api/v1/ke/profiles/:id` keeps its `204` response. Either request may include:

```json
{
  "sharing": {
    "enabled": true,
    "description": "可留空的使用说明"
  }
}
```

When `enabled` is true, the same transaction saves the personal profile and publishes or updates its shared snapshot. The title comes from the personal profile name. The first publication receives a unique `ABC-1234` share code; updates and recovery after withdrawal keep that code and existing counts. An omitted description is empty on first publication and preserves the previous value on update; an explicit empty string clears it. Description is limited to 16 KiB of UTF-8. `sharing` omitted by an older client or `enabled: false` saves only the personal profile and leaves an existing shared snapshot unchanged. `GET /api/v1/ke/profiles` adds nullable sharing metadata; `GET /api/v1/ke/profiles/:id` also returns the description. Deleting the source profile withdraws its shared snapshot in the same transaction.

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/ke/shared-profiles?sort=newest&job_id=...&page=1` | Published summaries only; `sort` is `newest`, `uses`, or `likes`; 20 results per page. `job_id` filters the author's saved job snapshot. |
| `GET /api/v1/ke/shared-profiles/code/:code` | Find by share code; case and optional hyphen are normalized. |
| `GET /api/v1/ke/shared-profiles/:id` | Read the summary and the five configuration files. Withdrawn and missing entries both return 404. |
| `DELETE /api/v1/ke/shared-profiles/:id/withdraw` | Withdraw one of the caller's published entries from the hall; the saved source profile remains available for republishing. |
| `PUT /api/v1/ke/shared-profiles/:id/like` / `DELETE .../like` | Add or cancel the caller's one like; repeated requests are idempotent. Authors cannot like their own entry. |
| `POST /api/v1/ke/shared-profiles/:id/copy` | Copy to a caller-owned bound role; body and response below. |
| `DELETE /api/v1/ke/profiles/:id/sharing` | Withdraw the source profile's shared entry; saving the editor checkbox checked later restores it. |

The list response contains `{ "items": [...], "page": 1, "page_size": 20, "total": 1 }`. Each item includes `id`, `title`, `description`, `job_id`, `author: { id, display_name }`, `share_code`, `like_count`, `use_count`, `liked_by_me`, `used_by_me`, `is_mine`, `created_at`, and `updated_at`. It omits the five file bodies and source role identifiers. `job_id` is only a search filter; copying across jobs is allowed.

Copy uses a UUID `request_id` so a retry of the same operation returns the original profile rather than creating another one:

```json
{
  "aid": 10000,
  "cid": 2,
  "nid": 3,
  "request_id": "11111111-1111-4111-8111-111111111111"
}
```

A successful first copy returns `201` and `{ "profile_id": 42, "name": "方案", "use_count": 1, "duplicate": false }`; replaying the same request returns `200` with `duplicate: true`. The copy is inactive and independent of later source updates. Repeated copies by the same account increase `use_count` only once. The author's own copies do not count. Name collisions receive a numbered suffix; a character's existing 20-profile limit still applies.

The shared-profile writes use account-scoped limits of 60 copies per hour and 300 likes or publish/update/withdraw operations per hour; a limit returns `429 KE_RATE_LIMITED`. Other notable errors are `403 KE_SHARED_SELF_LIKE`, `404 KE_SHARED_PROFILE_NOT_FOUND`, `409 KE_COPY_REQUEST_CONFLICT`, `409 KE_PROFILE_LIMIT_REACHED`, and `503 KE_SHARE_CODE_EXHAUSTED`.

## Upload

`POST /api/v1/market/upload` requires `Authorization: Bearer <source-api-key>`, `Content-Type: application/json`, and `Idempotency-Key: <snapshot_id/part_index>`. The authenticated API key determines `source_id`; a JSON `source_id` is never trusted. The body is limited to 512 KiB and each snapshot has at most 64 parts (indexes 0 through 63).

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

`dismissed` must contain `items: []`. In delta mode it closes the current shop and expires active and missing listings synchronously, without a sold event. In full mode this happens in background processing after all parts arrive. A stale `opening` cannot reopen a newer dismissal. Missing shops, incomplete uploads, stop events, and delta omissions are not explicit dismissal; absence from a complete full snapshot closes a shop with reason `missing_full`.

`full` contains the complete visible state for the shops included in the snapshot and reconciles missing listings only after every part is accepted. The first complete full snapshot establishes a baseline and creates no sold events. After two consecutive complete full snapshots omit an initialized listing, it becomes `missing` and may produce a low-confidence `missing_streak` event. `delta` updates only the supplied shops/items; an omitted delta item is not sold. `heartbeat` uses lightweight opening shop objects and updates liveness without changing the listing collection.

The canonical idempotency key is `snapshot_id/part_index`. A repeated batch with the same validated v2 payload returns the stored response with `duplicate: true`. Retry uses the same payload bytes, UUIDs, observed time, and idempotency key unless the error action explicitly requires a new snapshot. Reusing a key with a different payload returns `422 idempotency_key_reused` and requires a new snapshot ID and key. All parts of a full must share `part_count`, `client_run_id`, and `observed_at`; indexes must be unique and cover `[0, part_count)`. A canonical shop identity may occur only once across the entire full snapshot.

Upload errors use this envelope and never echo bearer tokens or complete payloads:

```json
{
  "error": {
    "code": "idempotency_key_reused",
    "message": "Idempotency key was reused with a different payload",
    "request_id": "request-id",
    "retryable": false,
    "action": "new_snapshot"
  }
}
```

`retryable` is always present on Worker-generated upload errors. `action` is present only when the client must change its workflow. `batch_in_progress`, `listing_state_conflict`, and `rate_limited` responses include `Retry-After` when the server has a delay to communicate.

| HTTP | `error.code` | Meaning | OpenKore action |
| ---: | --- | --- | --- |
| 400 | `malformed_json` | The request body is not valid JSON. | Fix serialization; do not retry unchanged. |
| 400 | `invalid_idempotency_key` | The key is missing, non-printable, or longer than 256 bytes. | Fix the header; do not retry unchanged. |
| 400 | `idempotency_key_mismatch` | The key is not the canonical `snapshot_id/part_index`. | Use the canonical key; do not retry unchanged. |
| 401 | `unauthorized` | The bearer credential is missing or invalid. | Correct credentials; do not automatically retry. |
| 403 | `source_disabled` | The authenticated source is disabled. | Stop uploads until the source is enabled. |
| 404 | `not_found` | The requested API resource is not available. | Do not retry unchanged. |
| 409 | `listing_state_conflict` | A concurrent listing transition won after one server-side retry. | Retry the identical request with the same key after `Retry-After`. |
| 413 | `payload_too_large` | The encoded request body exceeds the configured byte limit. | Create a new snapshot and split it into smaller parts (`action: reshard_upload`). |
| 413 | `upload_limit_exceeded` | A part exceeds the configured part, shop, item, or option limits. | Create a new snapshot and split it into smaller parts (`action: reshard_upload`). |
| 422 | `invalid_upload` | JSON is valid but does not satisfy protocol v2. | Fix the payload; do not retry unchanged. |
| 422 | `duplicate_shop_identity` | Two shops in a batch or across full snapshot parts resolve to the same canonical identity. | Fix duplicates and send a new snapshot. |
| 422 | `idempotency_key_reused` | A completed, processing, or rejected key has a different payload hash. | Create a new snapshot and key (`action: new_snapshot`). |
| 423 | `batch_in_progress` | Another request owns the same batch claim. | Retry the identical request with the same key after `Retry-After`. |
| 429 | `rate_limited` | The source upload rate limit was reached. | Retry the identical request with the same key after `Retry-After`. |
| 500 | `internal_error` | An unexpected server failure occurred. | Retry with bounded exponential backoff using the same key; alert after the retry budget is exhausted. |
| 500 | `ingestion_invariant_failed` | An internal ingestion capability or state invariant failed. | Retry with bounded exponential backoff using the same key and alert operators. |
| 503 | `storage_unavailable` | The upload batch could not be claimed in storage. | Retry with bounded exponential backoff using the same key. |
| 503 | `limiter_unavailable` | The source limiter failed or returned a non-success response. | Retry with bounded exponential backoff using the same key. |

Cloudflare may reject or terminate a request before the Worker can create this JSON envelope. OpenKore must therefore also handle non-JSON responses and no-response/network timeouts. Treat HTTP `500`, `502`, `503`, `504`, `520` through `526`, and `530` without a recognized JSON `error.code` as retryable infrastructure failures. Use bounded exponential backoff and the same payload and idempotency key. A later `423 batch_in_progress` means the interrupted invocation may still own the claim; continue honoring `Retry-After` rather than creating another key.

Successful responses use snake_case and contain `accepted`, `batch_id`, `duplicate`, `processed_shops`, `processed_listings`, `changed_listings`, `sold_events`, ordered `shops` results, and `next`. Delta/heartbeat retain synchronous counters. A full returns HTTP 202 once its part is durably stored, with this pending response:

```json
{
  "accepted": true,
  "batch_id": "redacted-snapshot/0",
  "duplicate": false,
  "processed_shops": 0,
  "processed_listings": 0,
  "changed_listings": 0,
  "sold_events": 0,
  "shops": [{
    "uuid": "5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1",
    "shop_id": "shop_v1_redacted",
    "shop_status": "opening",
    "applied": false,
    "resolution": "pending"
  }],
  "next": null,
  "reconciliation": {
    "status": "pending",
    "snapshot_id": "redacted-snapshot",
    "stage": "materialize_parts"
  }
}
```

For full responses, `shops[].shop_id` is already the stable canonical identity and can be cached using `uuid` even while `applied` is false. `resolution: pending` means the observation has been stored but live listing state has not been applied. The client must accept this new resolution and must not treat `applied: false` as an upload failure when `accepted: true` and `reconciliation.status: pending`. Adapters that only cache mappings when `applied` is true need a corresponding adjustment. OpenKore source code is external to this repository; client compatibility is not claimed as verified.

The cached duplicate response stays pending even after the background job completes; replaying an upload is not a status query. Admin status is available at `GET /api/admin/snapshots/:sourceId/:snapshotId` using `x-admin-secret`. Failed complete snapshots can be retried with `POST /api/admin/snapshots/:sourceId/:snapshotId/requeue`. An incomplete snapshot expires after 24 hours and needs a new full snapshot.

One client part is processed by one materialization Queue invocation. The server does not subdivide that part into fixed groups of 20 shops. Choose smaller client shards to reduce both receipt and materialization CPU. Once all parts are materialized, server-owned reconciliation scans use persistent cursors and `SNAPSHOT_RECONCILE_BATCH_SIZE` (default 200), one chunk per invocation. The last HTTP part never performs these scans. Search may show progressively applied parts; `last_full_snapshot_at` advances only after finalization.

## Search and history

`GET /api/v1/market/search` accepts bounded text, exact item ID, map, shop type, price range, structured raw option filters, `limit` (maximum 50), allowlisted sort values, and an opaque keyset `cursor`. Query values are bound parameters; offset pagination and arbitrary SQL sort fields are not accepted. Search responses use `Cache-Control: public, max-age=30, s-maxage=30` and return `nextCursor` for the next keyset page.

Successful public GET searches also use the Workers Cache API for up to 30 seconds. Cache hits reduce the response's remaining `max-age` and `s-maxage`, so downstream caching cannot start a new 30-second freshness window. `X-Search-Cache` is `HIT`, `MISS`, or `BYPASS`. Authorization, range requests, and explicit cache-bypass directives skip the shared cache; errors are never stored. Search ignores cookies and never personalizes results. Entries are isolated by origin, exact query string, environment, build version, database, cursor secret, and search/option/cache versions. See [search performance](search-performance.md) for measurement and operational details.

Text is normalized with Unicode NFKC, leading/trailing whitespace removal, internal whitespace folding, and lowercase conversion. Empty normalized text disables the text filter and `q` is limited to 80 Unicode code points; a single normalized character still participates in text matching, so scoped shop/vendor queries are never silently dropped into an unfiltered listing page. The authoritative catalog is a server-owned static asset; live MySQL search matches the current listing/shop data with bounded, parameterized predicates. The Worker does not construct SQL from request text or materialize an unbounded application-side item-ID `IN` list. The current listing and non-closed shop state determine whether a listing is returned; `include_stale=true` still excludes closed shops.

`q_scope` restricts which fields the `q` text matches and accepts a comma-separated subset of `item`, `shop`, and `vendor` (canonical order, duplicates and surrounding whitespace are tolerated): `item` matches catalog item names resolved to item IDs, `shop` matches shop titles, and `vendor` matches vendor names; omitting the parameter or passing `all` keeps the default behavior of matching all three. Item-name matching resolves `q` against the server-owned static catalog with the same normalization, name/alias/ID substring rules, item-ID ordering, and top-50 bound the web client applies; the resolved IDs are merged into the filter set and bound into the search cursor. Under an item-only `q_scope`, a `q` that resolves to no catalog item returns an empty page unless explicit `item_id`/`item_ids` parameters are present. The other filters (`item_id`, `item_ids`, price, map, shop type, options) are independent of `q_scope` and always apply.

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

Definitions with `value_policy: "flag"` (for example `赋予武器火属性` or `武器不会被破坏`) carry no magnitude: the stored value is always `0`, only `eq` is allowed, and clients must not render operator/value inputs. Definitions with `selectable: false` (for example type 204, the empty-slot sentinel) are omitted from pickers and structured queries for them return the standard `bad_request` envelope.

The legacy exact raw tuple query remains available through 2026-10-31 only when all three parameters are supplied together: `option_type=12&option_value=50&option_param=0`. It has exact equality semantics. Mixing legacy parameters with `option=` returns `400`; incomplete legacy tuples return `400`. New integrations must use structured `option=`. Unknown option types remain stored and displayed, but structured queries for an unknown type return the standard `bad_request` error envelope.

Search cursors are HMAC-signed and bind the normalized q, the q scope, and q mode, catalog/option/search-index versions, every scalar filter, normalized option conditions and mode, sort, last sort value, and last listing ID. Reusing a cursor with a different q, q scope, option condition, definition/catalog version, or sort returns `400`.

`GET /api/v1/options` returns stable type-level metadata, an ETag, and `Cache-Control: public, max-age=86400`. It does not enumerate every exact value/param tuple:

```json
{
  "version": "options-lastro-71.0",
  "options": [{
    "type": 12,
    "handle": "VAR_SPACCELERATION",
    "label_zh": "SP恢复速度增加数值%",
    "description_template": "SP恢复速度增加{value}%",
    "value_kind": "integer",
    "value_policy": "numeric",
    "selectable": true,
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

The search implementation uses the versioned static option definition set and bounded MySQL queries. A request has at most eight structured option conditions and 50 results. SQL values are always bound parameters; dynamic option predicates are compiled only from the server allowlist, while user values remain parameters. Upload-side bulk work is set-based and transactional rather than one query per listing.

`GET /api/v1/market/listings/:id/history` returns bounded price/quantity events, inferred-sale evidence, and a keyset cursor. `inferredSales` contains `observedAt`, `soldQuantity`, `fromQuantity`, `toQuantity`, and a reason (`quantity_decrease`, `sold_out`, or low-confidence `missing_streak`). It is derived from immutable `sold_events` and is never inferred from an omitted delta item.

## Item catalog

The server-owned catalog is authoritative and keyed by `item_id`. Existing listings resolve names at read time through `item_catalog`, so a catalog rename changes the displayed name without another upload. Unknown IDs use the deterministic fallback `未知物品 #<item_id>`. Cards use the same catalog and fallback.

`GET /api/v1/items?q=<text>&limit=<1..20>` searches catalog names and aliases only. It returns `{ version, items: [{ itemId, name, aliases }] }`, uses `Cache-Control: public, max-age=86400`, and sends an ETag derived from the versioned response. Empty `q` returns no item matches; the endpoint never searches live listings or client-uploaded names.

The item catalog endpoint reads the versioned static catalog asset. It does not query D1 or MySQL, and matching does not build an unbounded application-side item-ID `IN` list.

## Guestbook

The public guestbook allows anonymous visitors to post a `buy`, `sell`, or `suggestion` entry. `GET /api/v1/guestbook` accepts optional `category`, `item_id`, `q`, `limit` (default 20, maximum 50), and opaque `cursor` filters. Text searches match the entry body and trade contact as literal text. Pages are ordered newest first by `(createdAt,id)` and cursors are signed and bound to the active filters.

Trade entries require an exact item catalog ID or the special Zeny choice, a contact (WeChat, QQ, or in-game character), body text, and a `duration` of `1d`, `3d`, `7d`, or `permanent`. Zeny is represented by `isZeny: true` with `itemId: null`; ordinary items use `isZeny: false` and their exact catalog `itemId`. Suggestions contain only `category: "suggestion"` and `content`, and need no contact or item.

`POST /api/v1/guestbook` accepts JSON up to 16 KiB. Content is limited to 2,000 Unicode code points and contacts to 120. Public submissions are immediately visible. The Worker rate-limits anonymous posts to five per source address per minute using a keyed digest; it does not persist or return the plain address. Rate-limit exhaustion returns HTTP 429 with `error.code: "rate_limited"`; limiter storage failures fail closed.

Entries are not deleted or filtered when they expire. Responses include `expiresAt` (`null` for permanent/suggestions) and `isExpired`; the page visually marks expired entries while keeping them available to search. Suggestions have no expiry. No visitor identity, IP address, edit, or delete operation is exposed.
