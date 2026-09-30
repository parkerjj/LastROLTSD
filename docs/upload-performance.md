# Upload CPU and async full snapshots

## TCP write compatibility

Cloudflare's production socket runtime can disconnect when one TCP write exceeds
64 KiB, surfacing `Network connection lost` on the next read. Local Wrangler does
not reproduce this behavior. See [workerd #7074](https://github.com/cloudflare/workerd/issues/7074).

The MySQL pool now limits socket writes to 32 KiB after each connection's handshake,
including TLS connections. Both individual and buffered vector writes are split
sequentially, preserving byte order, backpressure, and errors. SQL statements,
transactions, and client upload parts are unchanged; this is not a shop batch limit.

Read-only remote-preview verification against the configured MySQL instance on
2026-09-24 reproduced the original disconnect with a 65,535-byte bound parameter
(plus protocol overhead). With the transport fix, parameters of 65,535, 89,630,
115,000, and 524,288 bytes all succeeded. The server's `max_allowed_packet` was
64 MiB. These checks establish transport compatibility, not the upload CPU budget.

## Processing boundaries

Full HTTP receipt validates one client part, hashes the validated payload and shop
identities, and persists it in MySQL. It returns ordered `uuid -> shop_id` mappings
with `reconciliation.status: pending`. It does not normalize/fingerprint items,
read listings, infer sales, or reconcile the snapshot. MySQL extracts per-shop
staging rows and computes conservative hashes of the stored item JSON. The last
part increments the accepted count and sends one small wakeup after commit.

One materialize invocation handles exactly one client part. There is no extra
20-shop/200-item server split: client shard size controls this work. A full with
9 parts therefore requires 9 materialization invocations. Item fingerprints keep
the existing source/numeric-shop identity, and normalization happens in this stage.

After materialization, server-owned work is separate:

| Stage | Work per invocation |
| --- | --- |
| `reconcile_shops` | At most `SNAPSHOT_RECONCILE_BATCH_SIZE` absent shops |
| `reconcile_listings` | At most that many missing/expired candidates; state and inferred event commit together |
| `publish_hashes` | At most that many shop hashes and baseline markers |
| `finalize` | One source row and one snapshot state row |

The server batch setting defaults to 200 and is deployment-configurable. Each
stage has an empty-page transition invocation, so no final request drains a loop.
SQL runs on MySQL; the Worker only receives the current part or candidate page.
Content hashes are never overwritten by snapshot IDs. Shops awaiting their second
missing observation keep their content hash invalidated until that check finishes.

Delta and heartbeat retain synchronous behavior, serialized with each full chunk
by a source row lock. Newer listing observations take precedence over an older full,
while old full items absent from a newer partial delta still initialize correctly.
Heartbeats do not invalidate inventory. Close/reopen epochs and newer completed
inventories prevent obsolete full contents from returning.
Each chunk's market mutations and cursor commit atomically. Expired leases can be
reclaimed; generation/token checks reject duplicate or superseded work.
The source retains `active_full_snapshot_id` across chunks, so two full pipelines
cannot interleave even when an older snapshot arrives late or is repaired.

## Queue operation estimate

Messages contain only `sourceId`, `snapshotId`, and `generation`, not 115KB payloads.
A successful small message costs approximately three Queue operations: write,
read, delete. Retries, ambiguous sends, and other applications on the account add
cost. Batching does not reduce billable operations. Daily reservations default to
9,000 operations (`SNAPSHOT_QUEUE_DAILY_BUDGET`); this is a conservative local
admission estimate, not Cloudflare's account-wide meter or a hard quota guarantee.

For P client parts, S present shops, L missing/expired listing candidates, A absent
shops, and server reconciliation page size B, the current implementation uses:

`messages = P + ceil(L/B) + ceil(A/B) + ceil(S/B) + 5`

The five fixed invocations are four empty-page stage transitions and finalization.
Receipts other than the final part enqueue nothing. Cleanup uses Cron, not Queue.
At P=9, S=500, B=200 and approximately 58 full snapshots/day:

| Scenario | Messages/full | Operations/day |
| --- | ---: | ---: |
| New or unchanged shops; no absent candidates | 17 | 2,958 |
| 500 missing listing candidates | 20 | 3,480 |
| 5,000 missing listing candidates | 42 | 7,308 |
| 500 old shops disappear, 500 new shops replace them, 5,000 old listings expire | 45 | 7,830 |

Changed items already supplied in the part are handled by materialization, and
do not each create reconciliation messages. Larger historical listing populations
can increase L beyond 5,000. Reducing client parts to 20 shops means approximately
P=25 and adds 16 messages/full: the unchanged case becomes 5,742 operations/day;
the 5,000-missing case becomes 10,092 operations/day. The limit of 64 parts is not a
promise that every workload at 64 parts fits the free daily Queue allowance.

Without Queue or after budget exhaustion, the once-per-minute recovery Cron
processes one chunk. It can process at most 1,440 chunks/day and is a recovery
mechanism with finite capacity: a sustained backlog above that rate cannot catch
up using Cron alone. Queue remains the normal transport for this workload.

## CPU verification

The 2026-09-30 optimization keeps protocol v2, canonical payload/identity hashes,
ordered acknowledgements, and transaction boundaries unchanged. Accessor objects
and arrays with custom iterators use the reference parser. Successful JSON
uploads use a specialized linear parser; unsupported or invalid inputs still use
the retained Zod schema for the same validation issues. The POST upload entry skips
Hono route registration and unrelated services. Full receipt binds only identity
hashes and shop IDs, excluding unused canonical strings. A 1,024-entry FIFO cache
reuses pure identity calculations, includes every raw identity field and source ID,
and stores no sockets, database handles, authentication state, or market state.
Cold/missed/evicted cache entries calculate the same identity as before.

The benchmark now exercises validation and the **current async HTTP receipt**,
including duplicates and last-part dispatch. Run:

```sh
pnpm exec vite-node --config vitest.config.ts scripts/benchmark-upload-cpu.mjs
# Optional: BENCHMARK_ITERATIONS=100 BENCHMARK_ROUNDS=5
```

The same harness was run serially on baseline `ff17fa0` and the optimized branch,
with Node v24.19.0, 30 warm-up invocations, five rounds of 100 requests, and median
per-request process CPU (user + system). Bodies stay within the 512 KiB limit.
Measured requests contain 10–50 shops, 100–2,000 items, and 200–10,000 options.

| Body bytes / shape | Validation before → after | New receipt, warm before → after | New receipt, miss before → after |
| --- | ---: | ---: | ---: |
| 20,036 / 10 shops, 100 items, 200 options | 0.367 → 0.080 ms | 1.900 → 0.620 ms | 1.657 → 0.796 ms |
| 75,316 / 20 shops, 400 items, 800 options | 1.228 → 0.293 ms | 3.361 → 1.417 ms | 3.366 → 1.827 ms |
| 365,056 / 50 shops, 2,000 items, 4,000 options | 6.381 → 1.289 ms | 15.196 → 6.291 ms | 15.688 → 7.224 ms |
| 381,336 / 10 shops, 500 items, 10,000 options | 5.948 → 1.464 ms | 14.515 → 5.837 ms | 13.725 → 6.150 ms |

`full-new` reuses the same authenticated source and shop identities. `full-new-cold`
changes the authenticated source every invocation to force cache misses; it is
not a cold-isolate/startup measurement. Duplicate receipt seeding is outside the
timed region. Duplicate and last-part CPU improved by 53–67% and 56–65%, respectively,
in these workloads. Full receipt SQL statement counts remain unchanged: nine for a
new part, three for a duplicate, and eleven for the synthetic last-part dispatch
case. Compact identity metadata saves approximately 220 bytes per shop in new-part
SQL bindings. Raw samples are in [the comparison data](benchmarks/2026-09-30-upload-cpu.json).

These are **comparative local Node measurements with synthetic storage**, excluding
mysql2 packet serialization, real MySQL execution, connection/TLS setup, production
tracing, and Cloudflare scheduling/accounting. They do not establish a 10 ms Worker
CPU bound. No MySQL integration run or production deployment was performed for
this optimization; MySQL integration tests require a configured test database.
The earlier async pipeline change was verified statically at the time it landed.

After deployment, compare Workers invocation CPU and `exceededCpu` for HTTP
receipt, each materialize part, each reconciliation stage, and finalization. Log
events `snapshot_chunk` include stage, generation, and processed count. Network
waiting time is not CPU time; application elapsed time cannot substitute for it.
Targets remain p95 below 6 ms and p99 below 8 ms, not measured production results.

If the remaining CPU is dominated by mysql2/TLS, measure statement/parameter costs
with a test MySQL instance before considering a transactional stored procedure.
The current PR deliberately adds no migration or connection reuse across Worker
invocations. If CPU scales with client body size, reduce client part size (external
OpenKore implementation) and separately tune `SNAPSHOT_RECONCILE_BATCH_SIZE` for
reconciliation, then recalculate Queue operations. Splitting one full part after
HTTP parsing cannot remove that invocation's parsing cost; the current protocol
also forbids duplicate canonical shops across parts.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/),
[Queue limits](https://developers.cloudflare.com/queues/platform/limits/).
