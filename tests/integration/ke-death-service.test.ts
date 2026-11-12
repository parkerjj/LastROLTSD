import { describe, expect, it } from 'vitest';
import { applyConfigPatch } from '../../apps/worker/src/ke/death/config-patch';
import type { DeathRepository, DeathRow, HostedOwner, NewDeathRow } from '../../apps/worker/src/ke/death/repository';
import { createDeathService, parseReport } from '../../apps/worker/src/ke/death/service';
import type { ConfigPatch } from '../../apps/worker/src/ke/death/types';
import type { ProfileFiles } from '../../apps/worker/src/ke/profile-service';
import { KeFailure } from '../../apps/worker/src/ke/types';

const NOW = 1_800_000_000_000;
const INSTANCE = '11111111-1111-1111-1111-111111111111';
const hosted: HostedOwner = { instanceId: INSTANCE, userId: 7, nid: 3, aid: 1, cid: 2, assignedAgent: 'agt_a', desired: 'running' };

function fakeRepo() {
  const rows: DeathRow[] = [];
  const state = { syncs: 0, running: true };
  const repository: DeathRepository = {
    findHosted: async (id) => (id === INSTANCE ? hosted : null),
    insert: async (row: NewDeathRow) => {
      if (rows.some((r) => r.reportKey === row.reportKey)) return false;
      rows.push({ ...row, id: rows.length + 1, fixesApplied: 0, fixesStateJson: null });
      return true;
    },
    list: async (_id, limit) => [...rows].sort((a, b) => b.diedAt - a.diedAt).slice(0, limit),
    get: async (_id, key) => rows.find((r) => r.reportKey === key) ?? null,
    setFixesState: async (id, json, applied) => { const row = rows.find((r) => r.id === id)!; row.fixesStateJson = json; row.fixesApplied = applied; },
    requestConfigSync: async () => { if (state.running) state.syncs += 1; return state.running; },
    prune: async () => undefined,
    stats: async () => ({ total: 0, characters: 0, topCause: null, rows: [] }),
  };
  return { rows, repository, state };
}

function fakeProfiles(initial: ProfileFiles) {
  const box = { files: initial };
  return {
    box,
    profiles: {
      activeName: async () => '挂机-下水道',
      patchActive: async (_u: string, _a: number, _c: number, _n: number, patch: ConfigPatch, itemIdOf: (n: string) => number | null) => {
        const result = applyConfigPatch(box.files, patch, itemIdOf);
        box.files = result.files;
        return { revert: result.revert, profileId: 1, profileName: '挂机-下水道' };
      },
    },
  };
}

const files = (config: string): ProfileFiles => ({ 'config.txt': config, 'mon_control.txt': '', 'pickupitems.txt': '', 'items_control.txt': '', 'timeouts.txt': '' });

const hpFix = { id: 'f1', title: 't', why: 'w', from: 'a', to: 'b', patch: { op: 'setKey', file: 'config.txt', key: 'teleportAuto_hp', expected: '30', value: '55' } };
const infoFix = { id: 'f2', title: 't', why: 'w', from: '', to: '', patch: null };

function report(id: string, atMs: number, extra: Record<string, unknown> = {}) {
  return {
    reportVersion: 1, id, atMs, map: { name: 'pay_dun03', x: 1, y: 2 }, cause: 'teleport_no_item', causeLabel: '瞬移失败',
    killer: { kind: 'monster', mobId: 1016, name: '骷髅弓箭手', skillId: 7, skillName: '二连矢', damage: 1284 },
    fixes: [hpFix, infoFix], ...extra,
  };
}

