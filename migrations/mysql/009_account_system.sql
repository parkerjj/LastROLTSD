CREATE TABLE auth_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(254) NOT NULL,
  email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING_EMAIL',
  email_verified_at BIGINT UNSIGNED NULL,
  credential_version INT UNSIGNED NOT NULL DEFAULT 1,
  auth_version INT UNSIGNED NOT NULL DEFAULT 1,
  avatar_version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_users_email_normalized (email_normalized),
  CONSTRAINT chk_auth_users_status CHECK (status IN ('PENDING_EMAIL', 'ACTIVE', 'DISABLED'))
) ENGINE=InnoDB AUTO_INCREMENT=10000 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auth_credentials (
  user_id BIGINT UNSIGNED NOT NULL,
  scheme VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'hmac-sha256-v1',
  salt VARBINARY(16) NOT NULL,
  digest VARBINARY(32) NOT NULL,
  key_version VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id),
  INDEX idx_auth_credentials_key_version (key_version, user_id),
  CONSTRAINT fk_auth_credentials_user FOREIGN KEY (user_id) REFERENCES auth_users (id),
  CONSTRAINT chk_auth_credentials_scheme CHECK (scheme = 'hmac-sha256-v1'),
  CONSTRAINT chk_auth_credentials_salt_length CHECK (OCTET_LENGTH(salt) = 16),
  CONSTRAINT chk_auth_credentials_digest_length CHECK (OCTET_LENGTH(digest) = 32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auth_avatars (
  user_id BIGINT UNSIGNED NOT NULL,
  avatar_base64 TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_auth_avatars_user FOREIGN KEY (user_id) REFERENCES auth_users (id),
  CONSTRAINT chk_auth_avatars_base64_length CHECK (CHAR_LENGTH(avatar_base64) <= 43692)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auth_sessions (
  token_digest BINARY(32) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  credential_version INT UNSIGNED NOT NULL,
  auth_version INT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  last_seen_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  revoked_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (token_digest),
  INDEX idx_auth_sessions_user (user_id),
  INDEX idx_auth_sessions_expiry (expires_at, token_digest),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES auth_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auth_action_tokens (
  token_digest BINARY(32) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  purpose VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email_snapshot VARCHAR(254) NOT NULL,
  credential_version INT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  consumed_at BIGINT UNSIGNED NULL,
  revoked_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (token_digest),
  INDEX idx_auth_action_tokens_user_purpose (user_id, purpose),
  INDEX idx_auth_action_tokens_expiry (expires_at, token_digest),
  CONSTRAINT fk_auth_action_tokens_user FOREIGN KEY (user_id) REFERENCES auth_users (id),
  CONSTRAINT chk_auth_action_tokens_purpose CHECK (purpose IN ('VERIFY_EMAIL', 'RESET_PASSWORD'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auth_mail_outbox (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_digest BINARY(32) NULL,
  user_id BIGINT UNSIGNED NULL,
  purpose VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_ciphertext TEXT CHARACTER SET ascii COLLATE ascii_bin NULL,
  payload_iv VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payload_key_version VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  priority TINYINT UNSIGNED NOT NULL DEFAULT 1,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
  lease_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until BIGINT UNSIGNED NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at BIGINT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  first_attempt_at BIGINT UNSIGNED NULL,
  provider_message_id VARCHAR(191) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  INDEX idx_auth_mail_outbox_ready (state, priority, next_attempt_at, id),
  INDEX idx_auth_mail_outbox_lease (state, lease_until, id),
  INDEX idx_auth_mail_outbox_expiry (expires_at, id),
  INDEX idx_auth_mail_outbox_user_purpose (user_id, purpose, state, created_at, id),
  CONSTRAINT fk_auth_mail_outbox_user FOREIGN KEY (user_id) REFERENCES auth_users (id),
  CONSTRAINT chk_auth_mail_outbox_purpose CHECK (purpose IN ('VERIFY_EMAIL', 'RESET_PASSWORD', 'PASSWORD_CHANGED')),
  CONSTRAINT chk_auth_mail_outbox_state CHECK (state IN ('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'CANCELLED')),
  CONSTRAINT chk_auth_mail_outbox_priority CHECK (priority IN (0, 1)),
  CONSTRAINT chk_auth_mail_outbox_payload_pair CHECK ((payload_ciphertext IS NULL) = (payload_iv IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auth_security_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NULL,
  event VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_auth_security_events_created (created_at, id),
  CONSTRAINT fk_auth_security_events_user FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auth_rate_limits (
  scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  key_digest BINARY(32) NOT NULL,
  bucket_start BIGINT UNSIGNED NOT NULL,
  request_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_allowed_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (scope, key_digest, bucket_start),
  INDEX idx_auth_rate_limits_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
