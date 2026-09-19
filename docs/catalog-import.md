# Static Item Catalog Import

The item catalog is authoritative server data. `item_id` is the only link from a listing to a catalog row; uploaded item names are compatibility input and are never used as catalog, display, fingerprint, or search authority. An unknown item ID remains a valid listing and is displayed as `未知物品 #<item_id>` until a later catalog release defines it.

The importer is offline and read-only for its inputs. It accepts one explicit file or one explicit directory, supports `id#name#`, JSON, JSONL, CSV, and TSV inputs, and validates duplicate IDs, empty names, invalid numeric IDs, separators, duplicate aliases, and alias/canonical-name collisions. Automatic encoding accepts UTF-8 or BOM-marked UTF-16; pass an explicit encoding when the input has no BOM and is not unambiguously UTF-8.

Generated SQL and the manifest contain only catalog data and checksums. They are written under `.generated\`, which is ignored by Git. Do not commit a production dictionary export.

## Validate Without Writing

```powershell
$ErrorActionPreference = 'Stop'
$inputFile = 'C:\path\to\catalog-items.txt'
pnpm catalog:import -- --input-file $inputFile --kind items --version catalog-2026-09-19 --encoding auto --output-dir .generated\catalog\catalog-2026-09-19 --dry-run
```

Dry-run prints the version, item and alias counts, input/data/output checksum summary, and error count. It does not create SQL or manifest files and does not modify the input.

## Generate A Release

```powershell
$ErrorActionPreference = 'Stop'
$inputDir = 'C:\path\to\catalog-release'
$outputDir = '.generated\catalog\catalog-2026-09-19'
pnpm catalog:import -- --input-dir $inputDir --kind items --version catalog-2026-09-19 --encoding utf8 --output-dir $outputDir
$manifest = Get-Content (Join-Path $outputDir 'catalog-items-catalog-2026-09-19.manifest.json') -Raw | ConvertFrom-Json
$manifest | Format-List dataVersion,inputChecksum,dataChecksum,outputChecksum,itemCount,aliasCount,errorCount
Get-FileHash (Join-Path $outputDir 'catalog-items-catalog-2026-09-19.sql') -Algorithm SHA256
```

The output is stably sorted by item ID and normalized alias. Re-running the same version and input produces byte-identical SQL and manifest files. The SQL uses bounded statements below 100 KiB and updates only submitted item IDs, their aliases, and their derived item search rows. It does not delete or rewrite listings.

## Apply Locally Or Remotely

Review the manifest and SQL before applying it. The migration must already be applied in the target D1 database.

```powershell
$ErrorActionPreference = 'Stop'
$sqlFile = '.generated\catalog\catalog-2026-09-19\catalog-items-catalog-2026-09-19.sql'
pnpm exec wrangler d1 execute lastroweb-local --local --file $sqlFile
```

For a production release, use the already reviewed production config and an explicit maintenance approval:

```powershell
$ErrorActionPreference = 'Stop'
$sqlFile = '.generated\catalog\catalog-2026-09-19\catalog-items-catalog-2026-09-19.sql'
pnpm exec wrangler d1 execute lastroweb-production --remote --env production --config wrangler.production.local.toml --file $sqlFile
```

The transaction updates `catalog_versions` and `catalog_state` only after the catalog rows and derived indexes are written. Reapplying the same version is idempotent. A later version can rename an existing item without another market upload.

## Inspect And Roll Back

```powershell
$ErrorActionPreference = 'Stop'
pnpm exec wrangler d1 execute lastroweb-local --local --command "SELECT current_version FROM catalog_state WHERE id = 1; SELECT item_id,canonical_name_zh,data_version FROM item_catalog ORDER BY item_id LIMIT 20;"
```

Keep the reviewed SQL and manifest for every deployed version outside Git. To roll back a bad release, stop further catalog imports, restore the previously reviewed catalog SQL release in a controlled maintenance window, and then verify `catalog_state.current_version`, item names, aliases, and listing counts. Do not delete or rewrite migrations, and do not reset the database. A Worker rollback alone does not roll back catalog data already committed to D1.
