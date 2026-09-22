# Static Item Catalog Import

The item catalog is a static asset used by the Worker/UI build. It is not stored in MySQL, does not use D1, and does not alter listings. `item_id` remains the only link from an uploaded listing to a catalog record; unknown IDs use the deterministic fallback `未知物品 #<item_id>`.

The importer reads explicit OpenKore item and description files and writes deterministic UTF-8 JSON. Inputs are read-only. Do not commit operator-provided source files, generated production assets, or any credential.

## Validate and generate

```powershell
$ErrorActionPreference = 'Stop'
$openKoreTables = 'C:\path\to\openkore\tables\Lastro-zh_CN'
$inputFile = Join-Path $openKoreTables 'items.txt'
$descriptionFile = Join-Path $openKoreTables 'itemsdescriptions.txt'
$version = 'catalog-2026-09-22'
$outputFile = 'apps\web\public\catalog\items.json'
$descriptionOutputFile = 'apps\web\public\catalog\itemsdescriptions.json'
pnpm catalog:import -- --input-file $inputFile --description-file $descriptionFile --kind items --version $version --encoding auto --description-encoding auto --skip-empty-names --output-file $outputFile --description-output-file $descriptionOutputFile --dry-run
pnpm catalog:import -- --input-file $inputFile --description-file $descriptionFile --kind items --version $version --encoding auto --description-encoding auto --skip-empty-names --output-file $outputFile --description-output-file $descriptionOutputFile
pnpm --filter web build
```

Use `--input-dir` only when the release intentionally combines item-name sources. The importer accepts `id#name#` OpenKore records and validates duplicate IDs, empty names, aliases, and supported encodings. Its output is deterministic for the same input/version and includes the input and asset checksums in its summary.

## Release and rollback

Review the generated `items.json` and `itemsdescriptions.json`, commit only the intended static asset changes, then deploy the normal Worker/web build. To roll back, restore a reviewed prior JSON asset and redeploy; it does not require database SQL, does not delete listings, and does not alter market history.
