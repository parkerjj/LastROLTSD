# Upload CPU optimization

## Behavior

Successful uploads emit only the existing compact `lastroweb.request` metric.
The upload route no longer parses or serializes request bodies for logging.
Failures emit `lastroweb.upload_error` with a request ID, status, error class,
processing stage, body byte count, retryability, and available MySQL error codes.
Validation diagnostics contain at most ten issue paths and codes plus the total
issue count. Bodies, field values, unknown field names, idempotency keys, token
hash prefixes, and arbitrary exception messages are not logged by the route.
Batch cleanup failures likewise log metadata without the exception payload.

Body size is measured once in UTF-8 bytes and reused for both upload limit checks.
Items are normalized once per upload. Fingerprint canonicalization avoids sorting
already sorted options; digest hex encoding uses Buffer. The persisted payload,
item, and full-shop hash formats are unchanged, including their distinct identity
scopes. These changes do not change upload responses or snapshot semantics.

Shop resolution skips the three dismissal statements for opening-only requests,
and skips the opening upsert for dismissal-only requests. Mixed requests keep both
paths in the same transaction. Its two reads fetch only the nine required columns.

## Reproduce the local comparison

```powershell
pnpm exec vite-node --config vitest.config.ts scripts/benchmark-upload-cpu.mjs
```

The benchmark uses synthetic data, the real upload route and state service, and
in-memory repository methods. Each scenario has 30 warmup requests followed by
three samples of 80 requests. Each sample reports mean Node process CPU per
request; the table reports the median of those three means. Logging output is
discarded, but serialization and the resulting log byte count are measured.

Observed on Node v24.21.0, 2026-09-23:

| Scenario | Before CPU ms | After CPU ms | Reduction |
| --- | ---: | ---: | ---: |
| Heartbeat, 20 shops | 0.975 | 0.775 | 21% |
| Full new, 20 shops / 400 items | 14.262 | 11.137 | 22% |
| Full unchanged, 20 shops / 400 items | 8.975 | 7.025 | 22% |
| Delta new items, 20 shops / 400 items | 8.588 | 7.425 | 14% |

The item payloads are about 76 KB. Their per-request upload log volume fell from
about 76 KB to zero. The existing application request metric is outside this
route-only benchmark and remains enabled in the deployed application.

These are noisy local measurements, not Cloudflare CPU measurements. They exclude
MySQL driver/network work, database execution, and Cloudflare log transport. In
particular, the benchmark does not quantify savings from fewer SQL statements.
The unchanged-full case simulates the database reporting an unchanged shop.

## Deployment acceptance

After deploying, compare Workers invocation `cpuTimeMs` and `exceededCpu` outcomes
for similar payloads. Separate heartbeat, unchanged full, changed full, new items,
duplicate replay, and final-part reconciliation; the final part can do more work.
Check cold invocations as well as sustained traffic. Application `elapsed_ms`
includes network waits and is not a CPU measurement.

Aim for p99 at or below 7 ms to leave headroom under a 10 ms limit. This is a target,
not a result established by local tests. Preserve full-snapshot boundaries and the
16-part protocol limit if payload sizes are adjusted later.

This change does not move processing to Cron/VPS, alter database schema, or add
recovery leases for batches interrupted by platform termination. Existing stuck
`processing` batch recovery remains a separate reliability concern.
