import type { UploadRequest } from '@lastroweb/protocol';

export const MAX_UPLOAD_BYTES = 512 * 1024;
export const MAX_PARTS = 64;
export const MAX_SHOPS = 300;
export const MAX_ITEMS_PER_SHOP = 256;
export const MAX_OPTIONS_PER_ITEM = 32;

export type LimitErrorCode = 'payload_too_large' | 'upload_limit_exceeded' | 'rate_limited';
export class LimitError extends Error {
  constructor(public readonly status: 413 | 429, public readonly code: LimitErrorCode, message: string, public readonly action?: 'reshard_upload') { super(message); this.name = 'LimitError'; }
}

export function enforceUploadLimits(request: Request, parsed: UploadRequest, bodyBytes?: number): void {
  const declared = request.headers.get('content-length');
  const bytes = bodyBytes ?? (declared ? Number(declared) : 0);
  if (Number.isFinite(bytes) && bytes > MAX_UPLOAD_BYTES) throw new LimitError(413, 'payload_too_large', 'Upload body exceeds 512 KiB', 'reshard_upload');
  if (parsed.part_count > MAX_PARTS || parsed.part_index >= parsed.part_count) throw new LimitError(413, 'upload_limit_exceeded', 'Upload has too many parts', 'reshard_upload');
  if (parsed.shops.length > MAX_SHOPS) throw new LimitError(413, 'upload_limit_exceeded', 'Upload has too many shops', 'reshard_upload');
  if (parsed.shops.some((shop) => shop.items.length > MAX_ITEMS_PER_SHOP)) throw new LimitError(413, 'upload_limit_exceeded', 'Shop has too many items', 'reshard_upload');
  if (parsed.shops.some((shop) => shop.items.some((item) => item.options.length > MAX_OPTIONS_PER_ITEM))) throw new LimitError(413, 'upload_limit_exceeded', 'Item has too many options', 'reshard_upload');
}
