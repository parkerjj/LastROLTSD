-- 021_ke_standalone_modules.sql
-- 脱机版（standalone）构建：同一次 GitHub release run 可以同时登记 web 与 standalone
-- 两个构建，因此唯一键加入 kind；旧行默认 'web'，现有鉴权与登记行为不变。
ALTER TABLE ke_builds
  ADD COLUMN kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'web' AFTER build_id,
  ADD COLUMN network_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER core_key_version,
  ADD COLUMN network_key_version INT UNSIGNED NULL AFTER network_sha256,
  ADD COLUMN standalone_package_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER network_key_version,
  DROP INDEX uq_ke_build_publisher_run,
  DROP INDEX uq_ke_build_release_tag,
  ADD UNIQUE KEY uq_ke_build_publisher_run_kind (publisher_run_id, publisher_run_attempt, kind),
  ADD UNIQUE KEY uq_ke_build_release_tag_kind (release_tag, kind),
  ADD CONSTRAINT ck_ke_build_kind CHECK (kind IN ('web', 'standalone')),
  ADD CONSTRAINT ck_ke_build_network_key_version CHECK (network_key_version IS NULL OR network_key_version > 0);
