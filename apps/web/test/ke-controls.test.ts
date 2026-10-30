import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMAS, GRASS_MOB_NAMES, TIMEOUT_DEFAULT_OVERRIDES, allFallbackRows, defaultControlDoc, emptyControlDoc, ensureAllFallback, newControlRow, parseControl, serializeControl, validateControlDoc } from '../src/ke-controls';

const monControl = CONTROL_SCHEMAS.find((s) => s.file === 'mon_control.txt')!;
const pickupitems = CONTROL_SCHEMAS.find((s) => s.file === 'pickupitems.txt')!;
const itemsControl = CONTROL_SCHEMAS.find((s) => s.file === 'items_control.txt')!;
const timeouts = CONTROL_SCHEMAS.find((s) => s.file === 'timeouts.txt')!;

describe('ke control files', () => {
  it('mon_control 序列化/解析还原（数字 ID + 列）', () => {
    const rows = [{ name: '1555', values: { attack_auto: '0', teleport_auto: '0', teleport_search: '0' } }];
    const text = serializeControl(monControl, rows);
    expect(text).toBe('1555 0 0 0\n');
    expect(parseControl(monControl, text)).toEqual(rows);
  });

  it('pickupitems 序列化/解析还原', () => {
    const rows = [{ name: '1002', values: { flag: '2' } }];
    expect(parseControl(pickupitems, serializeControl(pickupitems, rows))).toEqual(rows);
  });

  it('timeouts 序列化/解析还原', () => {
    const rows = [{ name: 'ai_move_retry', values: { value: '0.4' } }];
    expect(parseControl(timeouts, serializeControl(timeouts, rows))).toEqual(rows);
  });

  it('ensureAllFallback 为缺失的兜底行逐个补上（置于末尾），已有则不动', () => {
    const doc = emptyControlDoc();
    doc['mon_control.txt'] = [{ name: '1555', values: { attack_auto: '0' } }];

    ensureAllFallback(doc);

    // mon_control 补全三个兜底：all_miniboss / all_mvp / all（用户行在前）。
    const rows = doc['mon_control.txt']!;
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ name: '1555', values: { attack_auto: '0' } });
    expect(rows[1]!.name).toBe('all_miniboss');
    expect(rows[2]!.name).toBe('all_mvp');
    expect(rows[3]!.name).toBe('all');
    // pickupitems / items_control 只有 all。
    expect(doc['pickupitems.txt']).toEqual([{ name: 'all', values: { flag: '1' } }]);
    expect(doc['items_control.txt']).toEqual([{ name: 'all', values: { keep: '0', storage: '0', sell: '0' } }]);

    // 已有兜底行时保持原样（不重复插入）。
    ensureAllFallback(doc);
    expect(doc['mon_control.txt']).toHaveLength(4);
    expect(doc['pickupitems.txt']).toHaveLength(1);
  });

  it('allFallbackRows 返回深拷贝，改动不影响后续调用与 defaultControlDoc', () => {
    const rows = allFallbackRows('mon_control.txt');
    rows[0]!.values.attack_auto = '9';

    expect(allFallbackRows('mon_control.txt')[0]!.values.attack_auto).toBe('0');
    // defaultControlDoc 新 profile：草类怪物默认忽略，排在三个兜底之前。
    const defaults = defaultControlDoc()['mon_control.txt']!;
    expect(defaults.map((r) => r.name)).toEqual([...GRASS_MOB_NAMES, 'all_miniboss', 'all_mvp', 'all']);
    for (const name of GRASS_MOB_NAMES) {
      expect(defaults.find((r) => r.name === name)!.values.attack_auto).toBe('-1');
    }
    expect(allFallbackRows('timeouts.txt')).toEqual([]);
  });

  it('items_control 默认预设包含特殊道具：不存仓也不卖', () => {
    const rows = defaultControlDoc()['items_control.txt']!;
    const special = ['魔法箭矢筒', '魔法苍蝇翅膀', '坐骑缰绳', '乐园团*', '伊甸园*'];
    // 具名道具与通配符排在 *卡片 之前（通配符先到先得，顺序即优先级）。
    expect(rows.map((r) => r.name)).toEqual([...special, '*卡片', 'all']);
    for (const name of special) {
      const row = rows.find((r) => r.name === name)!;
      expect(row.values.storage).toBe('0');
      expect(row.values.sell).toBe('0');
    }
  });

  it('提供 LastRO 请求的 timeouts 新方案默认值', () => {
    expect(TIMEOUT_DEFAULT_OVERRIDES).toEqual({
      ai_move_retry: '0.3',
      ai_attack: '0.3',
      ai_attack_after_skill: '0.1',
      ai_attack_auto: '0.4',
      ai_attack_waitAfterKill: '0',
      ai_attack_main: '0.15',
      ai_items_take_delay: '0.1',
      ai_items_take_start: '0',
      ai_items_take_end: '0.3',
      ai_skill_use: '0.5',
      ai_item_use_auto: '0.3',
      ai_teleport: '0.4',
      ai_teleport_idle: '10',
      ai_teleport_delay: '0.2',
      ai_buyAuto: '15',
      ai_sellAuto: '0.2',
      ai_storageAuto: '0.3',
    });
  });

  it('忽略空行与注释，跳过头部无列的行', () => {
    const text = ['# 注释', '', '1555 0 0 0', '  6001 -1 0 0 '].join('\n');
    const rows = parseControl(monControl, text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: '1555', values: { attack_auto: '0', teleport_auto: '0', teleport_search: '0' } });
    expect(rows[1]).toEqual({ name: '6001', values: { attack_auto: '-1', teleport_auto: '0', teleport_search: '0' } });
  });

  it('items_control 回归：keep 未填但填了 storage/sell 时不再错位为「保留 0 + 存仓」', () => {
    // 用户场景：只选「不存仓」+「出售」，keep 留空。旧序列化会写出 "501  0 1"，
    // KE 按空格切分后变成 keep=0 storage=1，行为被改成「保留 0 个但存仓」。
    const rows = [{ name: '501', values: { storage: '0', sell: '1' } }];
    const text = serializeControl(itemsControl, rows);
    // 必填列用 defaultValue=0 补齐 keep，得到合法的 4 列行。
    expect(text).toBe('501 0 0 1\n');
    // 解析回来必须是 keep=0、storage=0、sell=1，位置不能再漂移。
    expect(parseControl(itemsControl, text)[0]).toEqual({
      name: '501',
      values: { keep: '0', storage: '0', sell: '1' },
    });
  });

  it('items_control 序列化始终至少输出 4 列（name + keep + storage + sell）', () => {
    const rows = [{ name: '501', values: { keep: '5' } }];
    expect(serializeControl(itemsControl, rows)).toBe('501 5 0 0\n');
  });

  it('mon_control 序列化在只填 weight 时用默认值补齐中间列', () => {
    const rows = [{ name: '1555', values: { attack_auto: '1', weight: '0.2' } }];
    // 中间 teleport/search/skillcancel/lv/jlv/hp/sp 全部用 defaultValue=0 补齐，weight 落在第 9 列。
    expect(serializeControl(monControl, rows)).toBe('1555 1 0 0 0 0 0 0 0 0.2\n');
  });

  it('mon_control 只填 attack_auto 时序列化为最小 2 列行', () => {
    const rows = [{ name: '红草', values: { attack_auto: '0' } }];
    expect(serializeControl(monControl, rows)).toBe('红草 0\n');
  });

  it('pickupitems 只填 flag 时序列化为最小 2 列行', () => {
    const rows = [{ name: '501', values: { flag: '-1' } }];
    expect(serializeControl(pickupitems, rows)).toBe('501 -1\n');
  });

  it('newControlRow 预填所有带 defaultValue 的列', () => {
    expect(newControlRow(itemsControl)).toEqual({
      name: '',
      values: { keep: '0', storage: '0', sell: '0', cart_add: '0', cart_get: '0' },
    });
    expect(newControlRow(pickupitems)).toEqual({ name: '', values: { flag: '1' } });
    expect(newControlRow(monControl)).toEqual({
      name: '',
      values: {
        attack_auto: '1',
        teleport_auto: '0',
        teleport_search: '0',
        skillcancel_auto: '0',
        attack_lvl: '0',
        attack_jlvl: '0',
        attack_hp: '0',
        attack_sp: '0',
        weight: '0',
      },
    });
  });

  it('validateControlDoc 拦截未选择对象的行', () => {
    const doc = emptyControlDoc();
    doc['items_control.txt'] = [{ name: '', values: { keep: '0', storage: '0', sell: '0' } }];
    const errors = validateControlDoc(doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('未选择物品');
  });

  it('validateControlDoc 拦截必填列缺失的行（items_control 至少 4 项）', () => {
    const doc = emptyControlDoc();
    // keep 被用户清空 → 必填缺失
    doc['items_control.txt'] = [{ name: '501', values: { keep: '', storage: '0', sell: '1' } }];
    const errors = validateControlDoc(doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('身上保留');
    expect(errors[0]).toContain('至少需 4 项');
  });

  it('validateControlDoc 拦截 pickupitems 缺 flag 的行', () => {
    const doc = emptyControlDoc();
    doc['pickupitems.txt'] = [{ name: '501', values: {} }];
    const errors = validateControlDoc(doc);
    expect(errors.some((e) => e.includes('拾取'))).toBe(true);
  });

  it('validateControlDoc 通过合法的 items/pickup/mon 行', () => {
    const doc = emptyControlDoc();
    doc['items_control.txt'] = [{ name: '501', values: { keep: '0', storage: '0', sell: '1' } }];
    doc['pickupitems.txt'] = [{ name: '501', values: { flag: '-1' } }];
    doc['mon_control.txt'] = [{ name: '红草', values: { attack_auto: '0' } }];
    expect(validateControlDoc(doc)).toEqual([]);
  });
});