describe('death service', () => {
  it('stores a hosted report and rejects non-owners', async () => {
    const { repository, rows } = fakeRepo();
    const service = createDeathService({ repository, profiles: fakeProfiles(files('')).profiles, now: () => NOW });
    expect(await service.ingest('7', INSTANCE, report('2-1', NOW))).toEqual({ stored: true });
    expect(rows[0]).toMatchObject({ killerName: '骷髅弓箭手', skillName: '二连矢', cause: 'teleport_no_item', fixesTotal: 2, map: 'pay_dun03' });
    await expect(service.ingest('8', INSTANCE, report('2-2', NOW))).rejects.toMatchObject({ status: 403 });
  });

  it('rejects oversized bodies and bad versions; duplicates are idempotent', async () => {
    const { repository } = fakeRepo();
    const service = createDeathService({ repository, profiles: fakeProfiles(files('')).profiles, now: () => NOW });
    await expect(service.ingest('7', INSTANCE, report('2-1', NOW, { log: 'x'.repeat(300 * 1024) }))).rejects.toMatchObject({ status: 413 });
    await expect(service.ingest('7', INSTANCE, { ...report('2-1', NOW), reportVersion: 2 })).rejects.toMatchObject({ status: 400 });
    await expect(service.ingest('7', INSTANCE, { ...report('bad id!', NOW) })).rejects.toBeInstanceOf(KeFailure);
    expect(await service.ingest('7', INSTANCE, report('2-9', NOW))).toEqual({ stored: true });
    expect(await service.ingest('7', INSTANCE, report('2-9', NOW))).toEqual({ stored: false });
  });

  it('lists newest first with 7-day stats', async () => {
    const { repository } = fakeRepo();
    const service = createDeathService({ repository, profiles: fakeProfiles(files('')).profiles, now: () => NOW });
    await service.ingest('7', INSTANCE, report('2-1', NOW - 10 * 24 * 3600 * 1000));
    await service.ingest('7', INSTANCE, report('2-2', NOW - 3600 * 1000));
    await service.ingest('7', INSTANCE, report('2-3', NOW - 1000));
    const list = await service.list('7', INSTANCE);
    expect(list.items.map((i) => i.reportKey)).toEqual(['2-3', '2-2', '2-1']);
    expect(list.stats.last7Days).toBe(2);
    expect(list.stats.perDay7[6]).toBe(2);
    expect(list.stats.topKiller).toEqual({ name: '骷髅弓箭手', count: 2 });
    expect(list.profileName).toBe('挂机-下水道');
    await expect(service.list('8', INSTANCE)).rejects.toMatchObject({ status: 404 });
  });

  it('apply patches the active profile, bumps config sync, and undo restores it', async () => {
    const { repository, state } = fakeRepo();
    const profile = fakeProfiles(files('# c\nteleportAuto_hp 30\n'));
    const service = createDeathService({ repository, profiles: profile.profiles, now: () => NOW });
    await service.ingest('7', INSTANCE, report('2-1', NOW));
    const applied = await service.applyFix('7', INSTANCE, '2-1', 'f1', 'apply');
    expect(profile.box.files['config.txt']).toBe('# c\nteleportAuto_hp 55\n');
    expect(applied.fixesState.f1!.status).toBe('applied');
    expect(applied.notify).toEqual(['agt_a']);
    expect(state.syncs).toBe(1);
    expect((await service.list('7', INSTANCE)).stats.fixesApplied).toBe(1);
    await expect(service.applyFix('7', INSTANCE, '2-1', 'f1', 'apply')).rejects.toMatchObject({ status: 409 });
    const undone = await service.applyFix('7', INSTANCE, '2-1', 'f1', 'undo');
    expect(profile.box.files['config.txt']).toBe('# c\nteleportAuto_hp 30\n');
    expect(undone.fixesState.f1!.status).toBe('reverted');
  });

  it('apply after a manual edit returns 409 and keeps the profile and state', async () => {
    const { repository } = fakeRepo();
    const profile = fakeProfiles(files('teleportAuto_hp 45\n'));
    const service = createDeathService({ repository, profiles: profile.profiles, now: () => NOW });
    await service.ingest('7', INSTANCE, report('2-1', NOW));
    await expect(service.applyFix('7', INSTANCE, '2-1', 'f1', 'apply')).rejects.toMatchObject({ code: 'KE_CONFIG_CHANGED', status: 409 });
    expect(profile.box.files['config.txt']).toBe('teleportAuto_hp 45\n');
    expect((await service.get('7', INSTANCE, '2-1')).fixesState).toEqual({});
  });

  it('a fix without a patch cannot be applied', async () => {
    const { repository } = fakeRepo();
    const service = createDeathService({ repository, profiles: fakeProfiles(files('')).profiles, now: () => NOW });
    await service.ingest('7', INSTANCE, report('2-1', NOW));
    await expect(service.applyFix('7', INSTANCE, '2-1', 'f2', 'apply')).rejects.toMatchObject({ status: 400 });
  });

  it('does not request a sync notification when the instance is not running', async () => {
    const { repository, state } = fakeRepo();
    state.running = false;
    const service = createDeathService({ repository, profiles: fakeProfiles(files('teleportAuto_hp 30\n')).profiles, now: () => NOW });
    await service.ingest('7', INSTANCE, report('2-1', NOW));
    expect((await service.applyFix('7', INSTANCE, '2-1', 'f1', 'apply')).notify).toEqual([]);
  });

  it('parseReport rejects malformed patches', () => {
    expect(() => parseReport({ ...report('2-1', NOW), fixes: [{ id: 'f1', patch: { op: 'rm -rf' } }] })).toThrow(KeFailure);
  });
});
