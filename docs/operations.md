# Operations

Monitor Worker request metrics and D1 errors through Workers Logs. Metrics include request ID, route, status, elapsed time, byte count, and aggregate counts; bearer tokens, complete upload JSON, player identifiers, and coordinates are not logged.

The daily retention trigger deletes price history and sold events older than 90 days in bounded chunks. It never deletes current listings. For planning, this release assumes Cloudflare D1 Free's documented 5 million rows read/day, 100,000 rows written/day, and 5 GB storage allowance; verify the current account limits before enabling production volume. Before extending retention, reassess D1 free read/write/storage quotas and export long-lived data to R2 JSONL/CSV.

A source can be disabled independently. All shop, session, listing, and reconciliation queries include the authenticated source boundary; there is no global close-shop operation.

## Catalog Operations

Generate and inspect a release from the OpenKore `items.txt` and `itemsdescriptions.txt` files supplied by the operator. The importer never accesses the network, never writes its input, and writes production SQL only below the Git-ignored `.generated\` directory. All command examples in this runbook use PowerShell.

```powershell
$ErrorActionPreference = 'Stop'
$openKoreTables = 'C:\path\to\openkore\tables\Lastro-zh_CN'
$inputFile = Join-Path $openKoreTables 'items.txt'
$descriptionFile = Join-Path $openKoreTables 'itemsdescriptions.txt'
$outputDir = '.generated\catalog\catalog-2026-09-19'
pnpm catalog:import -- --input-file $inputFile --description-file $descriptionFile --kind items --version catalog-2026-09-19 --encoding utf8 --description-encoding utf8 --skip-empty-names --output-dir $outputDir --dry-run
pnpm catalog:import -- --input-file $inputFile --description-file $descriptionFile --kind items --version catalog-2026-09-19 --encoding utf8 --description-encoding utf8 --skip-empty-names --output-dir $outputDir
Get-Content (Join-Path $outputDir 'catalog-items-catalog-2026-09-19.manifest.json') -Raw | ConvertFrom-Json | Format-List dataVersion,inputChecksum,dataChecksum,outputChecksum,itemCount,descriptionCount,descriptionRecordCount,descriptionDuplicateCount,aliasCount,errorCount,batchCount,statementCount,sqlBytes
```

Apply every reviewed SQL part in the manifest order after the migration smoke check. Reapplying a version is idempotent and does not delete or rewrite listings.

```powershell
$ErrorActionPreference = 'Stop'
$releaseDir = '.generated\catalog\catalog-2026-09-19'
$manifest = Get-Content (Join-Path $releaseDir 'catalog-items-catalog-2026-09-19.manifest.json') -Raw | ConvertFrom-Json
foreach ($batchFile in $manifest.batchFiles) {
  pnpm exec wrangler d1 execute lastroweb-local --local --file (Join-Path $releaseDir $batchFile)
}
```

For rollback, retain each reviewed SQL/manifest pair outside Git, pause new imports, and apply the last known-good catalog release in a maintenance window. Verify the remote release through `catalog_state`, the matching `catalog_versions` counts and checksums, plus a small primary-key or indexed sample. Do not recount catalog, alias, search-token, or listing tables remotely. Never rewrite an applied migration or use a database reset as a catalog rollback.
