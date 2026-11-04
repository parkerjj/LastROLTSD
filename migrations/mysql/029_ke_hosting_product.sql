-- 029_ke_hosting_product.sql
-- 离线挂机成为独立的付费功能：资源 module:hosting（50 元/月），购买时自动包含等时长的脱机版（standalone），
-- 由 ke/entitlements.ts 的 foldEntitlements 在生效模块里补上 standalone，不额外写赠送流水。
-- 约定：时间戳 BIGINT UNSIGNED（毫秒 epoch）。设计见 KoreEngine 仓库 docs/linux-hosting-design.md。

-- 1) 订单明细允许 module:hosting（商品键）。
ALTER TABLE commerce_order_items DROP CHECK chk_commerce_order_items_product;
ALTER TABLE commerce_order_items ADD CONSTRAINT chk_commerce_order_items_product
  CHECK (product_key IN ('slots', 'module:standalone', 'module:hosting'));

-- 2) 存量赠送：2026-11-05 00:00（UTC+8，即 1793808000000）之前已经购买过脱机功能的账号，
--    免费获得等量时长的离线挂机权限——对每条仍然有效（或尚未开始）的非 signup 脱机流水，复制同一个有效期窗口。
--    - 只复制 created_at 早于截止时刻的流水；已过期的不复制（没有可用价值）；被撤销的不复制。
--    - 账号当前脱机模块总和必须为正（管理员扣减后已无脱机功能的账号不赠送）。
--    - (user_id, source, source_ref) 唯一键保证幂等：可在部署后原样再执行一次，补上迁移与部署之间新增、
--      以及已赠送流水之后被延期的部分（取更晚的到期时间）。
INSERT INTO ke_entitlements (user_id, resource, quantity, starts_at, expires_at, source, source_ref, actor_user_id, note, created_at)
SELECT e.user_id, 'module:hosting', 1, e.starts_at, e.expires_at, 'grandfather', CONCAT('standalone:', e.id), NULL,
       '离线挂机赠送（2026-11-05 前已购买脱机功能）', CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS UNSIGNED)
FROM ke_entitlements AS e
WHERE e.resource = 'module:standalone'
  AND e.quantity > 0
  AND e.revoked_at IS NULL
  AND e.source <> 'signup'
  AND e.created_at < 1793808000000
  AND e.expires_at > CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS UNSIGNED)
  AND (
    SELECT COALESCE(SUM(x.quantity), 0)
    FROM ke_entitlements AS x
    WHERE x.user_id = e.user_id
      AND x.resource = 'module:standalone'
      AND x.revoked_at IS NULL
      AND x.starts_at <= CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS UNSIGNED)
      AND x.expires_at > CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS UNSIGNED)
  ) > 0
ON DUPLICATE KEY UPDATE expires_at = GREATEST(ke_entitlements.expires_at, VALUES(expires_at));
