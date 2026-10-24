# Operations

All operator command examples use PowerShell.

## Health and monitoring

Monitor Worker request metrics and MySQL failures through Workers Logs. Metrics include request ID, route, status, elapsed time, and declared request size. Do not log bearer tokens, complete upload bodies, player identifiers, coordinates, or `MYSQL_URL`.

`GET /api/health` always returns Worker metadata. It reports `db: "unconfigured"` locally when neither the selected Hyperdrive binding nor direct `MYSQL_URL` is available, `db: "ok"` only after MySQL `SELECT 1`, and `db: "error"` on a sanitized connection failure. It never returns host, username, password, or socket details. Explicit Hyperdrive mode requires its binding before the handler starts. Deployed environments default to Hyperdrive with SQL query caching disabled; see [Hyperdrive setup and rollback](hyperdrive.md).

The daily retention trigger removes bounded old listing history and sold events; it does not delete current listings. Monitor MySQL disk, connection, query-latency, backup, and TLS-certificate health before expanding retention or upload volume. The Worker pool is intentionally bounded to two connections per isolate; account for Worker concurrency and VPS `max_connections` together.

## Account mail and cleanup

The independent `*/2 * * * *` tick runs only when `AUTH_ENABLED=true` and the auth configuration is valid. Each invocation opens one MySQL database and closes it in `finally`. It does not run snapshot wakeup, staging cleanup, or market retention work. Missing Resend configuration pauses delivery only; account login remains available and the tick can still reclaim expired data. Invalid auth settings are reported with a fixed configuration warning and do not open the account database.

Every production release whose preflight enables auth first publishes `AUTH_ENABLED=false` before changing any account secret. This creates a short sign-in and mail maintenance window while current/previous keys and versions are updated. A secret-write failure after the barrier succeeds stops without recovery and leaves auth disabled. A failed or ambiguous final complete-configuration deploy may already have taken effect; verify the deployed Worker version and actual `AUTH_ENABLED` state before retrying or reporting whether auth is enabled. Do not infer the remote state from the command's exit status alone. If the barrier itself reports failure, no account-secret writes follow; inspect the deployed Worker state before retrying because the barrier result may be ambiguous. Manual key rotation must use the same order: publish disabled, update matching secret/version pairs, then deploy the complete configuration and re-enable. Never manually restore `AUTH_ENABLED=true` with a partial key update.

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

### 邮件即时唤醒与日志排查

发件箱仍是唯一的事实来源。注册、重发验证、找回密码、改密等操作在发件箱事务提交之后，会向 `MAIL_QUEUE`（`lastroweb-<环境>-mail-jobs`）发一条不含任何邮件内容的唤醒消息，由队列消费者立即发信：一次唤醒最多连续发 5 封，遇到空闲、重试、暂停或失败就停止；积压留给后续唤醒和 `*/2` Cron 兜底，Cron 仍然每次最多领取 1 封。唤醒消息发送失败只会记录 `lastroweb.auth_mail_wake_enqueue_failed`，不影响注册响应，邮件由 Cron 补发。未绑定 `MAIL_QUEUE` 时行为与此前完全一致。

2026-10-24 观察到 `*/2 * * * *` 在控制台已注册、`wrangler tail` 中却从未触发，而每分钟的 `* * * * *` 与 `*/5` 正常。因此上文所说的账号 tick 现在由每分钟 cron 每分钟执行一次（先于快照任务运行，失败只记日志、不影响快照），`*/2` 触发器已从 `wrangler.toml` 移除；`scheduled` 里的 `*/2` 分支仅为兼容保留。tick 每次仍最多领取 1 封，作为队列唤醒的兜底。

排查“发件箱有 `PENDING` 却没人发”时，用 `wrangler tail lastroweb-production --format pretty` 观察下列错误级别日志（`CURRENT_LOG_LEVEL` 为 error，warn/info 不会输出；日志采样率已设为 100%（`observability.logs.head_sampling_rate = 1`），正常请求不产生日志行，所以只会记录错误；追踪 Traces 仍是 1% 采样，实时 tail 不受采样影响）：

| `metric` | 含义 |
| --- | --- |
| `lastroweb.auth_job_config_unavailable` | 账号配置校验失败，`*/2` 整个 tick 被跳过（此前只有一条无细节的 warn） |
| `lastroweb.auth_job_mail_unconfigured` | 未配置 `RESEND_API_KEY`，tick 静默跳过发信 |
| `lastroweb.auth_job_mail_not_sent` | tick 领到邮件但结果不是 `sent`（`result`：`retry`、`paused`、`failed`） |
| `lastroweb.auth_job_failed` | tick 抛错；带 `mysql_operation`、`mysql_errno`、`mysql_sql_state`、`mysql_client_reason` 等已脱敏字段 |
| `lastroweb.auth_mail_wake_failed` | 队列消费者数据库或发送阶段抛错，消息 30 秒后重试，最多 3 次 |
| `lastroweb.auth_mail_wake_stopped` | 唤醒中途遇到 `paused`（配额/凭据）或 `failed` |

