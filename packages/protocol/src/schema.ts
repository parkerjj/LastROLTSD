import { z } from 'zod';
import type { UploadRequest } from './types';

const integer = z.number().int().finite();
const option = z.object({ type: integer.min(0).max(65535), value: integer.min(-2147483648).max(2147483647), param: integer.min(-2147483648).max(2147483647) }).strict();
const item = z.object({
  item_key: z.string().trim().min(1).max(80).optional(), item_id: integer.nonnegative().max(2147483647),
  upgrade: integer.min(0).max(20).default(0), slots: integer.min(0).max(4).default(0),
  cards: z.array(integer.nonnegative().max(2147483647)).max(4).default([]), price: integer.nonnegative().max(Number.MAX_SAFE_INTEGER),
  quantity: integer.nonnegative().max(Number.MAX_SAFE_INTEGER), options: z.array(option).max(32).default([]),
}).strict();
const shop = z.object({
  shop_id: z.string().trim().min(1).max(120).optional(), uuid: z.string().uuid(), shop_status: z.enum(['opening', 'dismissed']),
  vendor_account_id: z.string().trim().min(1).max(120), vendor_name: z.string().trim().max(160),
  title: z.string().trim().max(200), shop_type: z.enum(['buy', 'sell']), map_name: z.string().trim().min(1).max(80),
  x: integer.min(0).max(1000), y: integer.min(0).max(1000), items: z.array(item).max(256),
}).strict();
export const uploadRequestSchema = z.object({
  protocol_version: z.literal(2), client_run_id: z.string().trim().min(1).max(120), snapshot_id: z.string().trim().min(1).max(160),
  snapshot_mode: z.enum(['full', 'delta', 'heartbeat']), part_index: integer.min(0).max(15), part_count: integer.min(1).max(16),
  observed_at: z.string().datetime({ offset: true }), shops: z.array(shop).max(300),
}).strict().superRefine((value, ctx) => {
  if (value.part_index >= value.part_count) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['part_index'], message: 'part_index must be less than part_count' });
  const uuids = new Set<string>();
  for (const [index, current] of value.shops.entries()) {
    if (uuids.has(current.uuid)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shops', index, 'uuid'], message: 'shop uuid must be unique within a batch' });
    uuids.add(current.uuid);
    if (current.shop_status === 'dismissed' && current.items.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shops', index, 'items'], message: 'dismissed shops must not contain items' });
  }
});

export class UploadValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) { super('Invalid upload request'); this.name = 'UploadValidationError'; }
}

export function parseUploadRequest(input: unknown): UploadRequest {
  const candidate = input && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : input;
  if (candidate && typeof candidate === 'object') delete (candidate as Record<string, unknown>).source_id;
  const result = uploadRequestSchema.safeParse(candidate);
  if (!result.success) throw new UploadValidationError(result.error.issues);
  return result.data as UploadRequest;
}
