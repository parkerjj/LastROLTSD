# Search CPU optimization

The search GET fast path calls the shared search handler without rebuilding the
full Hono router. It uses native `node:crypto` SHA-256/HMAC with the existing
synchronous cursor API and byte-compatible signatures. The MySQL repository
validates each cursor before SQL, reuses the static option map, and appends option
results without repeatedly copying arrays. Each database connection pool remains
owned by one invocation and is closed before that invocation finishes.

## Edge cache

Only successful public GET search responses are stored in `caches.default` for
30 seconds. A hit bypasses MySQL, result assembly, and cursor generation. Errors
and responses with `Set-Cookie` are not stored. Cache read/write failures fall
back to normal search. Writes use `waitUntil` when an execution context is
available. Cache hits get the current request ID, never the stored request ID.

The cache key retains the exact query string and origin and uses an HMAC namespace
for environment, build, database, signing key, option/index versions, and the
cache response version. No credentials appear in the cache URL. Increment
`CACHE_VERSION` in `apps/worker/src/middleware/search-cache.ts` when changing the
search response contract; deploy distinct `BUILD_VERSION` values for releases.

Requests with `Authorization`, `Range`, `Cache-Control: no-cache`,
`no-store`, `max-age=0`, or `Pragma: no-cache` bypass this cache. This includes
browsers explicitly requesting fresh data. Search ignores cookies and never
personalizes results, so analytics cookies do not bypass this public cache.
`X-Search-Cache` distinguishes HIT, MISS, and BYPASS; use it when assessing real
cache coverage. The Cache API is local to a
Cloudflare data center, so hits are not guaranteed across locations or eviction.
See the [Cloudflare Cache API documentation](https://developers.cloudflare.com/workers/runtime-apis/cache/).

## Local measurements

Measured on Node 24.21.0 on 2026-09-23, comparing the pre-change code at
`6f76693` with these search changes. The benchmark warms each case for 1,000
iterations and reports the median of seven thread-CPU samples. Cursor samples
use 20,000 iterations; request samples use 1,000. The fixture contains 21 listing
rows (20 returned), 80 option rows, and a signed next-page cursor.

| Scenario | Before CPU ms | After CPU ms | Reduction |
| --- | ---: | ---: | ---: |
| Context hash + cursor sign + verify | 0.0219 | 0.01255 | 43% |
| First page, cache bypassed | 0.125 | 0.063 | 50% |
| Next page, cache bypassed | 0.141 | 0.093 | 34% |
| Repeated first page, cache enabled | 0.109 | 0.031 | 72% |

The benchmark runs the production fetch handler and repository against synthetic
database and cache boundaries. It excludes real TCP/TLS/authentication, MySQL
packet parsing, Cloudflare Cache API costs, and production cold-start/GC effects.
It is an application CPU comparison, not an edge CPU measurement. In particular,
a 50% local reduction does **not** establish that a 12 ms production request will
become 6 ms. Cache hits eliminate both SQL queries in this fixture; misses still
perform two queries. The SQL driver execution mode remains unchanged because
there is no measured evidence yet for replacing prepared statements.

Run from the repository root:

```powershell
pnpm exec vitest run apps/worker/test/search-cache.test.ts apps/worker/test/cursor-compatibility.test.ts apps/worker/test/search.test.ts
node scripts/benchmark-search-cpu.mjs .generated/benchmarks/search-current.json
node scripts/verify-search-worker.mjs
```

The smoke script uses local workerd with the real Cache API and native crypto,
and a synthetic SQL driver. It verifies search results/options, signed pagination,
cache hits without SQL, fresh request IDs, and rejection of mismatched cursors.
It does not connect to any database or deploy anything.

## Production validation

Compare invocation CPU distributions separately for HIT, MISS, and BYPASS,
including first requests and next-page requests. Track p50/p95/p99 and
`exceededCpu` counts; request `elapsed_ms` is wall time, not CPU time.
Avoid a production load test. A 70-90% CPU reduction on hits is an initial
planning estimate, not a measured guarantee. There is no defensible production
millisecond estimate for misses until driver/runtime CPU is profiled.

Average CPU depends on coverage: `hit_rate * hit_cpu + (1 - hit_rate) * miss_cpu`.
For illustration only, an 80% hit rate, 2 ms hits, and 12 ms misses would average
4 ms (67% less than 12 ms); misses could still exceed a 10 ms limit. Raising an
eligible plan's CPU limit is an independent operational decision.
