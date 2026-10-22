-- 017_ke_entitlements.sql
-- KE 权益流水：实例额度（resource = 'slots'）与可用模块（resource = 'module:<name>'）。
-- 只追加：有效值 = 在「当前时刻」starts_at <= now < expires_at 且 revoked_at IS NULL 的行按 resource 求和，
-- 过期自动失效，无需清理任务。quantity 可为负（管理员扣减）。永久权益 = 99 年（3122064000000 ms，与 ke/entitlements.ts 的 KE_PERMANENT_MS 一致）。
-- 约定：时间戳 BIGINT UNSIGNED（毫秒 epoch）；user_id 外键 auth_users.id。

CREATE TABLE ke_entitlements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  resource VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quantity INT NOT NULL,
  starts_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  source VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  note VARCHAR(200) NULL,
  revoked_at BIGINT UNSIGNED NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_entitlements_source (user_id, source, source_ref),
  INDEX idx_ke_entitlements_user_resource (user_id, resource, expires_at),
  CONSTRAINT fk_ke_entitlements_user FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ke_entitlements_actor FOREIGN KEY (actor_user_id) REFERENCES auth_users (id) ON DELETE SET NULL,
  CONSTRAINT chk_ke_entitlements_quantity CHECK (quantity <> 0),
  CONSTRAINT chk_ke_entitlements_window CHECK (expires_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 存量回填：每个已验证邮箱的用户补发「验证邮箱赠送」的两条 99 年权益（与新用户验证邮箱时的赠送完全一致）。
-- 幂等：可在部署后原样再执行一次，覆盖迁移与部署之间新验证的用户。
INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, created_at)
SELECT u.id, g.resource, 1, u.email_verified_at, u.email_verified_at + 3122064000000, 'signup', g.source_ref,
       CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS UNSIGNED)
FROM auth_users AS u
JOIN (
  SELECT 'slots' AS resource, 'email-verified:slots' AS source_ref
  UNION ALL
  SELECT 'module:core', 'email-verified:module:core'
) AS g
WHERE u.email_verified_at IS NOT NULL
ON DUPLICATE KEY UPDATE ke_entitlements.id = ke_entitlements.id;
