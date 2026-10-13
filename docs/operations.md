# Operations

All operator command examples use PowerShell.

## Health and monitoring

Monitor Worker request metrics and MySQL failures through Workers Logs. Metrics include request ID, route, status, elapsed time, and declared request size. Do not log bearer tokens, complete upload bodies, player identifiers, coordinates, or `MYSQL_URL`.

`GET /api/health` always returns Worker metadata. It reports `db: "unconfigured"` locally when `MYSQL_URL` is absent, `db: "ok"` only after MySQL `SELECT 1`, and `db: "error"` on a sanitized connection failure. It never returns host, username, password, or socket details.

The daily retention trigger removes bounded old listing history and sold events; it does not delete current listings. Monitor MySQL disk, connection, query-latency, backup, and TLS-certificate health before expanding retention or upload volume. The Worker pool is intentionally bounded to two connections per isolate; account for Worker concurrency and VPS `max_connections` together.

## Account mail and cleanup

The independent `*/2 * * * *` tick runs only when `AUTH_ENABLED=true` and the auth configuration is valid. Each invocation opens one MySQL database and closes it in `finally`. It does not run snapshot wakeup, staging cleanup, or market retention work. Missing Resend configuration pauses delivery only; account login remains available and the tick can still reclaim expired data. Invalid auth settings are reported with a fixed configuration warning and do not open the account database.

Every production release whose preflight enables auth first publishes `AUTH_ENABLED=false` before changing any account secret. This creates a short sign-in and mail maintenance window while current/previous keys and versions are updated. After the barrier succeeds, a failed secret write or final deploy stops the workflow and leaves auth disabled; fix the missing/failed step and rerun the complete workflow. If the barrier itself reports failure, no account-secret writes follow; inspect the deployed Worker state before retrying because the barrier result may be ambiguous. Manual key rotation must use the same order: publish disabled, update matching secret/version pairs, then deploy the complete configuration and re-enable. Never manually restore `AUTH_ENABLED=true` with a partial key update.

With a valid Resend API key, one tick claims at most one ready mail using the same daily/monthly budget settings as HTTP requests. Sending is the tick's only work. If no mail is ready, it either terminalizes one expired outbox job or runs one cleanup category. Without a Resend API key it skips mail claiming and runs one cleanup category. Every SQL cleanup caps its total affected rows at 50; there is no loop to drain a backlog. The fixed UTC rotation has eight two-minute slots:

| Slot | Bounded work |
| --- | --- |
| 0 | Expired pending mail or mail with an expired lease; clear ciphertext and mark `CANCELLED/MAIL_EXPIRED`, unless the send result is no longer safe to retry, which becomes `FAILED/delivery_unknown` |
| 1 | Expired-lease claimed mail at the four-attempt limit; mark `FAILED/delivery_unknown` and clear ciphertext |
| 2 | Expired-lease claimed mail whose first attempt is at least 24 hours old; mark `FAILED/delivery_unknown` and clear ciphertext |
| 3 | Delete terminal outbox metadata after 30 days |
| 4 | Delete expired action-token metadata after seven days |
| 5 | Delete expired sessions |
| 6 | Delete security events older than 90 days |
| 7 | Delete expired rate-limit rows |

The schedule uses only the current UTC time; it stores no global slot marker. Cleanup never deletes users or credentials and does not delete unexpired pending actions. Session/token validity is checked against expiry in the request path, so a missed cleanup does not make an expired credential valid. Outbox ciphertext is cleared on send completion or terminalization; the action-token digest remains independently governed by its seven-day metadata TTL. Existing foreign keys retain the owning user; the outbox has no foreign key to `action_digest`.

Resend's `daily_quota_exceeded` is a UTC-day stop, while `monthly_quota_exceeded` has no promised next-day recovery. `rate_limit_exceeded` is the transient 429 and follows bounded retries. The Worker reserves against the configured local budget before sending, uses at most four attempts and a stable idempotency key, and retries at bounded 1/5/15-minute delays. A send attempt older than the provider's 24-hour idempotency window is terminalized as result unknown instead of being sent again. A completed API request means Resend accepted a message; it does not prove inbox delivery. See [Resend error handling](https://resend.com/docs/api-reference/errors) and [account quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits).

For diagnosis, use sanitized Worker error categories and aggregate counts by outbox `state`, `last_error_code`, and age; do not print mail payloads, recipient addresses, token links, secret values, or `MYSQL_URL`. A `FAILED/delivery_unknown` task is not proof that no message was sent and is never automatically recreated. The user may request a fresh action after checking the account. To stop auth work, disable `AUTH_ENABLED`; preserve the database rows and key material until the documented rotation checks are complete. Check [deployment setup](deployment.md#account-auth-and-resend-rollout) before changing production configuration.

## MySQL change control

Back up MySQL before every production import or schema migration. Apply `pnpm db:mysql:migrate` before Worker deployment, then run `pnpm db:mysql:migrate -- --dry-run` and `pnpm db:mysql:verify` with `MYSQL_URL` in the process environment. The migration tracker is checksum-protected and should only move forward.

Keep a read-only D1 export and the converted SQL outside Git throughout the cutover window. A database rollback is a separate, approved operation; reverting Worker code does not revert MySQL data. Never reset a production schema or use `DROP DATABASE`.

## Catalog operations

Catalog imports generate versioned static JSON assets under `apps/web/public/catalog`. They do not query either MySQL or D1 and do not alter listings. Review the generated JSON/checksum, rebuild the web app, and deploy it with the Worker. See [catalog import](catalog-import.md).
