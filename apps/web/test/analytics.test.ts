import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('51.la analytics', () => {
  it('initializes the site SDK with custom event tracking enabled', async () => {
    vi.stubEnv('PROD', true);
    const listeners = new Map<string, () => void>();
    const script = {
      id: '',
      async: false,
      charset: '',
      src: '',
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    };
    const appendChild = vi.fn();
    const init = vi.fn();
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => script),
      head: { appendChild },
    });
    vi.stubGlobal('window', {
      LA: { init },
      setInterval,
      clearInterval,
    });

    const { initAnalytics } = await import('../src/analytics');
    initAnalytics();

    expect(script.src).toBe('https://sdk.51.la/js-sdk-pro.min.js');
    expect(appendChild).toHaveBeenCalledWith(script);
    listeners.get('load')?.();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ autoTrack: true }));
  });

  it('queues events until LA.track is available and then calls the documented API', async () => {
    vi.useFakeTimers();
    vi.stubEnv('PROD', true);
    const track = vi.fn();
    const windowMock = {
      LA: {} as { track?: typeof track },
      setInterval,
      clearInterval,
    };
    vi.stubGlobal('window', windowMock);

    const analytics = await import('../src/analytics');
    analytics.track(analytics.AnalyticsEvent.Search, { q: '波利卡片' });
    expect(track).not.toHaveBeenCalled();

    windowMock.LA.track = track;
    await vi.advanceTimersByTimeAsync(500);

    expect(track).toHaveBeenCalledExactlyOnceWith('search', { q: '波利卡片' });
  });

  it('truncates long search values and drops parameters outside the SDK limits', async () => {
    vi.stubEnv('PROD', true);
    const track = vi.fn();
    vi.stubGlobal('window', { LA: { track }, setInterval, clearInterval });

    const analytics = await import('../src/analytics');
    analytics.track(analytics.AnalyticsEvent.Search, {
      q: '词'.repeat(70),
      'key-name-that-is-longer-than-25': 'ignored',
      blank: '',
    });

    expect(track).toHaveBeenCalledExactlyOnceWith('search', { q: '词'.repeat(64) });
  });
});
