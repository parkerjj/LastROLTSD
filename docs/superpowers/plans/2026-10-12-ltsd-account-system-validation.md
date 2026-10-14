# LTSD account system validation ledger

This document records the completed local implementation and review evidence for Tasks 0–15. It does not approve a production release. The implementation base is `8a2155fcdd84d30193070c1bbca0defeeb28fbd7`; the branch is `feat/ltsd-account-system`. The whole-branch review and fresh scoped fix review passed after all three documentation findings were addressed. The local completion commit is recorded in the progress ledger and Git history.

The approved MySQL account design and prior rulings govern this work. The original README references were retained. The account specification and plan preserve their reviewed substance, with only the earlier minimal contract updates recorded in the progress ledger, including malformed UTF-16 password handling and Task 1–5 interface alignment. Task 15 did not edit the specification, plan, plan review, or manager-owned progress file.

## Task evidence

| Task | Commit | Actual checks and evidence | Skip and review status |
| --- | --- | --- | --- |
| 0 | `f22aaa9` | Baseline typecheck, migration tests, docs checks, and web build passed. `pnpm test` recorded 71 files passed / 3 skipped and 419 passed / 8 skipped. | Real MySQL was not configured at baseline. The progress ledger records 366 lint errors at `.generated/mysql-lock-fix/index.js`; its original raw lint log is unavailable, so that historical single-path detail cannot be independently reconciled. The Task 15 full lint run is reported below. Independent preflight Spec and quality review passed. |
| 1 | `3b18249` | 18 tests passed, 0 skipped; typecheck and targeted lint passed. The malformed lone-surrogate password collision found in review was rejected while valid Unicode stayed supported. | Initial Important finding fixed; scoped Spec and quality review passed. |
| 2 | `2c26a92` | 7 unit tests plus 1 real MySQL test passed, 0 skipped; all MySQL migrations were applied to an empty dedicated test database and the natural first account ID was verified as 10000. | Initial Important and Minor findings addressed; scoped review passed. |
| 3 | `8e16202` | 12 unit tests plus 1 real MySQL test passed, 0 skipped; typecheck and lint passed. | CSRF timing and error-envelope follow-up verified; fix review passed. |
| 4 | `e0fdc21` | 22 focused tests plus 2 real MySQL tests passed, 0 skipped; revocation and concurrency fault paths were exercised. | Scoped fix review passed. |
| 5 | `9fdf74b` | 39 focused tests plus 3 REQUIRE MySQL tests passed, 0 skipped. | Initial Important finding fixed; fresh scoped review passed. |
| 6 | `7c1b6f7` | 23 focused tests plus 4 REQUIRE MySQL tests passed, 0 skipped. | Scoped Spec and quality review passed. |
| 7 | `eac6440` | 42 focused tests; fix round added 12 focused tests plus 5 REQUIRE MySQL tests, all 0 skipped. | Verification/action race finding fixed; fresh scoped review passed. |
| 8 | `0c44a2a` | Fix round: 33 focused tests plus 6 REQUIRE MySQL tests, 0 skipped; two browser avatar fixtures were checked. | Three Important and two Minor findings addressed. VP8L browser-derived fixture evidence was completed later in Task 12. |
| 9 | `d5f8e17` | 30 targeted tests plus 92 auth/health checks, 0 skipped; typecheck, lint, and diff checks passed. | SQL was not rerun because this task made no SQL change. Scoped review passed. |
| 10 | `103db0d` | 12 focused tests, 0 skipped; typecheck, lint, and diff checks passed. | JSDOM checks were not presented as browser evidence. Scoped review passed. |
| 11 | `4384ea0` | Initial 28 focused tests; fix added 6 passing tests, 0 skipped; typecheck, lint, build, and diff checks passed. Fourteen local account SPA response paths were checked. | JSDOM is not a browser. Scoped review passed. |
| 12 | `d355e34` | Initial 22 focused tests and 20 fix tests, 0 skipped; typecheck, lint, build, and diff checks passed. Chrome 155 exercised synthetic account flows through the local Hono/MySQL bridge and browser avatar editor. | Local bridge is not the complete deployed Worker entry. No physical-phone or Free CPU evidence. I1/M1 fix review passed. |
| 13 | `272a47a` | 35 focused tests plus 7 complete REQUIRE MySQL tests, 0 skipped; preflight tests 5 passed / 0 skipped; typecheck, lint, 58 docs assertions, and diff checks passed. Cron cleanup was verified in bounded MySQL batches. | Workflow, deployed Cron, real mail, DNS, secrets, account quotas, and Cloudflare CPU were not run. Secret-publishing Important finding was fixed and scoped review passed. |
| 14 | `6768f86` | Two complete REQUIRE MySQL files: 10 passed / 0 skipped / exit 0 / 165.69 seconds. Typecheck, targeted lint, and diff checks passed. Chrome 155 checked synthetic local account behavior. | A filtered diagnostic run had 1 pass / 1 name-filter skip; it is not the full-suite result. Missing-URL REQUIRE rejection is a gate check, not a feature pass. Final scoped review was Spec PASS / Quality APPROVE. GitHub Actions was not run remotely. |
| 15 | Local completion commit (progress / Git history) | Node report-format test: 1 passed / 0 skipped. Local full Worker benchmark: 1 Vitest test passed / 0 skipped; 14 scenarios and 18 invocations (16 HTTP, 2 scheduled), using the dedicated MySQL 8.4.5 test database and fake mail fetch. Final all-repository gates are recorded below after execution. | Actual Cloudflare `cpuTimeMs`, production configuration, and cold-isolate confirmation remain unavailable. Whole-branch review found I1/M1/M2; Luna documentation fixes and fresh scoped Spec PASS / Quality APPROVE closed them. The maintenance SQL template was not executed. |

