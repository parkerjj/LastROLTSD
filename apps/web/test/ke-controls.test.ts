import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMAS, TIMEOUT_DEFAULT_OVERRIDES, allFallbackRows, defaultControlDoc, emptyControlDoc, ensureAllFallback, parseControl, serializeControl } from '../src/ke-controls';

const monControl = CONTROL_SCHEMAS.find((s) => s.file === 'mon_control.txt')!;
const pickupitems = CONTROL_SCHEMAS.find((s) => s.file === 'pickupitems.txt')!;
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

  it('ensureAllFallback 为缺失 all 行的规则文件补上兜底（置于最前），已有 all 行则不动', () => {
    const doc = emptyControlDoc();
    doc['mon_control.txt'] = [{ name: '1555', values: { attack_auto: '0' } }];

    ensureAllFallback(doc);

    expect(doc['mon_control.txt']![0]!.name).toBe('all');
    expect(doc['mon_control.txt']).toHaveLength(2);
    // 用户自定义行保持在 all 之后。
    expect(doc['mon_control.txt']![1]).toEqual({ name: '1555', values: { attack_auto: '0' } });
    expect(doc['pickupitems.txt']).toEqual([{ name: 'all', values: { flag: '1' } }]);
    expect(doc['items_control.txt']).toEqual([{ name: 'all', values: { keep: '0', storage: '0', sell: '0' } }]);

    // 已有 all 行时保持原样（不重复插入）。
    ensureAllFallback(doc);
    expect(doc['mon_control.txt']).toHaveLength(2);
    expect(doc['pickupitems.txt']).toHaveLength(1);
  });

  it('allFallbackRows 返回深拷贝，改动不影响后续调用与 defaultControlDoc', () => {
    const rows = allFallbackRows('mon_control.txt');
    rows[0]!.values.attack_auto = '9';

    expect(allFallbackRows('mon_control.txt')[0]!.values.attack_auto).toBe('1');
    expect(defaultControlDoc()['mon_control.txt']).toEqual([
      { name: 'all', values: { attack_auto: '1', teleport_auto: '0', teleport_search: '0' } },
    ]);
    expect(allFallbackRows('timeouts.txt')).toEqual([]);
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
});
