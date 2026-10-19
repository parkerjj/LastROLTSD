-- 012_ke_system.sql
-- KoreEngine 授权系统基础表：角色注册表与活跃实例（许可租约）表。
-- 约定：时间戳 BIGINT UNSIGNED（毫秒 epoch）；user_id 外键 auth_users.id。

CREATE TABLE ke_characters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  aid INT UNSIGNED NOT NULL,
  cid INT UNSIGNED NOT NULL,
  nid INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  char_name VARCHAR(64) NOT NULL DEFAULT '',
  base_level INT UNSIGNED NULL,
  job_level INT UNSIGNED NULL,
  job_id INT UNSIGNED NULL,
  map_name VARCHAR(64) NULL,
  bound_at BIGINT UNSIGNED NULL,
  last_seen_at BIGINT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_characters_aid_cid_nid (aid, cid, nid),
  INDEX idx_ke_characters_user (user_id),
  CONSTRAINT fk_ke_characters_user FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ke_instances (
  instance_id CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  aid INT UNSIGNED NOT NULL,
  cid INT UNSIGNED NOT NULL,
  nid INT UNSIGNED NOT NULL,
  char_name VARCHAR(64) NULL,
  map_name VARCHAR(64) NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'IDLE',
  features JSON NULL,
  build_id VARCHAR(64) NULL,
  ip_hash BINARY(32) NULL,
  ua_hash BINARY(32) NULL,
  license_expires_at BIGINT UNSIGNED NULL,
  last_heartbeat_at BIGINT UNSIGNED NULL,
  started_at BIGINT UNSIGNED NULL,
  kicked_at BIGINT UNSIGNED NULL,
  kicked_by_instance_id CHAR(36) NULL,
  stopped_at BIGINT UNSIGNED NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (instance_id),
  INDEX idx_ke_instances_user_state (user_id, state, last_heartbeat_at),
  INDEX idx_ke_instances_char (aid, cid, nid),
  CONSTRAINT fk_ke_instances_user FOREIGN KEY (user_id) REFERENCES auth_users (id),
  CONSTRAINT chk_ke_instances_state CHECK (state IN ('IDLE', 'ACTIVE', 'KICKED', 'STOPPED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
