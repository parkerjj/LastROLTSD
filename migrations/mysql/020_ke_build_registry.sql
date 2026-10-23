-- 首次可信登记才开启数据库白名单，之后绝不因构建表清空而自动关闭。
CREATE TABLE ke_build_policy (
  id TINYINT UNSIGNED NOT NULL,
  enforced TINYINT UNSIGNED NOT NULL DEFAULT 0,
  enabled_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  CONSTRAINT ck_ke_build_policy_id CHECK (id = 1),
  CONSTRAINT ck_ke_build_policy_enforced CHECK (enforced IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO ke_build_policy (id, enforced, enabled_at) VALUES (1, 0, NULL);

CREATE TABLE ke_builds (
  build_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  core_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  commit_sha CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  package_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  engine_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_tag VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  core_key_version INT UNSIGNED NOT NULL,
  publisher_run_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  publisher_run_attempt VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  publisher_jti_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVE',
  created_at BIGINT UNSIGNED NOT NULL,
  revoked_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (build_id),
  UNIQUE KEY uq_ke_build_publisher_run (publisher_run_id, publisher_run_attempt),
  UNIQUE KEY uq_ke_build_release_tag (release_tag),
  CONSTRAINT ck_ke_build_status CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT ck_ke_build_key_version CHECK (core_key_version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
