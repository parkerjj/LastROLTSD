# Upload CPU and async full snapshots

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

No runtime benchmark or MySQL integration run was performed for the async change,
per the requested static-only verification scope. Type checking and static review
cannot establish a 10ms production CPU bound. In particular, moving a 115KB part
to Queue does not make its parsing, fingerprinting, or mysql2 serialization free.

After deployment, compare Workers invocation CPU and `exceededCpu` for HTTP
receipt, each materialize part, each reconciliation stage, and finalization. Log
events `snapshot_chunk` include stage, generation, and processed count. Network
waiting time is not CPU time; application elapsed time cannot substitute for it.
Targets remain p95 below 6ms and p99 below 8ms, not measured results. Reduce client
part size for materialization and `SNAPSHOT_RECONCILE_BATCH_SIZE` for reconciliation
when necessary, then recalculate Queue operations.

The existing `scripts/benchmark-upload-cpu.mjs` exercises the legacy synchronous
service with an in-memory repository. Its historical measurements are not evidence
for the production async pipeline; do not use it as an async acceptance benchmark.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/),
[Queue limits](https://developers.cloudflare.com/queues/platform/limits/).
