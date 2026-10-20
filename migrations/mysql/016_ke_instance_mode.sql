-- 016_ke_instance_mode.sql
-- 实例的授权模式：auto（全自动，占实例额度）与 manual（半自动，需要授权但不占额度）。
-- 既有实例一律按 auto 处理，行为与之前完全一致。

ALTER TABLE ke_instances
  ADD COLUMN mode VARCHAR(8) NOT NULL DEFAULT 'auto' AFTER state,
  ADD CONSTRAINT chk_ke_instances_mode CHECK (mode IN ('auto', 'manual'));
