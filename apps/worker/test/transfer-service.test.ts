import { describe, expect, it } from 'vitest';
import { EMPTY_NETWORK, type ActivityRecord } from '../src/activity/types';
import type { ActivityRepository } from '../src/activity/repository';
import { createTransferService } from '../src/admin/transfer-service';
import type { TransferRepository } from '../src/admin/transfer-repository';
import type { AdminUserRow } from '../src/admin/types';

const AID = 7001;
const SHARED_AID = 8002;

const user = (id: number): AdminUserRow => ({
  id, email: `u${id}@example.test`, display_name: `u${id}`, status: 'ACTIVE', permission_level: 1, email_verified_at: 1, created_at: 1,
});

function record(id: number, userId: number, over: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    ...EMPTY_NETWORK, id, user_id: userId, event: 'LOGIN', result: 'SUCCESS', aid: null, cid: null, nid: null,
    ref: null, source: 'live', request_id: null, created_at: 1_800_000_000_000 + id, ...over,
  };
}

function build(records: Record<number, ActivityRecord[]>, aids: Record<number, number[]>) {
  const repository = {
    resolveUser: async (account: string) => user(Number(account)),
    findCharacter: async () => ({ aid: AID, cid: 1, nid: 1, user_id: 1, char_name: 'X', base_level: null, job_level: null, job_id: null, bound_at: null }),
    listAids: async (userId: number) => aids[userId] ?? [],
  } as unknown as TransferRepository;
  const activity = {
    listForUser: async (userId: number) => ({ records: records[userId] ?? [], truncated: false }),
    countUsers: async () => 1,
  } as unknown as ActivityRepository;
  return createTransferService(repository, activity);
}

const request = { source: '1', target: '2', aid: AID, cid: 1, nid: 1 };

describe('transfer service 关联分析', () => {
  it('后台转移记录里的 aid 不算共有 aid', async () => {
    const service = build(
      { 1: [record(1, 1, { event: 'ADMIN_CHARACTER_TRANSFER', aid: SHARED_AID })], 2: [record(2, 2, { event: 'ADMIN_CHARACTER_TRANSFER', aid: SHARED_AID })] },
      { 1: [AID], 2: [] },
    );
    const { analysis } = await service.preview(request);
    expect(analysis.evidence.map((item) => item.rule)).not.toContain('OTHER_AID');
  });

  it('普通记录里的共有 aid 仍然命中 OTHER_AID', async () => {
    const service = build(
      { 1: [record(1, 1, { aid: SHARED_AID })], 2: [record(2, 2, { aid: SHARED_AID })] },
      { 1: [AID], 2: [] },
    );
    const { analysis } = await service.preview(request);
    expect(analysis.evidence.map((item) => item.rule)).toContain('OTHER_AID');
  });
});
