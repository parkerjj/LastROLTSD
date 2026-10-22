-- 018_admin_audit_log.sql
-- 管理员后台的操作审计：谁（actor）对哪个账号（target）做了什么（action），变更前后值 / 被删内容快照放在 detail（JSON）。
-- 操作者或目标账号被删除后记录仍保留（外键 SET NULL），不随账号级联删除。
-- 约定：时间戳 BIGINT UNSIGNED（毫秒 epoch）。

CREATE TABLE admin_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_user_id BIGINT UNSIGNED NULL,
  detail JSON NULL,
  request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_admin_audit_log_created (created_at, id),
  INDEX idx_admin_audit_log_target (target_user_id, id),
  CONSTRAINT fk_admin_audit_log_actor FOREIGN KEY (actor_user_id) REFERENCES auth_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_admin_audit_log_target FOREIGN KEY (target_user_id) REFERENCES auth_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
