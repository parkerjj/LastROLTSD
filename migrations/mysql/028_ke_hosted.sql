-- 028_ke_hosted.sql
-- Linux 离线挂机（服务器托管）。设计见 KoreEngine 仓库 docs/linux-hosting-design.md。
-- 约定：时间戳 BIGINT UNSIGNED（毫秒 epoch）。

-- 被踢原因（heartbeat 返回 409 KE_INSTANCE_KICKED 时带给客户端）：quota_kick / character_takeover / quota_shrunk。
ALTER TABLE ke_instances ADD COLUMN kick_reason VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER kicked_by_instance_id;

-- I14：半自动与自动一样占额度；服务端不再有“不占额度”的模式。既有 manual 行迁移为 auto。
UPDATE ke_instances SET mode = 'auto' WHERE mode <> 'auto';

-- 托管服务器（每台 VPS 一个 ke-agent）。由运维脚本登记（scripts/ke-agent-register.mjs），没有 HTTP 创建接口。
CREATE TABLE ke_agents (
  agent_id CHAR(28) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,   -- agt_ + 24 位小写十六进制
  name VARCHAR(64) NOT NULL,
  pubkey BINARY(32) NOT NULL,                                          -- ed25519 公钥（请求签名）
  max_instances INT UNSIGNED NOT NULL,                                 -- 以服务端配置为准，不信任 agent 自报
  reserved INT UNSIGNED NOT NULL DEFAULT 0,                            -- 已预留名额（调度计数器，服务端自己计算）
  mem_available_mb INT UNSIGNED NULL,
  accepting TINYINT(1) NOT NULL DEFAULT 1,
  status VARCHAR(12) CHARACTER SET ascii NOT NULL DEFAULT 'online',    -- online / down / draining
  last_seen BIGINT UNSIGNED NULL,
  version VARCHAR(32) NULL,
  package_id VARCHAR(80) NULL,
  reject_until BIGINT UNSIGNED NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (agent_id),
  INDEX idx_ke_agents_status (status, last_seen),
  CONSTRAINT chk_ke_agents_status CHECK (status IN ('online', 'down', 'draining'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- agent 请求防重放：同一 agent 的 nonce 在窗口内只能用一次（cron 清理）。
CREATE TABLE ke_agent_nonces (
  agent_id CHAR(28) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seen_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (agent_id, nonce),
  INDEX idx_ke_agent_nonces_seen (seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin;

-- 游戏账号凭据：账号明文，密码可逆加密（AES-GCM，AAD 绑定 user/nid/aid/cid/key_version）。
CREATE TABLE ke_hosted_credentials (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  nid INT UNSIGNED NOT NULL,
  aid INT UNSIGNED NOT NULL,
  cid INT UNSIGNED NOT NULL,
  char_name VARCHAR(64) NOT NULL,
  game_account VARCHAR(128) NOT NULL,
  game_password_enc VARBINARY(512) NOT NULL,
  key_version INT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_hosted_credentials_char (user_id, nid, aid, cid),
  INDEX idx_ke_hosted_credentials_user (user_id),
  CONSTRAINT fk_ke_hosted_credentials_user FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 托管实例。instance_id 由 LTSD 在创建时生成并长期不变（重启/重登/故障转移都复用，不新增 ke_instances 行）。
CREATE TABLE ke_hosted_instances (
  instance_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  credential_id BIGINT UNSIGNED NOT NULL,
  nid INT UNSIGNED NOT NULL,
  aid INT UNSIGNED NOT NULL,
  cid INT UNSIGNED NOT NULL,
  desired VARCHAR(8) CHARACTER SET ascii NOT NULL DEFAULT 'stopped',   -- running / stopped
  phase VARCHAR(12) CHARACTER SET ascii NOT NULL DEFAULT 'stopped',    -- queued/assigned/starting/running/backoff/stopping/stopped/migrating/error
  assigned_agent CHAR(28) CHARACTER SET ascii COLLATE ascii_bin NULL,
  epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,                            -- 仅在归属变化时加 1
  launch_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,                       -- 同一 epoch 内每次 launch 加 1（服务端分配）
  stop_reason VARCHAR(32) CHARACTER SET ascii NULL,
  retry_at BIGINT UNSIGNED NULL,
  launch_commands VARCHAR(512) NOT NULL DEFAULT '["ai auto"]',
  -- desired=running 时为 'nid:aid:cid'，否则 NULL：唯一索引保证同一角色同时只有一个运行中的托管记录（防抢注/防双开，无竞态）。
  active_char_key VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_report_at BIGINT UNSIGNED NULL,
  migrating_since BIGINT UNSIGNED NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (instance_id),
  UNIQUE KEY uq_ke_hosted_credential (credential_id),
  UNIQUE KEY uq_ke_hosted_active_char (active_char_key),
  INDEX idx_ke_hosted_user (user_id),
  INDEX idx_ke_hosted_agent (assigned_agent, desired),
  INDEX idx_ke_hosted_queue (desired, phase),
  CONSTRAINT fk_ke_hosted_user FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ke_hosted_credential FOREIGN KEY (credential_id) REFERENCES ke_hosted_credentials (id) ON DELETE CASCADE,
  CONSTRAINT chk_ke_hosted_desired CHECK (desired IN ('running', 'stopped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 托管 token：绑定实例、epoch 与 launch_seq，独立于用户的 20 个设备 token，可随时吊销。
CREATE TABLE ke_hosted_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_digest BINARY(32) NOT NULL,
  instance_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  epoch BIGINT UNSIGNED NOT NULL,
  launch_seq BIGINT UNSIGNED NOT NULL,
  credential_version INT UNSIGNED NOT NULL,                            -- 签发时账号版本快照：改密码/登出全部后失效
  auth_version INT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  revoked_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_hosted_tokens_digest (token_digest),
  INDEX idx_ke_hosted_tokens_instance (instance_id, revoked_at),
  INDEX idx_ke_hosted_tokens_expiry (expires_at),
  CONSTRAINT fk_ke_hosted_tokens_instance FOREIGN KEY (instance_id) REFERENCES ke_hosted_instances (instance_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 监控台展示用的最新状态快照（core 随 heartbeat 上报，覆盖写，不留历史）。
CREATE TABLE ke_instance_status (
  instance_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status_json TEXT NOT NULL,                                   -- 应用层限制 ≤ 16KB
  status_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (instance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
