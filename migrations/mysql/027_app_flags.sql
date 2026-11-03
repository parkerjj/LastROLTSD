-- 027_app_flags.sql
-- 站点级功能开关（给客户端 App 读取）。目前只有 ios_engine：是否允许 iOS 客户端显示 KoreEngine 挂机界面，默认关闭。
-- 约定：时间戳 BIGINT UNSIGNED（毫秒 epoch）。开关只能由管理员接口（x-admin-secret）修改。

CREATE TABLE app_flags (
  flag_key VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (flag_key),
  CONSTRAINT chk_app_flags_enabled CHECK (enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 预置默认关闭的开关；可重复执行，不会覆盖已设置的值。
INSERT INTO app_flags (flag_key, enabled, updated_at)
VALUES ('ios_engine', 0, 0)
ON DUPLICATE KEY UPDATE flag_key = flag_key;
