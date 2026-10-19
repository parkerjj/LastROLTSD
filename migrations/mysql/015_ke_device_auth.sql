-- 015_ke_device_auth.sql
-- KE 设备授权（RFC 8628 风格的 device flow）与 KE 专用 Bearer token。
-- KE 运行在 IWA（isolated-app://…），与 ltsd.ro 跨站，拿不到会话 cookie，因此改用独立 token。
-- token 与 device_code 只存 SHA-256 摘要；user_code 是给人看的短码，明文存放（10 分钟过期）。

CREATE TABLE ke_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_digest BINARY(32) NOT NULL,
  label VARCHAR(64) NOT NULL DEFAULT '',
  credential_version INT UNSIGNED NOT NULL,
  auth_version INT UNSIGNED NOT NULL,
  ip_hash BINARY(32) NULL,
  ua_hash BINARY(32) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  last_used_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  revoked_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_tokens_digest (token_digest),
  INDEX idx_ke_tokens_user (user_id, revoked_at, expires_at),
  INDEX idx_ke_tokens_expiry (expires_at),
  CONSTRAINT fk_ke_tokens_user FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ke_device_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_digest BINARY(32) NOT NULL,
  user_code CHAR(8) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  user_id BIGINT UNSIGNED NULL,
  label VARCHAR(64) NOT NULL DEFAULT '',
  ip_hash BINARY(32) NULL,
  ua_hash BINARY(32) NULL,
  last_polled_at BIGINT UNSIGNED NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_device_codes_digest (device_digest),
  UNIQUE KEY uq_ke_device_codes_user_code (user_code),
  INDEX idx_ke_device_codes_expiry (expires_at),
  CONSTRAINT fk_ke_device_codes_user FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE,
  CONSTRAINT chk_ke_device_codes_status CHECK (status IN ('PENDING', 'APPROVED', 'DENIED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
