import { describe, expect, it, vi } from 'vitest';
import { OptionDictionaryStore } from '../src/option-state';
import type { OptionDefinitionsResponse } from '../src/types';

const payload: OptionDefinitionsResponse = { version: 'options-v1', options: [] };

describe('option dictionary state', () => {
  it('exposes loading and empty states', async () => {
    let resolve: ((value: OptionDefinitionsResponse) => void) | undefined;
    const store = new OptionDictionaryStore({ getOptions: () => new Promise<OptionDefinitionsResponse>((done) => { resolve = done; }) });
    const pending = store.load();
    expect(store.getState().status).toBe('loading');
    resolve!(payload);
    await pending;
    expect(store.getState()).toMatchObject({ status: 'empty', definitions: [] });
  });

  it('exposes an error and retries successfully', async () => {
    const getOptions = vi.fn().mockRejectedValueOnce(new Error('网络不可用')).mockResolvedValueOnce({ ...payload, options: [{ type: 12, handle: 'atk', labelZh: 'ATK +', descriptionTemplate: '', valueKind: 'integer', unit: '点', scale: 1, allowedOperators: ['gte'], paramPolicy: { mode: 'ignored', filterable: false }, repeatPolicy: 'same', displayTemplate: 'ATK + {value}', searchTokens: [] }] });
    const store = new OptionDictionaryStore({ getOptions });
    await store.load();
    expect(store.getState()).toMatchObject({ status: 'error', error: '网络不可用' });
    await store.retry();
    expect(getOptions).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({ status: 'ready', definitions: [{ labelZh: 'ATK +' }] });
  });
});
