-- 022_account_activity_log.sql
-- 账号操作日志：记录每次账号相关操作（注册、登录、改密、KE 绑定/启动、留言等）的明文 IP、归属地、ASN、浏览器指纹，
-- 供管理员后台排查多账号 / 小号关联。保留期 180 天，由定时任务按 created_at 清理；账号被删除时日志随之级联删除。
-- 约定：时间戳 BIGINT UNSIGNED（毫秒 epoch）；ascii 列使用 ascii_bin（与 009 / 018 一致）。

CREATE TABLE account_activity_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  event VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ip_net VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
  region VARCHAR(64) NULL,
  city VARCHAR(64) NULL,
  latitude DECIMAL(9, 6) NULL,
  longitude DECIMAL(9, 6) NULL,
  asn INT UNSIGNED NULL,
  as_org VARCHAR(128) NULL,
  is_hosting TINYINT(1) NOT NULL DEFAULT 0,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_agent VARCHAR(512) NULL,
  aid INT UNSIGNED NULL,
  cid INT UNSIGNED NULL,
  nid INT UNSIGNED NULL,
  ref VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'live',
  request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_account_activity_user_time (user_id, created_at),
  INDEX idx_account_activity_ip_net (ip_net, user_id),
  INDEX idx_account_activity_device (device_id, user_id),
  INDEX idx_account_activity_fingerprint (fingerprint, user_id),
  INDEX idx_account_activity_aid (aid),
  INDEX idx_account_activity_ref (ref, created_at),
  INDEX idx_account_activity_created (created_at),
  CONSTRAINT fk_account_activity_user FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE,
  CONSTRAINT chk_account_activity_result CHECK (result IN ('SUCCESS', 'FAILURE')),
  CONSTRAINT chk_account_activity_source CHECK (source IN ('live', 'backfill'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
