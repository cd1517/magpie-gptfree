#!/usr/bin/env node
import { runBatch } from "../lib/importer.mjs";

const args = process.argv.slice(2);
const showHelp = () => {
  console.log(`Magpie GPTFree standalone batch importer

用法：
  npx magpie-gptfree --file accounts.txt --dry-run
  npx magpie-gptfree --file accounts.txt --i-own-these-accounts --mode pool
  node bin/import.mjs --file accounts.txt --i-own-these-accounts

可选：
  --magpie "C:\\path\\to\\magpie.exe"    指定 Magpie CLI
  --proxy http://127.0.0.1:7890        指定可信的 HTTP(S) 代理
  --dry-run                            只检查 TXT 格式（不登录）
  --mode pool|native                   pool=短期 Token 号池（默认）；native=原生 Codex 导入
  --i-own-these-accounts               确认账号归属/管理权
  --help                               查看帮助

TXT 格式：邮箱----密码----Base32 TOTP密钥；没有 2FA 可仅填邮箱----密码。
注：浏览器中需要手动完成的验证码/额外验证不会被自动绕过。
`);
};
if (args.includes("--help") || args.includes("-h")) { showHelp(); process.exit(0); }
const get = (key) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : ""; };
const file = get("--file") || args.find((x) => !x.startsWith("-") && !args[args.indexOf(x) - 1]?.startsWith("--"));
if (!file) { showHelp(); process.exitCode = 2; }
else {
  try {
    const result = await runBatch({
      file,
      magpie: get("--magpie") || "magpie",
      mode: get("--mode") || "pool",
      proxy: get("--proxy") || "",
      dryRun: args.includes("--dry-run"),
      consent: args.includes("--i-own-these-accounts"),
      onProgress: ({ state, email, line, reason }) => {
        console.log(`第 ${line} 行 ${email}: ${state}${reason ? " (" + reason + ")" : ""}`);
      },
    });
    if (args.includes("--dry-run")) {
      for (const item of result.ready) console.log(`第 ${item.line} 行 ${item.email} · ${item.has2FA ? "TOTP" : "无 TOTP"}`);
      for (const err of result.invalid) console.log(`第 ${err.line} 行：${err.reason}`);
      console.log(`有效 ${result.total}，重复 ${result.duplicates}，错误 ${result.invalid.length}`);
      if (result.invalid.length) process.exitCode = 2;
    } else {
      console.log(`模式: ${result.mode}; 成功: ${result.added}/${result.total}; 复用有效 Token: ${result.reused}; 失败: ${result.failed.length}，重复: ${result.duplicates}`);
      if (result.failed.length) process.exitCode = 1;
    }
  } catch (err) {
    console.error(String(err?.message || "导入失败"));
    process.exitCode = 2;
  }
}
