import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e', testMatch:'*.spec.ts', workers:1, timeout:30000,
  use:{baseURL:'http://127.0.0.1:3011',headless:true,launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{channel:'chrome'},screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'node --import tsx e2e/server.ts',url:'http://127.0.0.1:3011/healthz',reuseExistingServer:false,timeout:15000},
});
