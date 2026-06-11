import { test, expect } from '@playwright/test';

test('대시보드 핵심 요소 렌더링', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#equity')).toBeVisible();
  await expect(page.locator('#bench-diff')).toBeVisible();
});

test('온보딩 페이지 접근', async ({ page }) => {
  await page.goto('/setup.html');
  await expect(page.locator('#step-broker')).toBeVisible();
  await expect(page.locator('#step-broker')).toContainText('증권사 연결');
});
