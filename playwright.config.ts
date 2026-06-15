import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './exports',
  timeout: 30000,
  reporter: [['html', { open: 'on-failure' }]],
  use: {
    headless: false,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
