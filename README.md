# LastROWeb

LastROWeb is a Cloudflare Worker + Hono service with a D1-backed market upload API and a Vite query UI. The OpenKore adapter is maintained outside this repository; this project contains only the public HTTP contract and redacted fixtures.

## Local development

```text
pnpm install
pnpm --filter web build
pnpm test
pnpm playwright test
```

Run the Worker locally with `pnpm wrangler dev --local`; apply D1 migrations with `pnpm wrangler d1 migrations apply lastroweb-local --local`. No production database IDs, API keys, or player data belong in this repository.

## Entrypoints

- `POST /api/v1/market/upload` authenticated upload contract
- `GET /api/v1/market/search` current listing search
- `GET /api/v1/market/listings/:id/history` bounded price/quantity history
- `GET /api/v1/options` versioned option dictionary
- `GET /api/health` Worker and D1 health

See [docs/api.md](docs/api.md) and [docs/deployment.md](docs/deployment.md).
