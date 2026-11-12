-- 032_ke_death_reports.sql
-- 托管实例的死亡报告：core 在角色死亡时生成结构化报告并上传。
-- 列表/统计只读下面的索引列，完整报告（含原始日志）放在 report_json。
-- 保留：每个角色最近 100 条、且不超过 90 天（由托管 cron 清理）。
CREATE TABLE ke_death_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  hosted_instance_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nid INT UNSIGNED NOT NULL,
  aid INT UNSIGNED NOT NULL,
  cid INT UNSIGNED NOT NULL,
  report_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,   -- core 生成的报告 id，幂等去重
  died_at BIGINT UNSIGNED NOT NULL,
  map VARCHAR(32) CHARACTER SET ascii NOT NULL,
  killer_mob_id INT UNSIGNED NULL,
  killer_skill_id INT UNSIGNED NULL,
  killer_name VARCHAR(64) NOT NULL DEFAULT '',
  skill_name VARCHAR(64) NOT NULL DEFAULT '',
  cause VARCHAR(32) CHARACTER SET ascii NOT NULL,
  cause_label VARCHAR(32) NOT NULL DEFAULT '',
  fixes_total TINYINT UNSIGNED NOT NULL DEFAULT 0,
  fixes_applied TINYINT UNSIGNED NOT NULL DEFAULT 0,
  report_json MEDIUMTEXT NOT NULL,
  fixes_state_json TEXT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_death_instance_key (hosted_instance_id, report_key),
  INDEX idx_ke_death_char (user_id, nid, cid, died_at),
  INDEX idx_ke_death_instance (hosted_instance_id, died_at),
  INDEX idx_ke_death_time (died_at),
  CONSTRAINT fk_ke_death_instance FOREIGN KEY (hosted_instance_id) REFERENCES ke_hosted_instances (instance_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
