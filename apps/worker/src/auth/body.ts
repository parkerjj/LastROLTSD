import { AuthFailure } from './types';

function badRequest(): AuthFailure {
  return new AuthFailure('AUTH_BAD_REQUEST', 400, '请求格式无效');
}

function tooLarge(): AuthFailure {
  return new AuthFailure('AUTH_BODY_TOO_LARGE', 413, '请求内容超出限制');
}

function unsupportedMediaType(): AuthFailure {
  return new AuthFailure('AUTH_UNSUPPORTED_MEDIA_TYPE', 415, '请求必须使用 JSON 格式');
}

export async function readAuthJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive safe integer');

  const contentType = request.headers.get('content-type');
  if (!contentType || !/^application\/json(?:\s*;|\s*$)/iu.test(contentType)) throw unsupportedMediaType();

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw badRequest();
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes)) throw badRequest();
    if (declaredBytes > maxBytes) {
      await cancelBody(request.body);
      throw tooLarge();
    }
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Preserve the public size error even if the underlying source fails cancellation.
          }
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AuthFailure) throw error;
      throw badRequest();
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw badRequest();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest();
  return value as Record<string, unknown>;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Request cancellation is best-effort; the public error remains the size limit.
  }
}
