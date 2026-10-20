import { describe, expect, it } from 'vitest';
import { BLOCK_DEFS, CONFIG_SCALARS, CONDITION_KEYS, emptyDoc, parseConfig, serializeConfig, validateConfigDoc } from '../src/ke-schema';

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
      fields: { lvl: '5', dist: '9', maxDist: '12', maxCastTime: '0' },
      conditions: { 'hp': '< 50%', 'target_hp': '< 30%' },
    }];
    const text = serializeConfig(doc);
    expect(text).toContain('attackSkillSlot Coldbolt {');
    expect(text).toContain('\tlvl 5');
    expect(text).toContain('\tmaxDist 12');
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

  it('smartEncore 文案表示舞娘/诗人专用的自动安可', () => {
    const field = BLOCK_DEFS.find((block) => block.type === 'useSelf_skill')?.fields.find((item) => item.key === 'smartEncore');
    expect(field?.label).toBe('自动安可');
    expect(field?.help).toContain('舞娘/诗人专用');
  });

  it('新方案默认启用优化寻路、自动出售和自动存仓', () => {
    const defaults = Object.fromEntries(CONFIG_SCALARS.map(({ key, default: value }) => [key, value]));
    expect(defaults.route_randomWalk).toBe('2');
    expect(defaults.sellAuto).toBe('1');
    expect(defaults.sellAuto_npc).toBe('prontera 105 87');
    expect(defaults.storageAuto).toBe('1');
  });

  it('equipAuto：槽位/块级字段/双条件组序列化后还原', () => {
    const doc = emptyDoc();
    doc.blocks.equipAuto = [{
      selector: '',
      fields: { topHead: 'Poring Hat', rightHand: '+5 深红之弓', arrow: '银箭矢', weight: '50', whileSitting: '1', target: '1002' },
      conditions: { hp: '> 30%', target_hp: '> 50%', target_dist: '< 8', inInventoryID: '501 > 1', target_is_aggressive: '1' },
    }];
    const text = serializeConfig(doc);
    expect(text).toContain('equipAuto {');
    expect(text).toContain('\ttopHead Poring Hat');
    expect(text).toContain('\tarrow 银箭矢');
    expect(text).toContain('\tweight 50');
    expect(text).toContain('\ttarget 1002');
    expect(text).toContain('\thp > 30%');
    expect(text).toContain('\ttarget_hp > 50%');
    expect(text).toContain('\ttarget_is_aggressive 1');
    const parsed = parseConfig(text);
    expect(parsed.blocks.equipAuto).toEqual(doc.blocks.equipAuto);
  });

  it('equipAuto 的 11 个槽位字段都走 item picker，怪物条件不含 target_timeout', () => {
    const def = BLOCK_DEFS.find((b) => b.type === 'equipAuto')!;
    const slots = def.fields.filter((f) => f.picker === 'item').map((f) => f.key);
    expect(slots).toEqual(['topHead', 'midHead', 'lowHead', 'rightHand', 'leftHand', 'leftAccessory', 'rightAccessory', 'robe', 'armor', 'shoes', 'arrow']);
    expect(def.conditions).toEqual(['equipSelf', 'equipMonster']);
    const monsterKeys = CONDITION_KEYS.equipMonster.map((k) => k.key);
    expect(monsterKeys).not.toContain('target_timeout');
    expect(monsterKeys).toContain('target_misses');
    expect(monsterKeys).toContain('target_is_aggressive');
  });

  it('validateConfigDoc：合法配置通过', () => {
    const doc = emptyDoc();
    doc.blocks.useSelf_skill = [{
      selector: '28',
      fields: { lvl: '10', dist: '9' },
      conditions: { hp: '< 50%', aggressives: '>= 2', timeout: '10', whenStatusActive: 'EFST_BLESSING' },
    }];
    doc.blocks.equipAuto = [{
      selector: '',
      fields: { weight: '50', whileSitting: '1', target: '1002' },
      conditions: { target_dist: '3..8', target_misses: '> 2', inInventory: '红色药水 > 1', manualAI: '2', stopWhenHit: '1' },
    }];
    expect(validateConfigDoc(doc)).toEqual([]);
  });

  it('validateConfigDoc：逐类错误都能报出', () => {
    const doc = emptyDoc();
    // 未选技能 + int 字段非整数 + 比较条件格式错误 + timeout 非数字
    doc.blocks.useSelf_skill = [{
      selector: '',
      fields: { lvl: 'abc' },
      conditions: { hp: '半血', timeout: '十秒' },
    }];
    // bool 条件填了非 0/1 + 物品数量格式错误 + enum 越界（放进 equipAuto 的条件）
    doc.blocks.equipAuto = [{
      selector: '',
      fields: { weight: '50' },
      conditions: { stopWhenHit: 'yes', inInventory: '红色药水很多', manualAI: '9' },
    }];
    // autoSwitch 的 distance 是数值字段：非数字应报错
    doc.blocks.autoSwitch = [{ selector: '', fields: { distance: '很远' }, conditions: {} }];
    const errors = validateConfigDoc(doc);
    expect(errors.some((e) => e.includes('未选择技能'))).toBe(true);
    expect(errors.some((e) => e.includes('技能等级') && e.includes('数字'))).toBe(true);
    expect(errors.some((e) => e.includes('自身 HP') && e.includes('格式错误'))).toBe(true);
    expect(errors.some((e) => e.includes('冷却时间') && e.includes('应为数字'))).toBe(true);
    expect(errors.some((e) => e.includes('距离') && e.includes('数字'))).toBe(true);
    expect(errors.some((e) => e.includes('被打时禁用') && e.includes('开启(1)或关闭(0)'))).toBe(true);
    expect(errors.some((e) => e.includes('背包物品（名称）') && e.includes('格式错误'))).toBe(true);
    expect(errors.some((e) => e.includes('AI 模式') && e.includes('取值无效'))).toBe(true);
  });

  it('validateConfigDoc：标量 int 校验；范围与带 % 写法均合法', () => {
    const doc = emptyDoc();
    doc.scalars['attackDistance'] = '很远';
    const errors = validateConfigDoc(doc);
    expect(errors.some((e) => e.includes('攻击距离') && e.includes('数字'))).toBe(true);

    const ok = emptyDoc();
    ok.blocks.attackSkillSlot = [{
      selector: '1',
      fields: { lvl: '10' },
      conditions: { target_hp: '30%..80%', aggressives: '2-5', sp: '> 10%' },
    }];
    expect(validateConfigDoc(ok)).toEqual([]);
  });

  it('validateConfigDoc：数值字段允许小数（dist 1.5 / minCastTime 0.1）', () => {
    const doc = emptyDoc();
    doc.blocks.attackSkillSlot = [{
      selector: '1',
      fields: { lvl: '10', dist: '1.5', maxDist: '12.5' },
      conditions: {},
    }];
    doc.blocks.useSelf_skill = [{
      selector: '28',
      fields: { lvl: '5' },
      conditions: {},
    }];
    expect(validateConfigDoc(doc)).toEqual([]);
  });

  it('autoSwitch 旧配置可解析并序列化保留', () => {
    const text = 'autoSwitch {\n\trightHand 弓\n\tdistance 10\n\tuseWeapon 1\n}\n';
    const doc = parseConfig(text);
    expect(doc.blocks.autoSwitch).toHaveLength(1);
    expect(doc.blocks.autoSwitch![0]!.fields['rightHand']).toBe('弓');
    expect(serializeConfig(doc)).toContain('autoSwitch {');
    expect(serializeConfig(doc)).toContain('\trightHand 弓');
  });

  it('equipSelf 条件不包含 weight（避免与块级字段重复）', () => {
    expect(CONDITION_KEYS.equipSelf.map((k) => k.key)).not.toContain('weight');
    // 块级字段保留 weight，接受纯数字或比较式
    const def = BLOCK_DEFS.find((d) => d.type === 'equipAuto')!;
    expect(def.fields.some((f) => f.key === 'weight')).toBe(true);
  });
});
