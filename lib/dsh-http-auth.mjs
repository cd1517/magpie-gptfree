/**
 * Standalone DSH-compatible HTTP password + TOTP authentication adapter.
 * No DSH service, no Playwright and no Codex CLI process.
 *
 * The Python worker was adapted from yang0/chatgpt2api-dsh and retains the
 * Platform OAuth client and curl_cffi request flow. Platform tokens are NOT
 * assumed to be accepted by the Codex backend: callers must validate them
 * against the actual model endpoint before placing accounts in the pool.
 */
import { spawn } from "node:child_process";
import { readFile, mkdir, access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PYDIR = join(dirname(fileURLToPath(import.meta.url)), "../python");
const WORKER = join(PYDIR, "auth_worker.py");
const REQUIREMENTS = join(PYDIR, "requirements.txt");
const ROOT = process.env.MAGPIE_GPTFREE_HOME || join(homedir(), ".magpie-gptfree");
const VENV = join(ROOT, "python-venv");
const VENV_BIN = platform() === "win32" ? join(VENV, "Scripts", "python.exe") : join(VENV, "bin", "python");
let setup = null;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function run(command, args, { input = "", timeout = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      signal, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" },
    });
    let stdout = "", stderr = "", ended = false;
    const timer = setTimeout(() => child.kill(), timeout);
    timer.unref?.();
    function finish(err, output) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(output);
    }
    child.once("error", () => finish(new Error("Python authentication worker could not start")));
    child.stdout.on("data", (part) => {
      stdout += String(part);
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (part) => {
      stderr += String(part);
      if (stderr.length > 1024 * 1024) child.kill();
    });
    child.once("close", (code) => {
      if (code !== 0) finish(new Error("Python authentication worker stopped"));
      else finish(null, stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function locatePython() {
  if (process.env.MAGPIE_GPTFREE_PYTHON) {
    const python = process.env.MAGPIE_GPTFREE_PYTHON;
    await run(python, ["-c", "import sys;print(sys.version_info.major)"], { timeout: 15000 });
    return { python, prefix: [] };
  }
  const candidates = platform() === "win32" ?
    [{ python: "py", prefix: ["-3"] }, { python: "python", prefix: [] }] :
    [{ python: "python3", prefix: [] }, { python: "python", prefix: [] }];
  for (const candidate of candidates) {
    try {
      const out = await run(candidate.python, [...candidate.prefix, "-c", "import sys;print(sys.version_info.major)"], { timeout: 15000 });
      if (out.trim() === "3") return candidate;
    } catch {}
  }
  throw new Error("未找到可用 Python 3，GPTFree 的 HTTP 登录运行环境无法初始化");
}

async function ensureWorkerPython() {
  if (await exists(VENV_BIN)) {
    try {
      await run(VENV_BIN, ["-c", "import curl_cffi"], { timeout: 15000 });
      return VENV_BIN;
    } catch {}
  }
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  const base = await locatePython();
  if (!(await exists(VENV_BIN)))
    await run(base.python, [...base.prefix, "-m", "venv", VENV], { timeout: 180000 });
  // Installer writes only to GPTFree's own isolated Python environment.
  // No DSH instance, global pip configuration or parent app is modified.
  await run(VENV_BIN, ["-m", "pip", "install", "--disable-pip-version-check",
    "-r", REQUIREMENTS], { timeout: 300000 });
  await run(VENV_BIN, ["-c", "import curl_cffi"], { timeout: 15000 });
  return VENV_BIN;
}

export async function workerPython() {
  if (!setup) setup = ensureWorkerPython().catch((error) => {
    setup = null;
    throw error;
  });
  return setup;
}

export function normalizeWorkerResult(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw)); }
  catch { throw new Error("DSH HTTP 登录后端返回无效数据"); }
  if (parsed?.ok !== true)
    throw new Error("DSH HTTP 授权未完成（" + String(parsed?.error || "auth_failed").slice(0, 80) + "）");
  const accessToken = String(parsed.access_token || "");
  if (!accessToken || accessToken.length > 16384)
    throw new Error("HTTP 登录成功，但没有返回可用 access_token");
  return {
    access: accessToken,
    refresh: String(parsed.refresh_token || ""),
    id: String(parsed.id_token || ""),
  };
}

export async function loginHTTPAccount(account, { signal, proxy = "",
  worker = run, python = workerPython } = {}) {
  if (!account?.email || !account?.password)
    throw new Error("HTTP 登录需要邮箱和密码");
  if (signal?.aborted) throw new Error("HTTP 登录已取消");
  const command = await python();
  // One account per isolated worker so a failed account does not invalidate
  // a whole TXT batch. Input is never an argv argument or a log message.
  const output = await worker(command, [WORKER], {
    input: JSON.stringify({
      action: "authenticate", email: account.email, password: account.password,
      totp_secret: account.totp || "", proxy,
    }),
    timeout: 180000, signal,
  });
  const tokens = normalizeWorkerResult(output);
  return { tokens, email: account.email };
}
