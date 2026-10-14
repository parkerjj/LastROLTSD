-- 010_card_small_icons_unify.sql
-- 卡片小图标统一为 RMS 通用卡面图。
-- 旧值来源：item_catalog 初始 CSV 对卡片行错误地用了 items/large/{id}.gif（与大图 URL 相同），
-- RMS 不存在 items/small/{id}.gif（全 404），只有通用 items/small/card.gif。
-- 对已是 card.gif 的行幂等跳过，仅修正其余卡片。
UPDATE item_catalog
SET icon_small = 'https://file5s.ratemyserver.net/items/small/card.gif'
WHERE type_code = 'Card'
  AND icon_small <> 'https://file5s.ratemyserver.net/items/small/card.gif';
