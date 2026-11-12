import { describe, expect, it } from 'vitest';
import { applyConfigPatch } from '../../apps/worker/src/ke/death/config-patch';
import type { ConfigPatch } from '../../apps/worker/src/ke/death/types';
import { KeFailure } from '../../apps/worker/src/ke/types';

const files = (config: string, mon = '') => ({
  'config.txt': config,
  'mon_control.txt': mon,
  'pickupitems.txt': '',
  'items_control.txt': '',
  'timeouts.txt': '',
});
const itemIdOf = (name: string) => ({ 苍蝇翅膀: 601, 红色药水: 501 } as Record<string, number>)[name] ?? null;

describe('applyConfigPatch', () => {
  it('set_key replaces value and keeps comments and order', () => {
    const text = '# 注释\nlockMap pay_dun03\nteleportAuto_hp 30\nattackAuto 2\n';
    const patch: ConfigPatch = { op: 'setKey', file: 'config.txt', key: 'teleportAuto_hp', expected: '30', value: '70' };
    const { files: out } = applyConfigPatch(files(text), patch, itemIdOf);
    expect(out['config.txt']).toBe('# 注释\nlockMap pay_dun03\nteleportAuto_hp 70\nattackAuto 2\n');
  });

  it('set_key appends when absent and revert removes it', () => {
    const text = 'attackAuto 2\n';
    const patch: ConfigPatch = { op: 'setKey', file: 'config.txt', key: 'teleportAuto_minAggressives', expected: null, value: '2' };
    const applied = applyConfigPatch(files(text), patch, itemIdOf);
    expect(applied.files['config.txt']).toBe('attackAuto 2\nteleportAuto_minAggressives 2\n');
    const reverted = applyConfigPatch(applied.files, applied.revert, itemIdOf);
    expect(reverted.files['config.txt']).toBe(text);
  });

  it('set_key rejects when expected differs', () => {
    const patch: ConfigPatch = { op: 'setKey', file: 'config.txt', key: 'teleportAuto_hp', expected: '30', value: '70' };
    try {
      applyConfigPatch(files('teleportAuto_hp 50\n'), patch, itemIdOf);
      throw new Error('should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(KeFailure);
      expect((error as KeFailure).code).toBe('KE_CONFIG_CHANGED');
      expect((error as KeFailure).status).toBe(409);
    }
  });

  it('upsert_block appends the full block when absent', () => {
    const patch: ConfigPatch = {
      op: 'upsertBlock', file: 'config.txt', block: 'buyAuto', selector: '苍蝇翅膀', itemId: 601, expected: null,
      fields: [['npc', 'prt_in 126 76'], ['npc_steps', 'b'], ['minAmount', '5'], ['maxAmount', '50'], ['zeny', '> 25000']],
    };
    const { files: out } = applyConfigPatch(files('attackAuto 2\n'), patch, itemIdOf);
    expect(out['config.txt']).toBe(
      'attackAuto 2\nbuyAuto 苍蝇翅膀 {\n\tnpc prt_in 126 76\n\tnpc_steps b\n\tminAmount 5\n\tmaxAmount 50\n\tzeny > 25000\n}\n',
    );
  });

  it('upsert_block finds the block by item id and changes only listed fields', () => {
    const text = 'buyAuto 601 {\n    npc prt_in 126 76\n    minAmount 0\n    npc_steps b\n}\n';
    const patch: ConfigPatch = {
      op: 'upsertBlock', file: 'config.txt', block: 'buyAuto', selector: '苍蝇翅膀', itemId: 601,
      expected: { minAmount: '0', maxAmount: null }, fields: [['minAmount', '5'], ['maxAmount', '50']],
    };
    const applied = applyConfigPatch(files(text), patch, itemIdOf);
    expect(applied.files['config.txt']).toBe('buyAuto 601 {\n    npc prt_in 126 76\n    minAmount 5\n    npc_steps b\n\tmaxAmount 50\n}\n');
    // 撤销后文本与原文逐字节相同
    const reverted = applyConfigPatch(applied.files, applied.revert, itemIdOf);
    expect(reverted.files['config.txt']).toBe(text);
  });

  it('upsert_block rejects a block that appeared after the report', () => {
    const patch: ConfigPatch = { op: 'upsertBlock', file: 'config.txt', block: 'buyAuto', selector: '苍蝇翅膀', itemId: 601, expected: null, fields: [['minAmount', '5']] };
    expect(() => applyConfigPatch(files('buyAuto 601 {\n    minAmount 1\n}\n'), patch, itemIdOf)).toThrow(KeFailure);
  });

  it('upsert_line in mon_control replaces or appends', () => {
    const add: ConfigPatch = { op: 'upsertLine', file: 'mon_control.txt', first: '骷髅弓箭手', expected: null, line: '骷髅弓箭手 -1 1' };
    const applied = applyConfigPatch(files('', '# c\nall 1 0\n'), add, itemIdOf);
    expect(applied.files['mon_control.txt']).toBe('# c\nall 1 0\n骷髅弓箭手 -1 1\n');
    const reverted = applyConfigPatch(applied.files, applied.revert, itemIdOf);
    expect(reverted.files['mon_control.txt']).toBe('# c\nall 1 0\n');
    const replace: ConfigPatch = { op: 'upsertLine', file: 'mon_control.txt', first: 'all', expected: 'all 1 0', line: 'all 0 0' };
    expect(applyConfigPatch(files('', 'all 1 0\n'), replace, itemIdOf).files['mon_control.txt']).toBe('all 0 0\n');
  });

  it('keeps CRLF line endings', () => {
    const patch: ConfigPatch = { op: 'setKey', file: 'config.txt', key: 'a', expected: '1', value: '2' };
    expect(applyConfigPatch(files('a 1\r\nb 2\r\n'), patch, itemIdOf).files['config.txt']).toBe('a 2\r\nb 2\r\n');
  });
});
