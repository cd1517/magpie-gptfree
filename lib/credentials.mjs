import { createHmac } from "node:crypto";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE32 = /^[A-Z2-7]+=*$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const MAX_ACCOUNTS = 100;
export const MAX_BYTES = 1024 * 1024;

/**
 * Split on at most the first THREE 3+-dash separators; any dashes inside
 * the last URL/token remain untouched. Supports ----, --- and mixed files.
 */
export function splitAccountLine(line) {
  const fields = [], re = /-{3,}/g;
  let start = 0, match;
  while (fields.length < 3 && (match = re.exec(line))) {
    fields.push(line.slice(start, match.index).trim());
    start = re.lastIndex;
  }
  fields.push(line.slice(start).trim());
  return fields;
}

function jwtPayload(token) {
  try {
    const raw = token.split(".")[1];
    if (!raw || raw.length > 65536) return null;
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Local claims are never cryptographic validation. Even "unexpired" does
 * NOT mean OpenAI has accepted the token or granted Codex permission.
 */
export function accessTokenState(token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 8192 || !JWT.test(token))
    return { state: "invalid" };
  const payload = jwtPayload(token);
  if (!payload) return { state: "invalid" };
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp))
    return { state: "unknown" };
  const time = Math.floor(now / 1000);
  if (payload.exp <= time + 120) return { state: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > time + 60)
    return { state: "not_yet_valid" };
  return { state: "unexpired_unverified" };
}

function classifyFourth(value) {
  if (!value) return { error: "第四字段为空" };
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      if (!["http:", "https:"].includes(u.protocol) || !u.hostname ||
          u.username || u.password || value.length > 8192) {
        return { error: "邮箱链接格式不正确" };
      }
      // Metadata only: not fetched, never sent to a different host.
      return { kind: "mail_link", mailUrl: value };
    } catch {
      return { error: "邮箱链接格式不正确" };
    }
  }
  const token = value.replace(/^Bearer\s+/i, "").trim();
  if (token.startsWith("eyJ")) {
    const info = accessTokenState(token);
    if (info.state === "invalid") return { error: "第四字段 JWT Token 格式不正确" };
    return { kind: "access_token", accessToken: token, tokenState: info.state };
  }
  return { error: "第四字段只能是 http(s) 邮箱链接或 JWT access_token" };
}

export function parseAccounts(content) {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_BYTES)
    throw new Error("账号文件超过 1 MiB 或不是 UTF-8 文本");
  const accounts = [], errors = [], seen = new Set();
  let duplicates = 0;
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim(), number = i + 1;
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const cols = splitAccountLine(line);
    if (cols.length < 2 || cols.length > 4) {
      errors.push({ line: number, reason: "应为 邮箱----密码----2FA密钥[----邮箱链接或Token]" });
      continue;
    }
    const [rawEmail, password, rawSeed = "", fourth] = cols;
    const email = rawEmail.toLowerCase();
    const totp = rawSeed.replace(/[\s-]/g, "").toUpperCase();
    if (!EMAIL.test(email) || email.length > 254) {
      errors.push({ line: number, reason: "邮箱格式不正确" }); continue;
    }
    if (!password || password.length > 512 || /[\r\n\0]/.test(password)) {
      errors.push({ line: number, reason: "密码为空或太长" }); continue;
    }
    if (totp && (!BASE32.test(totp) || totp.replace(/=+$/, "").length < 16)) {
      errors.push({ line: number, reason: "2FA密钥不是合法的 Base32 TOTP Secret" }); continue;
    }
    const extra = cols.length === 4 ? classifyFourth(fourth) : { kind: "standard" };
    if (extra.error) {
      errors.push({ line: number, reason: extra.error }); continue;
    }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    accounts.push({ email, password, totp, line: number, ...extra });
    if (accounts.length > MAX_ACCOUNTS)
      throw new Error("单次最多导入 100 个账号；请分批执行");
  }
  return { accounts, errors, duplicates };
}

export function totpCode(seed, now = Date.now()) {
  const normalized = String(seed).toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized))
    throw new Error("TOTP Secret 无效");
  let bits = 0, buffer = 0;
  const bytes = [];
  for (const ch of normalized) {
    const v = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits -= 8)) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  const time = BigInt(Math.floor(now / 30000));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(time);
  const hash = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const n = hash[hash.length - 1] & 0x0f;
  return String(((hash.readUInt32BE(n) & 0x7fffffff) % 1000000)).padStart(6, "0");
}

export function safeAccountName(email) {
  const [name, domain] = email.split("@");
  return name.length <= 2 ? "*@" + domain : name.slice(0, 2) + "***@" + domain;
}
