import { logError } from '../observability';
import { readActivityNetwork } from './network';
import type { ActivityRepository } from './repository';
import type { ActivityCharacter, ActivityEvent, ActivityResult, ActivityRow } from './types';

export interface ActivityEntry {
  userId: number | string;
  event: ActivityEvent;
  /** 默认 SUCCESS。 */
  result?: ActivityResult;
  character?: ActivityCharacter | null;
  ref?: string | null;
  requestId?: string | null;
}

export interface ActivityRecorder {
  /** 尽力而为：任何异常只记日志，永不抛出。 */
  record(request: Request, entry: ActivityEntry): Promise<void>;
  /** 与该 ref 最近一条记录的 ip_net 相同则跳过，只在 IP 变化时落一行。 */
  recordHeartbeat(request: Request, entry: ActivityEntry & { ref: string }): Promise<void>;
}

function buildRow(request: Request, environment: string, entry: ActivityEntry, now: number, proxySecret?: string): ActivityRow {
  return {
    ...readActivityNetwork(request, environment, proxySecret),
    user_id: Number(entry.userId),
    event: entry.event,
    result: entry.result ?? 'SUCCESS',
    aid: entry.character?.aid ?? null,
    cid: entry.character?.cid ?? null,
    nid: entry.character?.nid ?? null,
    ref: entry.ref ?? null,
    source: 'live',
    request_id: entry.requestId ?? null,
    created_at: now,
  };
}

export function createActivityRecorder(
  repository: ActivityRepository | null,
  environment: string,
  now: () => number = Date.now,
  proxySecret?: string,
): ActivityRecorder {
  if (!repository) return NOOP_ACTIVITY_RECORDER;
  return {
    async record(request, entry) {
      try {
        await repository.insert(buildRow(request, environment, entry, now(), proxySecret));
      } catch (error) {
        logError('lastroweb.activity_log_error', error, { event: entry.event });
      }
    },

    async recordHeartbeat(request, entry) {
      try {
        const row = buildRow(request, environment, entry, now(), proxySecret);
        const latest = await repository.latestIpNetForRef(entry.ref);
        if (latest && latest.ip_net === row.ip_net) return;
        await repository.insert(row);
      } catch (error) {
        logError('lastroweb.activity_log_error', error, { event: entry.event });
      }
    },
  };
}

export const NOOP_ACTIVITY_RECORDER: ActivityRecorder = {
  async record() {},
  async recordHeartbeat() {},
};
