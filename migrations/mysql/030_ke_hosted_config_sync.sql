-- 030_ke_hosted_config_sync.sql
-- 托管实例“同步并重载配置”：用户在监控台点按钮时把序号加 1；agent 每次租约都会拿到它，
-- 发现比已交给子进程的序号大，就通知子进程从 LTSD 拉取最新配置并 reload all。
-- 序号只做“发生过几次点击”的计数，不保存任何配置内容。
ALTER TABLE ke_hosted_instances ADD COLUMN config_sync_seq BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER launch_seq;