这些日志不包含收件人、token、密文或连接串。

### Single-account disable and restore

There is no per-user administration endpoint. `AUTH_ENABLED=false` pauses account handling site-wide but does not change an individual user's status, `auth_version`, action tokens, or audit history; it cannot replace a single-account disable.

The following is a maintenance template, not an authorization to run a production change. Execute it only when a trusted maintainer has separate approval for that exact account and operation. Use one database connection and exactly one canonical, non-zero decimal-string user ID that fits `BIGINT UNSIGNED`; bind it as a string to every `?` placeholder and never interpolate it into SQL. Record the operator and approval in the protected change system; bind only its opaque reference (at most 64 ASCII characters) to `request_id`. Read only the locked account's ID, status, verification timestamp, and auth version. Do not read or output an email address, credential material, avatar data, token digest or plaintext, or mail ciphertext. Do not use `SELECT *`.

Run each statement on the same connection and inside the same transaction. Obtain one UTC Unix-millisecond timestamp after acquiring the user lock and bind it to all timestamp placeholders. If the user is missing, the locked status does not match the requested transition, a required row count is not exactly one, or any statement fails, roll back the transaction and make no change. Commit only after the audit insert succeeds. A zero-row action-token update is valid when no outstanding actions exist.

For disable, accept only a locked `ACTIVE` or `PENDING_EMAIL` row. If it is already `DISABLED`, make no change. The user row is locked before updating that user's action rows; the audit insert follows, matching the repository's user → session/action → outbox → audit lock order (this procedure does not write outbox rows).

```sql
START TRANSACTION;

SELECT CAST(id AS CHAR) AS id, status, email_verified_at, auth_version
FROM auth_users
WHERE id = ?
FOR UPDATE;

-- Continue only when the locked row is the requested ID and status is ACTIVE or PENDING_EMAIL.
UPDATE auth_users
SET status = 'DISABLED', auth_version = auth_version + 1, updated_at = ?
WHERE id = ? AND status IN ('ACTIVE', 'PENDING_EMAIL');

UPDATE auth_action_tokens
SET revoked_at = ?
WHERE user_id = ?
  AND purpose IN ('VERIFY_EMAIL', 'RESET_PASSWORD')
  AND consumed_at IS NULL
  AND revoked_at IS NULL;

INSERT INTO auth_security_events
  (user_id, `event`, request_id, result, reason, created_at)
VALUES (?, 'ACCOUNT_DISABLED', ?, 'SUCCESS', 'authorized_maintenance', ?);

COMMIT;
```

Bind the selected user ID to each user-ID placeholder and the post-lock timestamp to each time placeholder. Require one affected row for the `auth_users` update and audit insert. `auth_version` is incremented monotonically so existing sessions fail current-version checks; all unconsumed, unrevoked `VERIFY_EMAIL` and `RESET_PASSWORD` actions are permanently revoked. Do not change `credential_version` or credential rows, delete account data, clear revocation markers, or manually edit outbox state/ciphertext. A mail request already in flight may still be delivered, but its action is revoked.

Restore with the same approval, one-ID, lock, timestamp, and audit requirements. Proceed only for a locked `DISABLED` row; otherwise roll back without changes. Derive the restored status from the existing `email_verified_at`, leave that timestamp and all credential material untouched, and advance `auth_version` again:

```sql
START TRANSACTION;

SELECT CAST(id AS CHAR) AS id, status, email_verified_at, auth_version
FROM auth_users
WHERE id = ?
FOR UPDATE;

-- Continue only when the locked row is the requested ID and status is DISABLED.
UPDATE auth_users
SET status = CASE WHEN email_verified_at IS NULL THEN 'PENDING_EMAIL' ELSE 'ACTIVE' END,
    auth_version = auth_version + 1,
    updated_at = ?
WHERE id = ? AND status = 'DISABLED';

UPDATE auth_action_tokens
SET revoked_at = ?
WHERE user_id = ?
  AND purpose IN ('VERIFY_EMAIL', 'RESET_PASSWORD')
  AND consumed_at IS NULL
  AND revoked_at IS NULL;

INSERT INTO auth_security_events
  (user_id, `event`, request_id, result, reason, created_at)
VALUES (?, 'ACCOUNT_RESTORED', ?, 'SUCCESS', 'authorized_maintenance', ?);

COMMIT;
```

