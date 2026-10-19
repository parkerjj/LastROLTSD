import { describe, expect, it } from 'vitest';
import { BLOCK_DEFS, CONFIG_SCALARS, emptyDoc, parseConfig, serializeConfig } from '../src/ke-schema';

describe('ke config schema', () => {
  it('serializeConfig 只输出有值的标量，格式为 "key value"', () => {
    const doc = emptyDoc();
    doc.scalars = { lockMap: 'prt_fild08', attackAuto: '2', route_randomWalk: '1' };
    const text = serializeConfig(doc);
    expect(text).toBe('attackAuto 2\nlockMap prt_fild08\nroute_randomWalk 1\n');
  });

  it('parseConfig 提取标量，忽略注释/空行/未知 block', () => {
    const text = [
      '# 注释',
      'lockMap prt_fild08',
      'attackAuto 2',
      'unknownBlock {',
      'foo bar',
      '}',
      'unknownKey 123',
    ].join('\n');
    const doc = parseConfig(text);
    expect(doc.scalars).toEqual({ lockMap: 'prt_fild08', attackAuto: '2' });
    expect(doc.blocks).toEqual({});
  });

  it('标量序列化后反序列化还原', () => {
    const doc = emptyDoc();
    doc.scalars = { lockMap: 'prt_fild08', attackAuto: '2', teleportAuto_hp: '10' };
    expect(parseConfig(serializeConfig(doc)).scalars).toEqual(doc.scalars);
  });

  it('block 序列化/反序列化还原（含 selector、字段、条件）', () => {
    const doc = emptyDoc();
    doc.blocks.attackSkillSlot = [{
      selector: 'Coldbolt',
      fields: { lvl: '5', dist: '9', maxCastTime: '0' },
      conditions: { 'hp': '< 50%', 'target_hp': '< 30%' },
    }];
    const text = serializeConfig(doc);
    expect(text).toContain('attackSkillSlot Coldbolt {');
    expect(text).toContain('\tlvl 5');
    expect(text).toContain('\thp < 50%');
    const parsed = parseConfig(text);
    expect(parsed.blocks.attackSkillSlot).toEqual(doc.blocks.attackSkillSlot);
  });

  it('多个同名 block 保留顺序', () => {
    const doc = emptyDoc();
    doc.blocks.useSelf_skill = [
      { selector: 'Increase AGI', fields: { lvl: '10' }, conditions: {} },
      { selector: 'Blessing', fields: { lvl: '10' }, conditions: {} },
    ];
    const parsed = parseConfig(serializeConfig(doc));
    expect(parsed.blocks.useSelf_skill).toHaveLength(2);
    expect(parsed.blocks.useSelf_skill![0]!.selector).toBe('Increase AGI');
    expect(parsed.blocks.useSelf_skill![1]!.selector).toBe('Blessing');
  });

  it('每个标量/block key 唯一，条件 key 唯一', () => {
    const scalarKeys = CONFIG_SCALARS.map((s) => s.key);
    expect(new Set(scalarKeys).size).toBe(scalarKeys.length);
    const blockTypes = BLOCK_DEFS.map((b) => b.type);
    expect(new Set(blockTypes).size).toBe(blockTypes.length);
  });
});
