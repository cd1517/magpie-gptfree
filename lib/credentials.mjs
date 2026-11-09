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

function validateSafeHttpUrl(raw, errorLabel) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname ||
        u.username || u.password || raw.length > 8192) {
      return { error: errorLabel };
    }
    return { ok: true, url: raw };
  } catch {
    return { error: errorLabel };
  }
}

export function validateProxyUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: true, proxy: "" };
  let u;
  try { u = new URL(value); } catch {
    return { error: "代理地址格式不正确" };
  }
  if (!["http:", "https:"].includes(u.protocol) || !u.hostname ||
      u.username || u.password || value.length > 512) {
    return { error: "代理只允许无认证的 http(s) URL" };
  }
  return { ok: true, proxy: value };
}

function classifyFourth(value) {
  if (!value) return { error: "第四字段为空" };
  if (/^https?:\/\//i.test(value)) {
    const check = validateSafeHttpUrl(value, "邮箱链接格式不正确");
    if (check.error) return check;
    // Metadata only: not fetched, never sent to a different host.
    return { kind: "mail_link", mailUrl: check.url };
  }
  const sep = /-{3,}/.exec(value);
  if (sep) {
    const rawCol4 = value.slice(0, sep.index).trim();
    const rawCol5 = value.slice(sep.index + sep[0].length).trim();
    if (!rawCol4) return { error: "第四字段为空" };
    if (!rawCol5) return { error: "第五字段为空" };
    const tok4 = rawCol4.replace(/^Bearer\s+/i, "").trim();
    if (tok4.startsWith("eyJ")) {
      const info4 = accessTokenState(tok4);
      if (info4.state === "invalid") return { error: "第四字段 JWT Token 格式不正确" };
      if (/^https?:\/\//i.test(rawCol5)) {
        const url5 = validateSafeHttpUrl(rawCol5, "第五字段邮箱链接格式不正确");
        if (url5.error) return url5;
        return { kind: "access_token", accessToken: tok4, tokenState: info4.state, mailUrl: url5.url };
      }
      if (rawCol5.length > 8192 || /[\r\n\0\s]/.test(rawCol5))
        return { error: "第五字段 Token 格式不正确" };
      return { kind: "access_token", accessToken: tok4, tokenState: info4.state, hasRefreshToken: true };
    }
    const tok5 = rawCol5.replace(/^Bearer\s+/i, "").trim();
    if (tok5.startsWith("eyJ") && rawCol4.length <= 8192 && !/[\r\n\0\s]/.test(rawCol4)) {
      const info5 = accessTokenState(tok5);
      if (info5.state === "invalid") return { error: "第五字段 JWT Token 格式不正确" };
      return { kind: "access_token", accessToken: tok5, tokenState: info5.state, hasRefreshToken: true };
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
      errors.push({ line: number, reason: "应为 邮箱----密码----2FA密钥[----邮箱链接/Token][----RefreshToken]" });
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
