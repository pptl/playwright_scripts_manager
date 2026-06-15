import { test, expect } from '@playwright/test';


test.describe('flow6', () => {

  test('導航到 https://esd.genesys-tech.com/ → 導航到 https://esd.genesys-tech.com/ScheduleClass/ScheduleClassFirst', async ({ page }) => {
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
      await page.getByRole("button", { name: "登入", exact: true }).click();
    });

    await test.step('導航到 https://esd.genesys-tech.com/Index/Home', async () => {
      await page.goto('https://esd.genesys-tech.com/Index/Home');
    });

    await test.step('點擊「topMainNavBar」', async () => {
      await page.getByText("人事", { exact: true }).click();
    });

    await test.step('點擊「排班管理」', async () => {
      await page.getByRole("button", { name: "排班管理", exact: true }).click();
    });

    await test.step('點擊「排班查詢❐」', async () => {
      await page.getByRole("button", { name: "排班查詢", exact: false }).click();
    });

    await test.step('導航到 https://esd.genesys-tech.com/ScheduleClass/ScheduleClassFirst', async () => {
      await page.goto('https://esd.genesys-tech.com/ScheduleClass/ScheduleClassFirst');
    });
  });

});