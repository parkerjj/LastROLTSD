# Deployment

Run `pnpm install`, `pnpm --filter web build`, and `pnpm wrangler d1 migrations apply lastroweb-local --local` for local validation. Staging and production bindings in `wrangler.toml` intentionally use placeholder database IDs; set real IDs with Wrangler configuration before deployment and store upload/admin keys as Worker secrets.
