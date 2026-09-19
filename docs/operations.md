# Operations

Monitor Worker request metrics and D1 errors through Workers Logs. Metrics include request ID, route, status, elapsed time, byte count, and aggregate counts; bearer tokens, complete upload JSON, player identifiers, and coordinates are not logged.

The daily retention trigger deletes price history and sold events older than 90 days in bounded chunks. It never deletes current listings. Before extending retention, reassess D1 free read/write/storage quotas and export long-lived data to R2 JSONL/CSV.

A source can be disabled independently. All shop, session, listing, and reconciliation queries include the authenticated source boundary; there is no global close-shop operation.

## Catalog Operations

Generate and inspect a release from an explicitly supplied file or directory. The importer never accesses the network, never writes its input, and writes production SQL only below the Git-ignored `.generated\` directory. All command examples in this runbook use PowerShell.

```powershell
$ErrorActionPreference = 'Stop'
$inputFile = 'C:\path\to\catalog-items.json'
$outputDir = '.generated\catalog\catalog-2026-09-19'
pnpm catalog:import -- --input-file $inputFile --kind items --version catalog-2026-09-19 --encoding utf8 --output-dir $outputDir --dry-run
pnpm catalog:import -- --input-file $inputFile --kind items --version catalog-2026-09-19 --encoding utf8 --output-dir $outputDir
Get-Content (Join-Path $outputDir 'catalog-items-catalog-2026-09-19.manifest.json') -Raw | ConvertFrom-Json | Format-List dataVersion,inputChecksum,dataChecksum,outputChecksum,itemCount,aliasCount,errorCount
```

Apply only the reviewed SQL file after the migration smoke check. Reapplying a version is idempotent and does not delete or rewrite listings.

```powershell
$ErrorActionPreference = 'Stop'
$sqlFile = '.generated\catalog\catalog-2026-09-19\catalog-items-catalog-2026-09-19.sql'
pnpm exec wrangler d1 execute lastroweb-local --local --file $sqlFile
```

For rollback, retain each reviewed SQL/manifest pair outside Git, pause new imports, apply the last known-good catalog release in a maintenance window, and verify `catalog_state`, catalog row counts, alias rows, and listing counts. Never rewrite an applied migration or use a database reset as a catalog rollback.
