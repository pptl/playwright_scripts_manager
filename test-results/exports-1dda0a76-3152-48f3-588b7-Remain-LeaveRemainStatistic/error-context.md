# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: exports\1dda0a76-3152-48f3-83c4-461ba73499a2.spec.ts >> flow8 >> 導航到 https://esd.genesys-tech.com/ → 導航到 https://esd.genesys-tech.com/LeaveRemain/LeaveRemainStatistic
- Location: exports\1dda0a76-3152-48f3-83c4-461ba73499a2.spec.ts:6:7

# Error details

```
Error: locator.click: Error: strict mode violation: locator('button[type="button"]') resolved to 4 elements:
    1) <button tabindex="0" type="button" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiOtherButton contactUs_Btn">…</button> aka getByRole('button', { name: '進入官網' }).first()
    2) <button tabindex="0" type="button" class="MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton MuiButton-containedPrimary MuiButton-fullWidth">…</button> aka getByRole('button', { name: '登入', exact: true })
    3) <button tabindex="0" type="button" class="MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton MuiButton-containedPrimary MuiButton-fullWidth">…</button> aka getByRole('button', { name: '寄送新密碼' })
    4) <button tabindex="0" type="button" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiOtherButton contactUs_Btn">…</button> aka getByRole('button', { name: '進入官網' }).nth(2)

Call log:
  - waiting for locator('button[type="button"]')

```

# Page snapshot

```yaml
- main [ref=e3]:
  - generic [ref=e5]:
    - generic [ref=e7]:
      - generic [ref=e9]:
        - generic [ref=e10]: 聯絡我們
        - generic [ref=e11]: 有任何疑問嗎？歡迎與我們聯繫
        - button "進入官網" [ref=e12] [cursor=pointer]:
          - button "進入官網" [ref=e14]
      - generic [ref=e15]:
        - heading "登入" [level=1] [ref=e16]
        - generic [ref=e17]:
          - generic [ref=e18]:
            - generic:
              - text: 使用者帳號
              - generic: "*"
            - generic [ref=e19]:
              - textbox "請輸入帳號" [ref=e20]
              - group
          - generic [ref=e21]:
            - generic:
              - text: 密碼
              - generic: "*"
            - generic [ref=e22]:
              - textbox "請輸入密碼" [ref=e23]
              - group
          - generic [ref=e24] [cursor=pointer]:
            - generic [ref=e26]:
              - checkbox "記住我的登入狀態" [ref=e27]
              - img [ref=e28]
            - generic [ref=e30]: 記住我的登入狀態
          - button "登入" [ref=e31] [cursor=pointer]:
            - generic: 登入
          - button "忘記密碼 ?" [ref=e34] [cursor=pointer]
        - paragraph [ref=e36]:
          - text: Copyright © 2026
          - button "Genesys Technology Ltd." [ref=e37] [cursor=pointer]
          - text: All rights reserved.
    - generic [ref=e39]:
      - generic [ref=e40]:
        - heading "忘記密碼" [level=1] [ref=e41]
        - paragraph [ref=e42]: 請輸入帳號與註冊時綁定之E-mail，我們將為您產生新密碼寄至您的信箱
        - generic [ref=e43]:
          - generic [ref=e44]:
            - generic:
              - text: 使用者帳號
              - generic: "*"
            - generic [ref=e45]:
              - textbox "請輸入帳號" [ref=e46]
              - group
          - generic [ref=e47]:
            - generic:
              - text: 信箱
              - generic: "*"
            - generic [ref=e48]:
              - textbox "請輸入信箱" [active] [ref=e49]
              - group
          - button "寄送新密碼" [ref=e50] [cursor=pointer]:
            - generic: 寄送新密碼
          - button "再次登入" [ref=e53] [cursor=pointer]
      - generic [ref=e55]:
        - generic [ref=e56]: 聯絡我們
        - generic [ref=e57]: 還是無法登入嗎？請與我們聯繫
        - button "進入官網" [ref=e58] [cursor=pointer]:
          - button "進入官網" [ref=e60]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | 
  4  | test.describe('flow8', () => {
  5  | 
  6  |   test('導航到 https://esd.genesys-tech.com/ → 導航到 https://esd.genesys-tech.com/LeaveRemain/LeaveRemainStatistic', async ({ page }) => {
  7  |     await test.step('導航到 https://esd.genesys-tech.com/', async () => {
  8  |       await page.goto('https://esd.genesys-tech.com/');
  9  |     });
  10 | 
  11 |     await test.step('導航到 https://esd.genesys-tech.com/Login', async () => {
  12 |       await page.goto('https://esd.genesys-tech.com/Login');
  13 |     });
  14 | 
  15 |     await test.step('填入「Alen.Chua」到「請輸入帳號」', async () => {
  16 |       await page.locator('[name="login--userName"]').fill('Alen.Chua');
  17 |     });
  18 | 
  19 |     await test.step('填入「Alen.Chua」到「請輸入密碼」', async () => {
  20 |       await page.locator('[name="login--password"]').fill('Alen.Chua');
  21 |     });
  22 | 
  23 |     await test.step('點擊「登入」', async () => {
  24 |       await page.getByRole("button", { name: "登入", exact: true }).click();
  25 |     });
  26 | 
  27 |     await test.step('導航到 https://esd.genesys-tech.com/Index/Home', async () => {
  28 |       await page.goto('https://esd.genesys-tech.com/Index/Home');
  29 |     });
  30 | 
  31 |     await test.step('點擊「topMainNavBar」', async () => {
> 32 |       await page.locator("button[type=\"button\"]").click();
     |                                                     ^ Error: locator.click: Error: strict mode violation: locator('button[type="button"]') resolved to 4 elements:
  33 |     });
  34 | 
  35 |     await test.step('點擊「計薪休假」', async () => {
  36 |       await page.getByRole("button", { name: "計薪休假", exact: true }).click();
  37 |     });
  38 | 
  39 |     await test.step('點擊「休假結算 ❐」', async () => {
  40 |       await page.getByRole("button", { name: "休假結算 ❐", exact: true }).click();
  41 |     });
  42 | 
  43 |     await test.step('導航到 https://esd.genesys-tech.com/LeaveRemain/LeaveRemainStatistic', async () => {
  44 |       await page.goto('https://esd.genesys-tech.com/LeaveRemain/LeaveRemainStatistic');
  45 |     });
  46 |   });
  47 | 
  48 | });
```