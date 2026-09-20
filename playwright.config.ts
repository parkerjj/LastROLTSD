import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'node ../../node_modules/vite/bin/vite.js --host 127.0.0.1', cwd: 'apps/web', url: 'http://127.0.0.1:5173', reuseExistingServer: process.env.PW_REUSE_EXISTING_SERVER === 'true' },
});