Require one affected user and audit row before committing. The restore does not verify an email, lower a version, revive an old session, un-revoke or un-consume an action, or reset a failed mail task. Reapplying the action revocation keeps any remaining old action unusable. Require a fresh login; any later action must be requested through the normal account flow. These statements match the fields in `migrations/mysql/009_account_system.sql`; they are a documented maintenance path only and were not executed as part of this work.

## Account CPU verification

`pnpm bench:auth-cpu` is a local approximation that exercises the full Worker entry with a dedicated local `_test` database and synthetic accounts. It rejects `MYSQL_URL`, accepts only `MYSQL_TEST_URL` for `127.0.0.1:13306` with a database name ending in `_test`, and requires all three auth MySQL test guards. Its `wall_ms` includes local MySQL round trips; `local_cpu_ms` is Node `process.cpuUsage()` for the Worker entry and response-body read. The Node process excludes MySQL server CPU, and its first module-import sample excludes Node/Vitest process startup. That import sample can include local Vitest/Vite loader work, so process CPU is not limited to the Worker handler. The loopback test connection does not establish production MySQL TLS, Worker socket, or runtime-driver costs; the local test URL's TLS setting is unconfirmed. Neither metric is Cloudflare Worker CPU. The output always sets `remote_cpu_ms` to `null` and `production_budget` to `UNVERIFIED`; the local command never accepts remote CPU data.

Before treating account auth as compatible with Workers Free, measure each account HTTP route and the `*/2 * * * *` job in an authorized staging environment using synthetic accounts and a dedicated test mailbox or test-only delivery sink. Do not send messages to players. Use the actual production-equivalent MySQL TLS, driver, and socket open/close behavior in those measurements. Record the build SHA, runtime and compatibility settings, route or job, measurement window, CPU source, hot and cold sample counts, sampling configuration, and whether cold-isolate state was confirmed. Aim for at least 100 hot and 10 cold samples per path; if the platform cannot confirm a cold isolate, label that sample `cold unconfirmed` rather than inferring it from a fresh client or process.

Use Cloudflare's Workers Query Builder `$workers.cpuTimeMs` for invocation CPU. Where root trace spans are available, record `cloudflare.cpu_time_ms` and `cloudflare.wall_time_ms` as separate fields. Do not substitute application elapsed time or wall time for CPU. Cloudflare's CPU metric quantiles use reservoir sampling, so include the observed sample count and sampling limits when reporting p99 or maximum; the repository's invocation logs are disabled and its trace sampling is 1%, so neither can establish a full-population maximum. Measure complete cold and hot calls, including module initialization, cryptography, database driver work, route handling, and the single scheduled mail or cleanup action.

The Free-tier acceptance target remains p99 CPU at or below 5 ms and observed maximum at or below 8 ms, with no path reaching 10 ms or a CPU resource error. If a route or scheduled job reaches 10 ms, stop the Free-tier rollout and investigate using the measured Cloudflare CPU data. Local Node readings above 10 ms are a risk signal only; they do not prove that the Worker exceeds its limit. References: [Workers Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/), [trace span attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/), [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), and [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/).

## MySQL change control

Back up MySQL before every production import or schema migration. Apply `pnpm db:mysql:migrate` before Worker deployment, then run `pnpm db:mysql:migrate -- --dry-run` and `pnpm db:mysql:verify` with `MYSQL_URL` in the process environment. The migration tracker is checksum-protected and should only move forward.

Keep a read-only D1 export and the converted SQL outside Git throughout the cutover window. A database rollback is a separate, approved operation; reverting Worker code does not revert MySQL data. Never reset a production schema or use `DROP DATABASE`.

## KE profile hall

Apply MySQL migration `019_ke_shared_profiles.sql` before deploying the Worker and web build that expose the hall. The migration creates four new tables and does not publish existing profiles. New shared entries are snapshots; withdrawal and source-profile deletion hide the snapshot but retain it, its code, likes, use records, and copy receipts. Copied personal profiles remain usable after the source is withdrawn or deleted. There is no scheduled cleanup for shared entries or their relationships in the first version.

Watch `429 KE_RATE_LIMITED` responses and MySQL latency for `shared-profiles` routes. The account-scoped limits are 60 copies per hour and 300 likes or publish/update/withdraw operations per hour. Logs must not include configuration files, descriptions, cookies, session tokens, or share request bodies. A Worker rollback does not reverse migration `019`; repair schema or shared data only through the normal backup and forward-change process.

## Catalog operations

Catalog imports generate versioned static JSON assets under `apps/web/public/catalog`. They do not query either MySQL or D1 and do not alter listings. Review the generated JSON/checksum, rebuild the web app, and deploy it with the Worker. See [catalog import](catalog-import.md).
