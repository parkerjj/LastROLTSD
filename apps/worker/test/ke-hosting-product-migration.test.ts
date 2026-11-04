import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../../migrations/mysql/029_ke_hosting_product.sql', import.meta.url), 'utf8');

describe('迁移 029：离线挂机付费功能', () => {
  it('订单明细的商品键约束同时保留旧商品并加入 module:hosting', () => {
    expect(sql).toMatch(/DROP CHECK chk_commerce_order_items_product/u);
    expect(sql).toMatch(/product_key IN \('slots', 'module:standalone', 'module:hosting'\)/u);
  });

  it('存量赠送：截止时刻是 2026-11-05 00:00（UTC+8），只复制非 signup 的有效脱机流水，且幂等', () => {
    expect(new Date(1793808000000).toISOString()).toBe('2026-11-04T16:00:00.000Z');
    expect(sql).toContain('e.created_at < 1793808000000');
    expect(sql).toMatch(/e\.source <> 'signup'/u);
    expect(sql).toMatch(/e\.revoked_at IS NULL/u);
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/u);
    // source 列只有 VARCHAR(16)，source_ref 只有 VARCHAR(64)。
    expect('grandfather'.length).toBeLessThanOrEqual(16);
    expect(sql).toContain("'grandfather'");
  });

  it('没有“逗号写进 -- 注释”这类行内注释问题', () => {
    for (const line of sql.split('\n')) {
      const comment = line.indexOf('--');
      if (comment > 0) expect(line.slice(comment), line).not.toMatch(/,\s*$/u);
    }
  });
});
