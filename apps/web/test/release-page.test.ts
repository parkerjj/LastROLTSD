import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { mountReleasePage } from '../src/release-page';
import { releaseNotes } from '../src/release-notes';

describe('release notes page', () => {
  it('renders the structured release data as a dedicated page', () => {
    const dom = new JSDOM('<main id="app"></main>');
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });

    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app');
      if (!root) throw new Error('Missing test app root');

      mountReleasePage(root);

      expect(root.querySelector('h1')?.textContent).toBe('更新说明');
      expect(root.querySelectorAll('.release-entry')).toHaveLength(releaseNotes.length);
      expect(root.querySelector('.site-nav a[aria-current="page"]')?.getAttribute('href')).toBe('/updates');
      expect(root.textContent).toContain(releaseNotes[0]?.changes[0]?.title);
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });
});
