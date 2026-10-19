ALTER TABLE auth_users
  ADD COLUMN permission_level TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER status
  COMMENT '账号等级：0 萌新 / 1 正式（邮箱已验证）/ 2 赞助 / >=100 管理员';

-- 存量数据回填：新增列对所有既有行默认 0（萌新用户），而已通过邮箱验证的存量账号
-- 不会再走 markEmailVerified（其 WHERE 条件 status = 'PENDING_EMAIL' AND
-- email_verified_at IS NULL，是唯一把 permission_level 由 0 升为 1 的代码路径），不回填的话
-- 这些已验证用户的新留言/回复会被一直标成「萌新用户」。只把 0 升为 1，不动赞助(2)/管理员(100)。
UPDATE auth_users
  SET permission_level = 1
  WHERE permission_level = 0 AND status = 'ACTIVE' AND email_verified_at IS NOT NULL;

ALTER TABLE guestbook_entries
  ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id,
  ADD COLUMN edited_at BIGINT UNSIGNED NULL AFTER created_at,
  ADD INDEX idx_guestbook_entries_user (user_id, created_at DESC, id DESC),
  ADD CONSTRAINT fk_guestbook_entries_user FOREIGN KEY (user_id) REFERENCES auth_users (id),
  DROP CHECK chk_guestbook_category_fields,
  ADD CONSTRAINT chk_guestbook_category_fields CHECK (
    (category = 'suggestion' AND item_id IS NULL AND is_zeny = 0 AND contact IS NULL AND expires_at IS NULL)
    OR (category IN ('buy', 'sell') AND ((is_zeny = 1 AND item_id IS NULL) OR (is_zeny = 0 AND item_id IS NOT NULL)))
  );

CREATE TABLE IF NOT EXISTS guestbook_replies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entry_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  content TEXT NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  edited_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_guestbook_replies_entry_user (entry_id, user_id),
  INDEX idx_guestbook_replies_entry (entry_id, created_at, id),
  CONSTRAINT fk_guestbook_replies_entry FOREIGN KEY (entry_id) REFERENCES guestbook_entries (id) ON DELETE CASCADE,
  CONSTRAINT fk_guestbook_replies_user FOREIGN KEY (user_id) REFERENCES auth_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
