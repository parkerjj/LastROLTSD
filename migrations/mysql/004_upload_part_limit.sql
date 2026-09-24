ALTER TABLE upload_batches DROP CHECK chk_upload_batches_part_index;
ALTER TABLE upload_batches DROP CHECK chk_upload_batches_part_count;
ALTER TABLE upload_batches ADD CONSTRAINT chk_upload_batches_part_index CHECK (part_index BETWEEN 0 AND 63);
ALTER TABLE upload_batches ADD CONSTRAINT chk_upload_batches_part_count CHECK (part_count BETWEEN 1 AND 64);
