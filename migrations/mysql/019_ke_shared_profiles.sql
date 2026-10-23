-- KE 配置大厅：不回填或发布既有个人配置；时间戳为毫秒 epoch。
CREATE TABLE ke_shared_profiles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  author_user_id BIGINT UNSIGNED NOT NULL,
  source_profile_id BIGINT UNSIGNED NULL,
  share_code CHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(64) NOT NULL,
  description TEXT NOT NULL,
  job_id INT UNSIGNED NULL,
  config_text MEDIUMTEXT NOT NULL,
  mon_control MEDIUMTEXT NULL,
  pickupitems MEDIUMTEXT NULL,
  items_control MEDIUMTEXT NULL,
  timeouts MEDIUMTEXT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  like_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  use_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_shared_source (source_profile_id),
  UNIQUE KEY uq_ke_shared_code (share_code),
  INDEX idx_ke_shared_author (author_user_id, id),
  INDEX idx_ke_shared_newest (status, created_at DESC, id DESC),
  INDEX idx_ke_shared_uses (status, use_count DESC, created_at DESC, id DESC),
  INDEX idx_ke_shared_likes (status, like_count DESC, created_at DESC, id DESC),
  INDEX idx_ke_shared_job_newest (status, job_id, created_at DESC, id DESC),
  INDEX idx_ke_shared_job_uses (status, job_id, use_count DESC, created_at DESC, id DESC),
  INDEX idx_ke_shared_job_likes (status, job_id, like_count DESC, created_at DESC, id DESC),
  CONSTRAINT ck_ke_shared_status CHECK (status IN ('PUBLISHED', 'WITHDRAWN')),
  CONSTRAINT fk_ke_shared_author FOREIGN KEY (author_user_id) REFERENCES auth_users (id),
  CONSTRAINT fk_ke_shared_source FOREIGN KEY (source_profile_id) REFERENCES ke_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ke_shared_profile_likes (
  shared_profile_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (shared_profile_id, user_id),
  CONSTRAINT fk_ke_shared_like_profile FOREIGN KEY (shared_profile_id) REFERENCES ke_shared_profiles (id),
  CONSTRAINT fk_ke_shared_like_user FOREIGN KEY (user_id) REFERENCES auth_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ke_shared_profile_uses (
  shared_profile_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (shared_profile_id, user_id),
  CONSTRAINT fk_ke_shared_use_profile FOREIGN KEY (shared_profile_id) REFERENCES ke_shared_profiles (id),
  CONSTRAINT fk_ke_shared_use_user FOREIGN KEY (user_id) REFERENCES auth_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ke_shared_profile_copies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  shared_profile_id BIGINT UNSIGNED NOT NULL,
  request_hash BINARY(32) NOT NULL,
  result_profile_id BIGINT UNSIGNED NOT NULL,
  result_name VARCHAR(64) NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ke_shared_copy_request (user_id, request_id),
  CONSTRAINT fk_ke_shared_copy_user FOREIGN KEY (user_id) REFERENCES auth_users (id),
  CONSTRAINT fk_ke_shared_copy_profile FOREIGN KEY (shared_profile_id) REFERENCES ke_shared_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
