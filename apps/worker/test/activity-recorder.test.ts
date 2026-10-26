import { describe, expect, it, vi } from 'vitest';
import { createActivityRecorder, NOOP_ACTIVITY_RECORDER } from '../src/activity/recorder';
import type { ActivityRepository } from '../src/activity/repository';
import type { ActivityRow } from '../src/activity/types';

const DEVICE = '0b9c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';

function buildRequest(): Request {
  const request = new Request('https://api.ltsd.ro/x', {
    headers: { 'cf-connecting-ip': '113.87.1.2', 'x-ltsd-device': DEVICE, 'user-agent': 'vitest' },
  });
  Object.defineProperty(request, 'cf', { value: { country: 'cn', asn: 4134, asOrganization: 'Chinanet' } });
  return request;
}

function fakeRepository(overrides: Partial<ActivityRepository> = {}): ActivityRepository & { rows: ActivityRow[] } {
  const rows: ActivityRow[] = [];
  return {
    rows,
    insert: async (row) => {
      rows.push(row);
    },
    latestIpNetForRef: async () => null,
    listForUser: async () => ({ records: [], truncated: false }),
    countUsers: async () => 0,
    cleanup: async () => 0,
    ...overrides,
  };
}

describe('createActivityRecorder.record', () => {
  it('写入一行：user_id 转数字、默认 SUCCESS、live、注入时间、网络字段与角色展开', async () => {
    const repository = fakeRepository();
    const recorder = createActivityRecorder(repository, 'production', () => 1_700_000_000_000);
    await recorder.record(buildRequest(), {
      userId: '10001',
      event: 'KE_BIND',
      character: { aid: 1, cid: 2, nid: 3 },
      ref: 'inst-1',
      requestId: 'req-1',
    });
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      user_id: 10001,
      event: 'KE_BIND',
      result: 'SUCCESS',
      source: 'live',
      created_at: 1_700_000_000_000,
      aid: 1,
      cid: 2,
      nid: 3,
      ref: 'inst-1',
      request_id: 'req-1',
      ip: '113.87.1.2',
      ip_net: '113.87.1.2',
      country: 'CN',
      asn: 4134,
      device_id: DEVICE,
      user_agent: 'vitest',
    });
  });

  it('未提供 character / ref / requestId 时写 null，result 可显式指定', async () => {
    const repository = fakeRepository();
    const recorder = createActivityRecorder(repository, 'production', () => 5);
    await recorder.record(buildRequest(), { userId: 7, event: 'LOGIN', result: 'FAILURE' });
    expect(repository.rows[0]).toMatchObject({ user_id: 7, result: 'FAILURE', aid: null, cid: null, nid: null, ref: null, request_id: null });
  });

  it('insert 抛错时不抛出', async () => {
    const repository = fakeRepository({
      insert: async () => {
        throw new Error('db down');
      },
    });
    const recorder = createActivityRecorder(repository, 'production');
    await expect(recorder.record(buildRequest(), { userId: 1, event: 'LOGIN' })).resolves.toBeUndefined();
  });

  it('repository 为 null 时什么也不做', async () => {
    const recorder = createActivityRecorder(null, 'production');
    await expect(recorder.record(buildRequest(), { userId: 1, event: 'LOGIN' })).resolves.toBeUndefined();
    await expect(NOOP_ACTIVITY_RECORDER.record(buildRequest(), { userId: 1, event: 'LOGIN' })).resolves.toBeUndefined();
  });
});

describe('createActivityRecorder.recordHeartbeat', () => {
  it('最近一条 ip_net 相同则跳过', async () => {
    const latest = vi.fn(async () => ({ ip_net: '113.87.1.2' }));
    const repository = fakeRepository({ latestIpNetForRef: latest });
    const recorder = createActivityRecorder(repository, 'production');
    await recorder.recordHeartbeat(buildRequest(), { userId: 1, event: 'KE_HEARTBEAT', ref: 'inst-1' });
    expect(latest).toHaveBeenCalledWith('inst-1');
    expect(repository.rows).toHaveLength(0);
  });

  it('ip_net 不同或无记录则插入 KE_HEARTBEAT', async () => {
    const different = fakeRepository({ latestIpNetForRef: async () => ({ ip_net: '1.2.3.4' }) });
    await createActivityRecorder(different, 'production').recordHeartbeat(buildRequest(), { userId: 1, event: 'KE_HEARTBEAT', ref: 'inst-1' });
    expect(different.rows.map((row) => row.event)).toEqual(['KE_HEARTBEAT']);

    const none = fakeRepository({ latestIpNetForRef: async () => null });
    await createActivityRecorder(none, 'production').recordHeartbeat(buildRequest(), { userId: 1, event: 'KE_HEARTBEAT', ref: 'inst-1' });
    expect(none.rows).toHaveLength(1);
  });

  it('查询抛错时不抛出', async () => {
    const repository = fakeRepository({
      latestIpNetForRef: async () => {
        throw new Error('db down');
      },
    });
    await expect(
      createActivityRecorder(repository, 'production').recordHeartbeat(buildRequest(), { userId: 1, event: 'KE_HEARTBEAT', ref: 'inst-1' }),
    ).resolves.toBeUndefined();
  });
});
