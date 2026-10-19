import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMAS, parseControl, serializeControl } from '../src/ke-controls';

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

  it('忽略空行与注释，跳过头部无列的行', () => {
    const text = ['# 注释', '', '1555 0 0 0', '  6001 -1 0 0 '].join('\n');
    const rows = parseControl(monControl, text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: '1555', values: { attack_auto: '0', teleport_auto: '0', teleport_search: '0' } });
    expect(rows[1]).toEqual({ name: '6001', values: { attack_auto: '-1', teleport_auto: '0', teleport_search: '0' } });
  });
});
