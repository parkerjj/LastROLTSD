-- 014_ke_profile_text_columns.sql
-- 013 的 4 个 control 文件列为 TEXT（上限 64 KB），而应用层/请求体上限是 512 KiB：
-- 例如全物品的 pickupitems.txt 可能超过 64 KB，会在严格模式下报 Data too long。统一放宽为 MEDIUMTEXT。

ALTER TABLE ke_profiles
  MODIFY COLUMN mon_control MEDIUMTEXT NULL,
  MODIFY COLUMN pickupitems MEDIUMTEXT NULL,
  MODIFY COLUMN items_control MEDIUMTEXT NULL,
  MODIFY COLUMN timeouts MEDIUMTEXT NULL;
