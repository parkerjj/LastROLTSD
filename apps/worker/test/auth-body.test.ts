import { describe, expect, it } from 'vitest';
import { readAuthJson } from '../src/auth/body';

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://lastro.example/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function streamingRequest(headers: Record<string, string> = {}): { request: Request; wasCancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
      return Promise.reject(new Error('cancel failed'));
    },
  });
  return {
    request: new Request('https://lastro.example/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      duplex: 'half',
    } as RequestInit),
    wasCancelled: () => cancelled,
  };
}

describe('bounded account JSON bodies', () => {
  it.each([
    ['chunked request without Content-Length', {}],
    ['request with a false short Content-Length', { 'content-length': '1' }],
  ])('cancels an actual 64 KiB + 1 byte stream for a %s', async (_description, headers) => {
    const { request, wasCancelled } = streamingRequest(headers);

    await expect(readAuthJson(request, 64 * 1024)).rejects.toMatchObject({ code: 'AUTH_BODY_TOO_LARGE', status: 413 });
    expect(wasCancelled()).toBe(true);
  });

  it('accepts exactly 8 KiB of JSON and rejects the next byte', async () => {
    const exactLimit = `{"x":"${'a'.repeat(8 * 1024 - 8)}"}`;
    expect(new TextEncoder().encode(exactLimit)).toHaveLength(8 * 1024);
    await expect(readAuthJson(jsonRequest(exactLimit), 8 * 1024)).resolves.toMatchObject({ x: expect.any(String) });

    await expect(readAuthJson(jsonRequest(`${exactLimit} `), 8 * 1024)).rejects.toMatchObject({ code: 'AUTH_BODY_TOO_LARGE', status: 413 });
  });

  it('rejects malformed JSON and array roots with the same public input error', async () => {
    await expect(readAuthJson(jsonRequest('{'), 8 * 1024)).rejects.toMatchObject({ code: 'AUTH_BAD_REQUEST', status: 400 });
    await expect(readAuthJson(jsonRequest('[]'), 8 * 1024)).rejects.toMatchObject({ code: 'AUTH_BAD_REQUEST', status: 400 });
    await expect(readAuthJson(new Request('https://lastro.example/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    }), 8 * 1024)).rejects.toMatchObject({ code: 'AUTH_BAD_REQUEST', status: 400 });
  });
});