Task 14’s first completed race run after test expansion was 9 passed / 1 failed and was not counted as GREEN. The failure was a test fixture mismatch found before the RESET lock barrier. After correcting the fixture and releasing barriers on setup failure, the complete two-file REQUIRE run passed 10/10 with 0 skips. A separate missing-URL REQUIRE run failed closed as intended and did not substitute for the passing run.

## Task 15 local benchmark

The benchmark uses `default.fetch` for account HTTP routes, which builds the full Hono app and opens/closes a fresh MySQL database per invocation. Scheduled mail and cleanup use `default.scheduled`. Inputs are synthetic, the database helper resets only a dedicated `_test` schema, and the mail provider is replaced by a local fake fetch. The report formatter copies only fixed scenario names, runtime/environment/build metadata, sample counts, and numeric metrics; it never serializes request data or response bodies.

The “cold” sample is one first dynamic import of the Worker entry plus its first login request inside an already-started Vitest process. Its timer includes the module import, Worker invocation, MySQL close, and response-body read. It excludes Node/Vitest process startup and does not establish a cold Cloudflare isolate. Each “hot” HTTP invocation still creates and closes its own database pool; it does not reuse a global socket. Fixture creation and CSRF setup occur outside the timed samples.

| Scenario | Samples | Wall p99 / max (ms) | Local Node CPU p99 / max (ms) |
| --- | ---: | ---: | ---: |
| First Worker module import + login | 1 | 270.203 / 270.203 | 84.562 / 84.562 |
| Hot login | 5 | 32.953 / 32.953 | 8.523 / 8.523 |
| Profile update | 1 | 27.626 / 27.626 | 4.843 / 4.843 |
| Me | 1 | 3.292 / 3.292 | 5.549 / 5.549 |
| Refresh | 1 | 13.594 / 13.594 | 4.254 / 4.254 |
| Password-reset request | 1 | 33.593 / 33.593 | 5.777 / 5.777 |
| One mail send (scheduled) | 1 | 61.049 / 61.049 | 6.782 / 6.782 |
| Password-reset confirm | 1 | 34.769 / 34.769 | 13.172 / 13.172 |
| Valid 32 KiB WebP avatar | 1 | 54.523 / 54.523 | 12.631 / 12.631 |
| Password change | 1 | 34.388 / 34.388 | 6.060 / 6.060 |
| Register, 5 Unicode code points | 1 | 27.783 / 27.783 | 5.615 / 5.615 |
| Register, 256 Unicode code points | 1 | 29.001 / 29.001 | 4.645 / 4.645 |
| Reject 64 KiB + 1 body | 1 | 0.886 / 0.886 | 0.877 / 0.877 |
| Cleanup 50 expired sessions (scheduled) | 1 | 15.934 / 15.934 | 0.780 / 0.780 |

