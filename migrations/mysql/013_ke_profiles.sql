-- 013_ke_profiles.sql
-- KoreEngine 配置 Profile 表：每个角色（aid+cid+nid）可多套配置，一套 active。
-- 存 config.txt + 4 个 control 文件的原文；「一角色一 active」由应用层事务保证。

CREATE TABLE ke_profiles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  aid INT UNSIGNED NOT NULL,
  cid INT UNSIGNED NOT NULL,
  nid INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  config_text MEDIUMTEXT NOT NULL,
  mon_control TEXT NULL,
  pickupitems TEXT NULL,
  items_control TEXT NULL,
  timeouts TEXT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_profiles_user_char_name (user_id, aid, cid, nid, name),
  INDEX idx_ke_profiles_user (user_id),
  INDEX idx_ke_profiles_active (aid, cid, nid, is_active),
  CONSTRAINT fk_ke_profiles_user FOREIGN KEY (user_id) REFERENCES auth_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
