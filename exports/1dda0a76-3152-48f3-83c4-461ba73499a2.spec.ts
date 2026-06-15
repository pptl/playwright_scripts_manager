import { test, expect } from '@playwright/test';


test.describe('flow8', () => {

  test('導航到 https://esd.genesys-tech.com/ → 導航到 https://esd.genesys-tech.com/LeaveRemain/LeaveRemainStatistic', async ({ page }) => {
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
      await page.locator("button[type=\"button\"]").click();
    });

    await test.step('點擊「計薪休假」', async () => {
      await page.getByRole("button", { name: "計薪休假", exact: true }).click();
    });

    await test.step('點擊「休假結算 ❐」', async () => {
      await page.getByRole("button", { name: "休假結算 ❐", exact: true }).click();
    });

    await test.step('導航到 https://esd.genesys-tech.com/LeaveRemain/LeaveRemainStatistic', async () => {
      await page.goto('https://esd.genesys-tech.com/LeaveRemain/LeaveRemainStatistic');
    });
  });

});