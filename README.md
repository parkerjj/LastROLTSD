# LastROWeb

LastROWeb is a Cloudflare Worker + Hono service with a D1-backed market upload API and a Vite query UI. The OpenKore adapter is maintained outside this repository; this project contains only the public HTTP contract and redacted fixtures.

## Local development

```text
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
pnpm wrangler dev --local
```

Use the latest Node.js 24 release (`nvm install && nvm use`) and pnpm 11.19.0 for parity with CI. `pnpm dev` starts only the Vite UI; `pnpm wrangler dev --local` serves the Worker API and built Vite assets from one origin. Generated credentials are stored only in ignored local files. No production database IDs, API keys, or player data belong in this repository.

## Entrypoints

- `POST /api/v1/market/upload` authenticated upload contract
- `GET /api/v1/market/search` current listing search
- `GET /api/v1/market/listings/:id/history` bounded price/quantity history
- `GET /api/v1/options` versioned option dictionary
- `GET /api/health` Worker and D1 health

See [docs/api.md](docs/api.md) and [docs/deployment.md](docs/deployment.md).