The cold Node module-load sample, reset-confirm, and 32 KiB avatar local CPU readings exceed 10 ms; hot-login local maximum is 8.523 ms. These are local risk signals, not Cloudflare CPU measurements and not proof that Workers Free exceeds its limit. The report sets every `remote_cpu_ms` to `null` and `production_budget` to `UNVERIFIED`. The module-import sample may include Vitest/Vite loader work. The loopback MySQL TLS setting was not confirmed and does not establish production TLS, Worker socket, or runtime-driver costs. Sample counts, especially the single-sample scenarios, are too small to estimate a stable local p99.

Raw benchmark output: `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-benchmark-20261014-final.log`. Earlier failed fixture diagnostics are retained in `task-15-benchmark-20261014-run1.log`, `task-15-benchmark-debug-run1.log`, and `task-15-benchmark-debug-run2.log`; the final diagnosis was that the avatar request reused a session after password change had correctly revoked it. The runner order was corrected without changing auth source or relaxing authorization.

## All-repository gates

The required commands are run after the Task 15 changes. The final `pnpm lint` result is separated from lint of repository source; no generated artifact or repository lint configuration was changed.

| Gate | Command outcome | Evidence and raw log |
| --- | --- | --- |
| Full lint | Exit 1; 366 errors / 0 warnings. This run has 122 errors each in `.generated/mysql-lock-fix/index.js`, `.generated/mysql-upload-fix/index.js`, and `.generated/mysql-worker-fix/index.js`. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-lint.log` |
| Source-only lint | Exit 0; no errors. Excluded `.generated/**` and `.superpowers/**` only for this command. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-source-lint-final.log` |
| Typecheck | Exit 0. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-typecheck-final.log` |
| Ordinary tests, final run | Exit 0; 93 files passed / 6 skipped; 552 tests passed / 19 skipped. The four MySQL gate variables were unset. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-tests-final.log` |
| Migration tests | Exit 0; 5 passed / 0 skipped. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-migration-final.log` |
| Documentation checks | Exit 0; 58 assertions passed after adding the AC evidence column. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-docs-ac-evidence.log` |
| Web build | Exit 0. Existing catalog dynamic/static import chunk warning remains. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-web-build.log` |
| Complete auth MySQL REQUIRE suites | Exit 0; 2 files passed / 0 skipped; 10 tests passed / 0 skipped; 178.26s. Test URL was injected by the existing local-only wrapper and was not printed. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-require-auth-mysql.log` |
| Formatter behavior test | 1 passed / 0 skipped. An earlier direct `node --test` run exited 0; the first final-gate capture wrapper itself returned 1 because zsh reserves the variable name `status`, but its saved TAP output also shows 1 passed / 0 skipped. No formatter code changed afterward. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-formatter.log` |
| Diff whitespace check | Exit 0; no whitespace diagnostics. | `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/task-15-gate-diff-check.log` |

The 6 skipped files in the final ordinary run were `auth-account-races.test.ts` (2 tests), `auth-account-flow.test.ts` (8), `mysql-upload-collation.test.ts` (6), `auth-worker-cpu-benchmark.test.ts` (1), `catalog-upload-search-flow.test.ts` (1), and `mysql-upload-session.test.ts` (1). The first ordinary `pnpm test` run before snapshot archival exited 1: 14 `.superpowers` original test copies failed to resolve stale relative imports (93 passed / 6 skipped files; 552 passed / 19 skipped tests). The manager renamed those 14 files to `.test.ts.snapshot`, preserving every byte and recording the path mapping in `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/test-snapshot-rename-map.md`; the final ordinary suite then passed as shown above. An initial multi-command capture also returned wrapper exit 1 because it attempted to assign zsh's read-only `status`; commands with ambiguous inner exit were recaptured individually. The formatter test's earlier direct exit-0 evidence is retained rather than rerunning it.

The two full auth MySQL REQUIRE suites must report 0 skipped; ordinary `pnpm test` may skip those suites when the dedicated database guards are absent. Local tests and CI configuration checks do not establish that GitHub Actions ran remotely.

## AUTH-01–11 and AC-01–29 traceability

| Capability | Acceptance IDs | Primary tasks |
| --- | --- | --- |
| AUTH-01 registration and initial account | AC-01/02/03/25 | 1/2/6/8/14 |
| AUTH-02 login | AC-08/09/26 | 1/3/4/14 |
| AUTH-03 logout and revocation | AC-10/29 | 4/10/14 |
| AUTH-04 email verification | AC-04/05/06/07 | 5/7/11/14 |
| AUTH-05 password change | AC-11 | 1/7/11/14 |
| AUTH-06 password recovery | AC-12/13 | 1/7/11/14 |
| AUTH-07/10 editable profile name | AC-21 | 8/10/11 |
| AUTH-08 site integration | AC-19/20 | 9/10/11/14 |
| AUTH-09 security, limits, and CPU | AC-15/16/17/18/28 | 1/3/9/13/14/15 |
| AUTH-11 avatar | AC-22/23/24 | 8/12/14/15 |
| Mail failure and quota behavior | AC-14/27 | 5/13/14 |
| Migration, rollback, and external conditions | AC-20/25/26 | 0/2/13/15 |

| Acceptance | Owning tasks from the plan | Actual evidence / limits |
| --- | --- | --- |
| AC-01 | 1/2/6/8/14 | `tests/integration/auth-account-flow.test.ts` exercises real MySQL registration, pending login, and verification with synthetic users and a fake provider. |
| AC-02 | 1/2/6/8/14 | `tests/integration/auth-account-races.test.ts` proves one committed account across two service callers; HTTP duplicate requests retain the shared cooldown, so the race is not claimed as two HTTP 202 responses. |
| AC-03 | 1/2/6/8/14 | The prior account flow compares reset-request responses for existing, missing, and disabled emails; Task14 did not repeat that endpoint matrix. |
| AC-04 | 5/7/11/14 | Prior flow checks GET scans without consuming and repeated confirmation; Task14 Chrome 155 confirms GET leaves the local synthetic action pending until POST. |
| AC-05 | 5/7/11/14 | Prior MySQL flow rejects wrong-user, wrong-purpose, expired, and stale-credential actions; Task14 did not repeat those parameter cases. |
| AC-06 | 5/7/11/14 | Prior flow covers recovery of a pre-registered account, rejection of an attacker-known password, and owner recovery; identities and delivery are synthetic. |
| AC-07 | 5/7/11/14 | Task7 source review and prior action-consumption flows cover reuse; two same-version VERIFY actions confirmed out of order remain untested dynamically. |
| AC-08 | 1/3/4/14 | `apps/worker/test/auth-session.test.ts` and prior auth flows cover session issuance; the Task14 race additionally rejects a login based on a stale credential snapshot. |
| AC-09 | 1/3/4/14 | Prior pending/disabled API and service tests plus the Task14 pending-login and disabled-refresh race cover these states; disabled is a test SQL fixture, not a public endpoint. |
| AC-10 | 4/10/14 | The real MySQL flow checks live session expiry and renewal without shortening it; sustained production activity was not measured. |
| AC-11 | 1/7/11/14 | Task14 fix1 real MySQL cases prove wrong-current-password immutability, same-password change, and one winner from two original-credential change attempts. |
| AC-12 | 1/7/11/14 | Prior recovery flow verifies old password, old session, and old action invalidation; Task14 did not repeat the entire recovery lifecycle. |
| AC-13 | 1/7/11/14 | `tests/integration/auth-account-races.test.ts` races consumers of one and two RESET actions and checks only one credential-version update per action race. |
| AC-14 | 5/13/14 | `apps/worker/test/auth-mail.test.ts` and MySQL service tests use fake providers for quota/failure handling; no real Resend account or delivery was used. |
| AC-15 | 1/3/9/13/14/15 | Task1 input/Unicode tests cover password validation, and Task15 `default.fetch` samples register 5 and 256 Unicode code points; Task15 is not a full input-boundary matrix. |
| AC-16 | 1/3/9/13/14/15 | Existing CSRF/security tests cover server rules; Task14 Chrome injects one CSRF 403 and observes no client replay, while the injected response is not a server-generated failure. |
| AC-17 | 1/3/9/13/14/15 | Existing MySQL rate-limit and Task5 multi-instance budget tests cover shared limits; Task14 and Task15 preserve those controls rather than bypassing them. |
| AC-18 | 1/3/9/13/14/15 | Existing cookie, no-store, and referrer tests plus Task14 Chrome confirm HttpOnly session behavior; external proxy/plugin inspection was not performed. |
| AC-19 | 9/10/11/14 | Task11 page variants and Task12 viewport/keyboard evidence are supplemented by Task14 local Chrome login and cross-tab flows; no physical phone or password-manager test was run. |
| AC-20 | 0/2/9/10/11/13/14 | Task14 migration/schema checks preserve market data and compare synthetic market/guestbook rows before and after auth flows; this is database evidence, not an HTTP snapshot comparison. |
| AC-21 | 8/10/11 | Prior profile API/input tests and the account flow cover profile updates; Task14 cross-tab sign-out clears the stale unsaved nickname draft. |
| AC-22 | 8/12/14/15 | Task12 browser output covers JPEG/PNG/WebP 256×256 conversion and Task14 browser evidence covers the page path; Task15 adds a valid 32 KiB WebP request. |
| AC-23 | 8/12/14/15 | Existing Worker avatar parser tests reject corrupt, animated, oversized, and wrong-dimension inputs; Task15 measures only the valid 32 KiB case. |
| AC-24 | 8/12/14/15 | Real MySQL avatar flow covers upload, replacement, deletion, and public image serving, with Task12 browser round-trip evidence; the public GET returns image data, not profile fields. |
| AC-25 | 1/2/6/8/14 | Task14 real MySQL race checks the first account ID `10000` and unique-email outcome; existing migration tests cover preserving existing IDs. |
| AC-26 | 1/3/4/13/14 | Task13 deployment-preflight and Worker HMAC tests cover local configuration logic; no GitHub secret injection or real key rotation was run. |
| AC-27 | 5/13/14 | Task14 real MySQL tests cover UTC daily-quota recovery, pending login, resend, and verification; monthly availability is Web source/Task11 evidence only, not a dynamic browser test. |
| AC-28 | 1/3/9/13/14/15 | Task15 runs 14 local full-entry scenarios and 18 invocations, but Node/Vite CPU is not Cloudflare `cpuTime`; remote CPU is null and the Free-tier gate remains `UNVERIFIED`. |
| AC-29 | 4/10/14 | Task14 real-client refresh/logout-all and refresh/deactivation races reject stale identity, and Chrome verifies cross-tab sign-out; these local results do not measure Cloudflare latency. |

Evidence boundaries carried forward: AC-07’s same-version, out-of-order verification links were not dynamically raced; AC-27’s monthly quota UI was sourced to Task 11 Web behavior and was not dynamically browser-tested in Task 14. AC-14/27 provider failure and daily-budget behavior has MySQL/service evidence, but no real Resend account or delivery test. Task 15 measures local full-entry behavior only.

The Spec §6/§10 maintenance requirement is documented in [account operations](../../operations.md#account-mail-and-cleanup) as a separately authorized, one-user transaction with same-transaction audit and durable session/action revocation. This ledger records the documentation boundary only; no production account maintenance was executed.

## Rulings recorded in order

The entries below summarize the 35 decisions in the manager-owned progress ledger. Each decision records its reason and the practical cost or risk; the persistent progress ledger remains authoritative.

| # | Decision, reason, and remaining cost/risk |
| ---: | --- |
| 1 | Follow the user’s MySQL feature branch over stale root notes prescribing D1/main; avoid an architecture switch or unintended deployment. |
| 2 | Execute the already reviewed plan with one Luna implementer and manager-owned commits; no worktree, model escalation, or Obsidian writeback was authorized. |
| 3 | Set `pnpm_config_prefer_symlinked_executables=false` for this exFAT checkout; local invocation only, no lockfile or CI change. |
| 4 | Add only the AES-GCM mail seal/open helpers needed to verify previous mail keys, with fixed UTF-8/AAD/IV contract; reuse them later without changing public APIs. |
| 5 | Reject lone UTF-16 surrogates because `TextEncoder` maps distinct malformed passwords to the same bytes; valid Unicode, emoji, spaces, and U+FFFD remain valid. |
| 6 | Add optional account mail budget settings and a fixed public zero-key budget namespace so configuration and quota reads share one policy; per-user rate keys stay secret-derived. |
| 7 | Carry the session token only in an internal authenticated identity so refresh can reissue the same cookie; repository identity and wire data retain only digests/established fields. |
| 8 | Keep cross-instance rate-limit and cooldown SQL in the shared repository transaction layer; no public response or storage format changed. |
| 9 | Add an optional injected clock to CSRF issue/assert while preserving existing call compatibility and default `Date.now`; enables deterministic time behavior. |
| 10 | Return session expiry with the indexed identity query and carry the request’s token internally; avoids another lookup or reading avatar bytes, with unchanged response JSON. |
| 11 | Require trusted `Origin` for logout writes even when logout is idempotent; no weaker browser write rule. |
| 12 | Freeze the exact encrypted mail body on the first provider attempt under lease/CAS; retries retain idempotent payload, and missing delivery config pauses rather than fabricates success. |
| 13 | Define a small optional `mailDelivery` config shape and exact action expiry inputs for later callers; missing sender/key pauses mail without breaking login. |
| 14 | Allow only a zero-value old-bucket row when a quota lock spans a UTC boundary, then release the stale lease; no attempt, budget, or send is granted, at cost of a cleanable row. |
| 15 | Prepare registration mail without predicting the auto-increment ID, then bind the real ID inside the registration transaction; no fake IDs or schema change. |
| 16 | Return a reset-changed user ID internally and clear a current cookie only for that same authenticated user; reset does not log in anonymously or clear another user’s session. |
| 17 | Add an optional request ID to profile/avatar audit calls and accept only bounded avatar version query values; preserves old internal callers and image-history behavior. |
| 18 | Keep existing production/staging environment validation strict; only map known account namespaces to stable account errors, without masking missing production secrets. |
| 19 | Coalesce cross-tab identity checks through a dirty flag and invalidate stale generations; a failed read does not automatically replay a write. |
| 20 | After a successful profile update, use the existing store reconciliation to refresh current account state because there is no safe profile-adopt API; this adds one intentional read. |
| 21 | Reject the suspected missing same-page re-login case after source review plus a JSDOM/in-memory probe showed the existing navigation handles it; no duplicate button or workaround was added. That ruling's evidence was not a browser check; Task 12's later Chrome run is separate. |
| 22 | Guard late identity responses with a local epoch and clear password drafts on identity change; no token storage or client-side authorization was introduced. |
| 23 | Start verification polling only after an accepted user request; stop on identity change, hidden page, quota, or leave, and never auto-resend. |
| 24 | Add only the real local SPA `_headers` paths; no Worker-first fallback or market cache change. |
| 25 | Keep the same-CSRF-token guard after refresh; independent API/store checks ruled out the suspected stale refresh race. |
| 26 | Use the bundled browser and an isolated temporary profile for local browser validation when the browser connector was unavailable; no user profile or edge claim. |
| 27 | Derive a VP8L lossless browser fixture from the actual editor output using the existing image tool; it is fixture evidence only, not a Worker codec. |
| 28 | Bind the default `AuthApi` fetch receiver while retaining explicitly injected fetch compatibility; fixes browser behavior without changing CSRF or server authority. |
| 29 | Add a Cron-specific claimed/cleaned/idle result so one tick sends at most one ready mail or performs one cleanup category; preserve compatibility and bounded batch size 50. |
| 30 | Require explicit opt-in plus trusted complete config before a workflow can enable auth; default false and skip empty secret writes. No workflow was run remotely. |
| 31 | Publish `AUTH_ENABLED=false` before secret rotation and only restore after a complete final mapping deploy; cost is a brief auth maintenance window. A failed/ambiguous final deploy may already be active, so verify remote state rather than trusting exit code. |
| 32 | Distinguish Task 14 service-level concurrent registration acceptance from HTTP behavior: shared 60-second cooldown can return 429 for one request; preserve rate limits and anonymous responses. |
| 33 | Bind AC-11 claims to the real MySQL behavior tests and retain exact AC-07/AC-27 gaps; one dynamic lifecycle/race test proves the password cases without a redundant matrix. |
| 34 | Rename the 14 manager-created `task-*-original-*.test.ts` review snapshots to `.test.ts.snapshot`, preserving each file byte-for-byte and recording the mapping; Vitest had discovered stale relative-import copies as failing tests. No test source or Vitest config changed; the cost is that historical review paths resolve through the rename map. |
| 35 | Keep the ignored local plan workspace containing original logs, browser evidence, reviews, and the safe test-env helper so referenced raw evidence remains available for user review; durable summaries and final review reports are in project docs. Cost: local ignored disk use and raw logs are not portable in Git. No user files are deleted; archived test snapshots retain non-test suffixes. |

## External conditions and remaining review

`AUTH_ENABLED` remains disabled by default. No Cloudflare production/staging deploy, remote secrets write, DNS change, Resend delivery, GitHub Actions run, or production database work was performed. The actual account Cron allowance, plan quota, DNS/domain verification, Resend account status, and Cloudflare `cpuTimeMs` remain unverified. The production Free CPU gate requires complete-invocation CPU evidence and the sampling/cold-state limits described in [operations](../../operations.md#account-cpu-verification).

Task 15 is locally complete. The entire implementation diff was independently reviewed; the single documentation fix wave closed I1/M1/M2 and passed fresh scoped review. See the [independent final review record](2026-10-12-ltsd-account-system-final-review.md) for the exact findings, fixes, and inherited evidence limits. The original full lint failure and all untested production conditions remain visible; local approval does not establish production readiness.

Manager closure verification: after adding final acceptance metadata and archiving the exact independent review reports, `pnpm test:docs` exited 0 with 58 assertions; `git diff --check` exited 0. Raw closure output is retained locally at `.superpowers/sdd/2026-10-12-ltsd-account-system-plan/scratch/final-manager-docs.log`. No unchanged code, database, benchmark, or browser suite was rerun.
