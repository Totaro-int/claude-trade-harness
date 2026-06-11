import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:3456' },
  webServer: {
    command: 'npx tsx e2e/serve-fixture.ts',
    port: 3456,
    reuseExistingServer: false,
  },
});
