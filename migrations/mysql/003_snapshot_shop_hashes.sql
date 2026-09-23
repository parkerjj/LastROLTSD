ALTER TABLE upload_batches ADD COLUMN shop_hashes_json MEDIUMTEXT NULL;
UPDATE upload_batches SET shop_hashes_json = '[]' WHERE shop_hashes_json IS NULL;
ALTER TABLE upload_batches MODIFY shop_hashes_json MEDIUMTEXT NOT NULL;
ALTER TABLE upload_batches ADD CONSTRAINT chk_upload_batches_shop_hashes_json CHECK (JSON_VALID(shop_hashes_json));
