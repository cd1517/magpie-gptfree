import { totpCode } from "./credentials.mjs";
import { makePKCE, authorizationURL, startCallback, exchangeCode, signedInEmail } from "./oauth.mjs";

const AUTH_HOSTS = new Set(["auth.openai.com", "chatgpt.com"]);

async function available(locator) {
  try { return await locator.first().isVisible(); }
  catch { return false; }
}

async function submit(field, page) {
  const formButton = page.locator('button[type="submit"], input[type="submit"]');
  try {
    if (await available(formButton) && await formButton.first().isEnabled()) {
      await formButton.first().click({ timeout: 2500 }); return;
    }
  } catch {}
  try { await field.press("Enter", { timeout: 2500 }); } catch {}
}

// Only normal first-party email/password/TOTP fields are filled.
// CAPTCHA, external SSO, email confirmation and suspicious-activity challenges
// are never automated; the owner finishes them in the visible browser.
async function fillNormalFields(page, account, done) {
  const filled = { email: false, password: false, otp: false };
  while (!done() && !page.isClosed()) {
    let host = "";
    try { host = new URL(page.url()).hostname; } catch {}
    if (!AUTH_HOSTS.has(host)) {
      await page.waitForTimeout(650);
      continue;
    }
    try {
      const email = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]');
      if (!filled.email && await available(email)) {
        await email.first().fill(account.email, { timeout: 2000 });
        filled.email = true;
        await submit(email.first(), page);
        await page.waitForTimeout(1000);
        continue;
      }
      const password = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]');
      if (!filled.password && await available(password)) {
        await password.first().fill(account.password, { timeout: 2000 });
        filled.password = true;
        await submit(password.first(), page);
        await page.waitForTimeout(1000);
        continue;
      }
      const otp = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[inputmode="numeric"]');
      if (!filled.otp && account.totp && await available(otp)) {
        await otp.first().fill(totpCode(account.totp), { timeout: 2000 });
        filled.otp = true;
        await submit(otp.first(), page);
        await page.waitForTimeout(1000);
        continue;
      }
    } catch {
      // The page may navigate between locating and filling. Leave manual
      // sign-in available instead of retrying credentials on another form.
    }
    await page.waitForTimeout(650);
  }
}

export async function launchBrowser({ proxy = "" } = {}) {
  const { chromium } = await import("playwright");
  const network = proxy ? { proxy: { server: proxy } } : {};
  let lastError;
  for (const settings of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try { return await chromium.launch({ ...settings, ...network, headless: false }); }
    catch (e) { lastError = e; }
  }
  throw new Error("无法启动浏览器。请安装 Chrome / Edge 或运行 npx playwright install chromium：" + String(lastError?.message || "").slice(0, 130));
}

export async function loginAccount(account, { browser, signal, timeoutMs = 180000 } = {}) {
  if (!browser) throw new Error("缺少浏览器实例");
  const pkce = makePKCE();
  const callback = await startCallback({ state: pkce.state, timeoutMs, signal });
  let context;
  try {
    context = await browser.newContext({ acceptDownloads: false, ignoreHTTPSErrors: false });
    const page = await context.newPage();
    await page.goto(authorizationURL({ ...pkce, email: account.email }), {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
    let finished = false, error, code;
    const awaited = callback.wait().then(
      (value) => { code = value; finished = true; },
      (e) => { error = e; finished = true; },
    );
    await fillNormalFields(page, account, () => finished || signal?.aborted);
    await awaited;
    if (error) throw error;
    const tokens = await exchangeCode(code, pkce.verifier, { signal });
    const email = signedInEmail(tokens);
    // A browser with a previous session may silently authorize the wrong account.
    // Never import it under the email supplied in the TXT.
    if (email && email !== account.email) {
      throw new Error("浏览器返回了其他账号的授权，已拒绝导入（请检查登录状态）");
    }
    return { tokens, email: email || account.email };
  } finally {
    try { await context?.close(); } catch {}
    await callback.close();
  }
}
