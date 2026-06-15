import { test, expect } from '@playwright/test';


test.describe('flow1', () => {

  test('導航到 https://esd.genesys-tech.com/ → 點擊「排班查詢 ❐」', async ({ page }) => {
    await test.step('導航到 https://esd.genesys-tech.com/', async () => {
      await page.goto('https://esd.genesys-tech.com/');
    });

    await test.step('導航到 https://esd.genesys-tech.com/Login', async () => {
      await page.goto('https://esd.genesys-tech.com/Login');
    });

    await test.step('填入「Alen.Chua」到「請輸入帳號」', async () => {
      await page.locator('[name="login--userName"]').fill('Alen.Chua');
    });

    await test.step('填入「Alen.Chua」到「請輸入密碼」', async () => {
      await page.locator('[name="login--password"]').fill('Alen.Chua');
    });

    await test.step('點擊「登入」', async () => {
      await page.getByRole('button', { name: '登入', exact: true }).click();
    });

    await test.step('點擊「人事」', async () => {
      await page.locator('button').filter({ hasText: '人事' }).click();
    });

    await test.step('點擊「排班管理」', async () => {
      await page.getByRole('button', { name: '排班管理' }).click();
    });

    await test.step('點擊「排班查詢 ❐」', async () => {
      await page.getByRole('button', { name: '排班查詢 ❐' }).click();
    });
  });

  test('導航到 https://esd.genesys-tech.com/ → 點擊「庫存調整 ❐」', async ({ page }) => {
    await test.step('導航到 https://esd.genesys-tech.com/', async () => {
      await page.goto('https://esd.genesys-tech.com/');
    });

    await test.step('導航到 https://esd.genesys-tech.com/Login', async () => {
      await page.goto('https://esd.genesys-tech.com/Login');
    });

    await test.step('填入「Alen.Chua」到「請輸入帳號」', async () => {
      await page.locator('[name="login--userName"]').fill('Alen.Chua');
    });

    await test.step('填入「Alen.Chua」到「請輸入密碼」', async () => {
      await page.locator('[name="login--password"]').fill('Alen.Chua');
    });

    await test.step('點擊「登入」', async () => {
      await page.getByRole('button', { name: '登入', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('Login'), { timeout: 15000 });
    });

    await test.step('點擊「庫存管理」', async () => {
      await page.getByRole('button', { name: '庫存管理' }).click();
    });

    await test.step('點擊「庫存調整 ❐」', async () => {
      await page.getByRole('button', { name: '庫存調整 ❐' }).click();
    });
  });

});