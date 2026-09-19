# Deployment runbook

LastROWeb deploys as one Cloudflare Worker with static Vite assets and a D1 database. Wrangler creates and deploys the Worker; do not create a separate Cloudflare Pages project and do not enable Cloudflare's native Git integration. GitHub Actions is the only automatic production deployment path.

## Prerequisites and local verification

Use Debian WSL2 with Node.js 22 and pnpm 11.19.0. From `/mnt/d/Development/LastROWeb`:

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm secrets:generate
pnpm wrangler d1 migrations apply lastroweb-local --local
pnpm --filter web build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:docs
pnpm exec playwright install --with-deps chromium webkit
pnpm playwright test
pnpm wrangler dev --local
```

Open the URL printed by Wrangler and verify `/api/health`. `pnpm dev` runs only Vite and is useful for UI work, but the Wrangler command is the production-shaped local server. The build intentionally runs before `pnpm test` because `apps/web/test/build.test.ts` verifies the generated SPA document.

`pnpm secrets:generate` creates `.dev.vars` and `.deployment-secrets.local`. Both are ignored by Git. It refuses to overwrite them unless `--force` is explicitly supplied; forcing rotation invalidates every previously distributed source key. Never paste either file into an issue, log, commit, or chat.

To exercise authenticated uploads locally, seed the generated local key hash after applying migrations:

```bash
set -a
. ./.dev.vars
set +a
export MARKET_SOURCE_ID='local-primary'
export MARKET_SOURCE_NAME='Local primary source'
export MARKET_SOURCE_API_KEY_SHA256="$UPLOAD_API_KEY_SHA256"
pnpm cf:source-seed -- --output source-seed.local.sql
pnpm exec wrangler d1 execute lastroweb-local --local --file source-seed.local.sql
```

Use `UPLOAD_API_KEY` from `.dev.vars` as the local Bearer token. The SQL file contains only its SHA-256 hash.

## One-time Cloudflare setup

Authenticate interactively from WSL for initial setup:

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 create lastroweb-production
```

Record the returned D1 UUID outside the repository. Render a temporary production config:

```bash
export CLOUDFLARE_D1_DATABASE_ID='<D1 UUID>'
pnpm cf:config -- --input wrangler.toml --output wrangler.production.local.toml --environment production
```

Apply migrations before seeding the source:

```bash
pnpm exec wrangler d1 migrations apply lastroweb-production \
  --remote --env production --config wrangler.production.local.toml
```

Load the generated deployment values without printing them, render an idempotent SQL seed containing only the hash, and apply it:

```bash
set -a
. ./.deployment-secrets.local
set +a
export MARKET_SOURCE_ID='primary'
export MARKET_SOURCE_NAME='Primary market source'
export MARKET_SOURCE_API_KEY_SHA256="$PRODUCTION_SOURCE_API_KEY_SHA256"
pnpm cf:source-seed -- --output source-seed.production.local.sql
pnpm exec wrangler d1 execute lastroweb-production --remote --env production \
  --config wrangler.production.local.toml --file source-seed.production.local.sql
```

Only `PRODUCTION_SOURCE_API_KEY` is given to the external uploader. The Worker authenticates it by comparing its SHA-256 hash with `market_sources.api_key_hash`; `UPLOAD_API_KEY` is not a Worker runtime binding.

Configure the two Worker secrets. These persist across normal deployments:

```bash
printf '%s' "$PRODUCTION_CURSOR_SECRET" | pnpm exec wrangler secret put CURSOR_SECRET \
  --env production --config wrangler.production.local.toml
printf '%s' "$PRODUCTION_ADMIN_SECRET" | pnpm exec wrangler secret put ADMIN_SECRET \
  --env production --config wrangler.production.local.toml
```

The cursor secret is mandatory in production. The admin secret enables the retention preview endpoint and should remain private.

## First manual deployment

```bash
pnpm --filter web build
pnpm exec wrangler deploy --env production --config wrangler.production.local.toml
```

Use the deployed URL returned by Wrangler:

```bash
curl -fsS 'https://<worker-host>/api/health'
curl -fsS 'https://<worker-host>/api/v1/market/search?limit=1'
```

Perform a redacted smoke upload using the documented fixture and the production source key only from a secure local shell. Never put the key on a command line that will be saved to shell history; prefer an environment variable and an `Authorization` header assembled by the shell.

## GitHub Actions automatic deployment

The repository workflow `.github/workflows/ci.yml` verifies pull requests and pushes to `main`. On a push to `main`, the `deploy-production` job runs only after lint, typecheck, unit/integration tests, documentation checks, web build, and Playwright pass. It then applies D1 migrations and deploys the Worker and assets.

Create a GitHub environment named `production`. Add these environment secrets:

- `CLOUDFLARE_API_TOKEN`: a scoped token with Account / Workers Scripts / Edit and Account / D1 / Edit for the selected account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.
- `CLOUDFLARE_D1_DATABASE_ID`: the UUID returned by `wrangler d1 create`.

No application key or Worker runtime secret is required in GitHub after the one-time Wrangler secret setup. Optionally add required reviewers to the GitHub `production` environment; this pauses the deploy job after verification until approved.

Pushes are intentionally not performed by setup scripts. Review and merge the deployment branch into `main`; the resulting `main` push triggers production deployment. Do not separately configure Cloudflare to watch the repository, because that would create a second competing deploy path.

## Staging

Repeat the same flow using `lastroweb-staging`, `--environment staging`, `--env staging`, and the `STAGING_*` generated values. Keep a separate D1 database and source API key. A staging deployment must pass the health, upload, search, history, and retention-preview smoke checks before production changes.

## Rollback and migration safety

Use Cloudflare Workers Deployments in the dashboard or Wrangler's version/deployment commands to promote a previously known-good Worker version. Record the deployed commit SHA and Cloudflare version for every release. A Worker rollback does not roll back D1 schema or data; use reviewed forward migrations for database correction. Never delete or rewrite a production migration after it has been applied.

Before schema changes or retention-policy changes, create and verify a D1 export. Retention defaults to 90 days for history and sold events and never deletes current listings. Longer retention or substantially higher upload volume requires a D1 quota and cost review.

## Custom domain

The initial `workers.dev` URL is sufficient. Add a custom domain later in the Cloudflare Worker settings after the first healthy deployment. A custom domain is routing configuration, not a separate Pages project.
