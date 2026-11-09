import { readFile, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { parseAccounts, safeAccountName } from "./credentials.mjs";
import { codexAuthJSON } from "./oauth.mjs";
import { loginAccount, launchBrowser } from "./login.mjs";
import { verifyAccessToken } from "./codex-pool.mjs";
import { upsertPool } from "./pool-vault.mjs";

const exec = promisify(execFile);

export async function nativeImport(tokens, { magpie = "magpie" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "magpie-gptfree-"));
  const path = join(directory, "auth.json");
  try {
    await chmod(directory, 0o700);
    await writeFile(path, JSON.stringify(codexAuthJSON(tokens)), { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    try {
      await exec(magpie, ["accounts", "import", "codex", path, "--yes"], {
        timeout: 120000, maxBuffer: 512 * 1024, windowsHide: true,
        shell: false,
      });
    } catch (err) {
      const code = String(err.code || "unknown").slice(0, 30);
      if (code === "ENOENT") throw new Error("找不到 Magpie 命令。请检查 PATH 或通过 --magpie 指定 magpie.exe 完整路径");
      throw new Error("Magpie 账号导入失败（进程状态：" + code + "）。请在 Magpie 中检查账号状态");
    }
    return true;
  } finally {
    // Do not keep a long-lived second owner of the refresh token. Magpie
    // rotates it during import; any temporary file is then invalid anyway.
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runBatch({
  file, consent = false, dryRun = false, magpie = "magpie", proxy = "",
  mode = "native",
  onProgress = () => {}, signal,
  read = readFile, openBrowser = launchBrowser, login = loginAccount,
  importAccount = nativeImport, verifyToken = verifyAccessToken, savePool = upsertPool,
} = {}) {
  if (!file || typeof file !== "string") throw new Error("请指定 TXT 文件的完整路径");
  if (!["native", "pool"].includes(mode)) throw new Error("导入模式只能是 native 或 pool");
  const raw = await read(file, "utf8");
  const parsed = parseAccounts(raw);
  if (dryRun) {
    return {
      total: parsed.accounts.length, duplicates: parsed.duplicates,
      invalid: parsed.errors, added: 0, failed: [], mode,
      ready: parsed.accounts.map((a) => ({
        line: a.line, email: safeAccountName(a.email),
        has2FA: !!a.totp,
        kind: a.kind,
        tokenState: a.kind === "access_token" ? a.tokenState : undefined,
      })),
    };
  }
  if (!consent) throw new Error("导入真实账号前必须明确确认仅使用本人有权管理的账号（--i-own-these-accounts）");
  if (parsed.accounts.length === 0) throw new Error("TXT 中没有有效账号");
  if (parsed.errors.length) throw new Error("TXT 存在格式错误；请先运行 --dry-run 检查（不会输出密码）");
  if (proxy) {
    let p;
    try { p = new URL(proxy); } catch { throw new Error("代理地址格式不正确"); }
    if (!["http:", "https:"].includes(p.protocol) || p.username || p.password)
      throw new Error("代理只允许不带密码的 http(s)://host:port 地址");
  }
  let browser;
  const getBrowser = async () => {
    if (!browser) browser = await openBrowser({ proxy });
    return browser;
  };
  const result = {
    total: parsed.accounts.length, added: 0, reused: 0,
    mode, failed: [],
    duplicates: parsed.duplicates, invalid: [],
    formats: { standard: 0, mail_link: 0, access_token: 0 },
    tokenNeedsOAuth: 0,
  };
  try {
    for (const account of parsed.accounts) {
      if (signal?.aborted) throw new Error("批量导入已取消");
      result.formats[account.kind]++;
      const safe = { email: safeAccountName(account.email), line: account.line };
      if (account.kind === "mail_link") {
        // The link is source metadata, never opened or fetched by this tool.
        onProgress({ state: "mail_link_ignored", ...safe });
      }
      try {
        if (account.kind === "access_token") {
          if (mode === "pool" && account.tokenState === "unexpired_unverified") {
            // This is an actual *server* check, not local JWT decoding.
            const probe = await verifyToken(account.accessToken, { expectedEmail: account.email, signal });
            if (probe.accepted) {
              await savePool({
                email: account.email, password: account.password,
                totp: account.totp, accessToken: account.accessToken,
              });
              result.added++;
              result.reused++;
              onProgress({ state: "token_reused", ...safe });
              continue;
            }
          }
          // Native Codex import needs id + refresh, even for an unexpired
          // access token; a rejected/expired pool candidate also needs OAuth.
          result.tokenNeedsOAuth++;
          onProgress({
            state: account.tokenState === "expired" ? "token_expired" : "token_needs_oauth",
            ...safe,
          });
        }
        onProgress({ state: "authorizing", ...safe });
        const { tokens } = await login(account, { browser: await getBrowser(), signal, proxy });
        if (mode === "pool") {
          const probe = await verifyToken(tokens.access, { expectedEmail: account.email, signal });
          if (!probe.accepted) throw new Error("Codex OAuth 登录完成，但账号没有可使用的 Codex 模型");
          await savePool({ email: account.email, password: account.password, totp: account.totp, accessToken: tokens.access });
        } else {
          await importAccount(tokens, { magpie });
        }
        result.added++;
        onProgress({ state: "added", ...safe });
      } catch (err) {
        // Never forward arbitrary upstream errors to logs or UI; their bodies
        // could contain a password, code, or OAuth token.
        const message = String(err?.message || "");
        const known = /端口不可用|登录超时|OAuth 登录已取消|找不到 Magpie 命令|Magpie 账号导入失败|浏览器返回了其他账号|无法启动浏览器|OAuth Token 交换|OAuth 未返回|OAuth Token 响应/.test(message);
        const error = known ? message.slice(0, 180) : "登录未完成；请检查浏览器中的人工验证、账号状态或网络连接";
        result.failed.push({ line: account.line, email: safeAccountName(account.email), reason: error });
        onProgress({ state: "failed", email: safeAccountName(account.email), line: account.line, reason: error });
      }
    }
  } finally {
    await browser?.close();
  }
  return result;
}
