# Static Item Catalog Import

The item catalog is authoritative server data. `item_id` is the only link from a listing to a catalog row; uploaded item names are compatibility input and are never used as catalog, display, fingerprint, or search authority. An unknown item ID remains a valid listing and is displayed as `未知物品 #<item_id>` until a later catalog release defines it.

## Database Shape

The authoritative item table is `item_catalog`. It has one row per known item:

```sql
CREATE TABLE item_catalog (
  item_id INTEGER PRIMARY KEY,
  canonical_name_zh TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Aliases are kept separately and connected by `item_id`. `UNIQUE(alias_normalized)` prevents one alias from silently belonging to two items. `catalog_versions` records checksums and row counts for each release, while the single-row `catalog_state` table records the active version. `item_search_fts` and `search_short_tokens` are derived search structures; they can be rebuilt from the catalog release and are not a replacement for `item_catalog`.

`listings.item_id` deliberately has no foreign key to `item_catalog`: an unknown item ID must remain uploadable. Catalog updates therefore never delete listings, and a later release can fill in or rename an item without another market upload.

The importer is offline and read-only for its inputs. The normal LastROWeb source is the OpenKore table pair `items.txt` and `itemsdescriptions.txt`: the first contains `id#name#` records and the second contains multiline `id# ... #` description blocks. Both paths are supplied explicitly; the importer does not depend on or write to an OpenKore checkout. It also accepts one explicit file or one explicit directory, supports JSON, JSONL, CSV, and TSV item inputs, and validates duplicate IDs, empty names, invalid numeric IDs, separators, duplicate aliases, and alias/canonical-name collisions. Automatic encoding accepts UTF-8 or BOM-marked UTF-16; pass an explicit encoding when the input has no BOM and is not unambiguously UTF-8.

Use `--input-dir` only when a release intentionally combines multiple item-name input files. A description table remains an explicit `--description-file`, so unrelated files in the directory are never guessed or parsed as descriptions.

Generated SQL and the manifest contain only catalog data and checksums. They are written under `.generated\`, which is ignored by Git. Do not commit a production dictionary export.

## Validate Without Writing

```powershell
$ErrorActionPreference = 'Stop'
$openKoreTables = 'C:\path\to\openkore\tables\Lastro-zh_CN'
$inputFile = Join-Path $openKoreTables 'items.txt'
$descriptionFile = Join-Path $openKoreTables 'itemsdescriptions.txt'
pnpm catalog:import -- --input-file $inputFile --description-file $descriptionFile --kind items --version catalog-2026-09-19 --encoding auto --description-encoding auto --skip-empty-names --output-dir .generated\catalog\catalog-2026-09-19 --dry-run
```

Dry-run prints the version, item and alias counts, input/data/output checksum summary, and error count. It does not create SQL or manifest files and does not modify the input.

## Generate A Release

```powershell
$ErrorActionPreference = 'Stop'
$openKoreTables = 'C:\path\to\openkore\tables\Lastro-zh_CN'
$inputFile = Join-Path $openKoreTables 'items.txt'
$descriptionFile = Join-Path $openKoreTables 'itemsdescriptions.txt'
$outputDir = '.generated\catalog\catalog-2026-09-19'
pnpm catalog:import -- --input-file $inputFile --description-file $descriptionFile --kind items --version catalog-2026-09-19 --encoding utf8 --description-encoding utf8 --skip-empty-names --output-dir $outputDir
$manifest = Get-Content (Join-Path $outputDir 'catalog-items-catalog-2026-09-19.manifest.json') -Raw | ConvertFrom-Json
$manifest | Format-List dataVersion,inputChecksum,dataChecksum,outputChecksum,itemCount,descriptionCount,descriptionRecordCount,descriptionDuplicateCount,aliasCount,errorCount,batchCount,statementCount,sqlBytes
foreach ($batchFile in $manifest.batchFiles) {
  Get-FileHash (Join-Path $outputDir $batchFile) -Algorithm SHA256
}
```

The output is stably sorted by item ID and normalized alias. Re-running the same version and input produces byte-identical SQL part files and manifest. The SQL uses bounded statements below 90 KiB, JSON1 for bulk token rows, and at most 256 catalog items per generated batch. A large release is a directory of bounded `.part-####.sql` files, not one INSERT per item and not one giant D1 invocation. The manifest `batchFiles` list is the only apply order. The SQL updates only submitted item IDs, their descriptions, aliases, and derived item search rows. It does not delete or rewrite listings.

## Apply Locally Or Remotely

Review the manifest and SQL before applying it. The migration must already be applied in the target D1 database.

```powershell
$ErrorActionPreference = 'Stop'
$releaseDir = '.generated\catalog\catalog-2026-09-19'
$manifest = Get-Content (Join-Path $releaseDir 'catalog-items-catalog-2026-09-19.manifest.json') -Raw | ConvertFrom-Json
foreach ($batchFile in $manifest.batchFiles) {
  pnpm exec wrangler d1 execute lastroweb-local --local --file (Join-Path $releaseDir $batchFile)
}
```

For a production release, use the already reviewed production config and an explicit maintenance approval:

```powershell
$ErrorActionPreference = 'Stop'
$releaseDir = '.generated\catalog\catalog-2026-09-19'
$manifest = Get-Content (Join-Path $releaseDir 'catalog-items-catalog-2026-09-19.manifest.json') -Raw | ConvertFrom-Json
foreach ($batchFile in $manifest.batchFiles) {
  pnpm exec wrangler d1 execute lastroweb-production --remote --env production --config wrangler.production.local.toml --file (Join-Path $releaseDir $batchFile)
}
```

The final batch updates `catalog_versions` and `catalog_state` after its catalog rows and derived indexes are written. If an apply is interrupted, rerun the complete `batchFiles` list from the beginning; every part is idempotent and the active version is only advanced by the final part. A later version can rename an existing item without another market upload.

## Inspect And Roll Back

```powershell
$ErrorActionPreference = 'Stop'
pnpm exec wrangler d1 execute lastroweb-local --local --command "SELECT current_version FROM catalog_state WHERE id = 1; SELECT item_id,canonical_name_zh,length(description) AS description_length,data_version FROM item_catalog ORDER BY item_id LIMIT 20; SELECT COUNT(*) AS listings FROM listings;"
```

Keep the reviewed SQL and manifest for every deployed version outside Git. To roll back a bad release, stop further catalog imports, restore the previously reviewed catalog SQL release in a controlled maintenance window, and then verify `catalog_state.current_version`, item names, aliases, and listing counts. Do not delete or rewrite migrations, and do not reset the database. A Worker rollback alone does not roll back catalog data already committed to D1.
