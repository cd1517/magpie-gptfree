# magpie-gptfree

**独立的 Magpie ChatGPT/Codex TXT 批量导入插件，支持三段式 2FA、接码邮箱链接和第四字段 JWT access_token。** 完全不依赖 DSH，也不会调用 DSH 后端。

有两种使用模式：

| 模式 | 对应 Magpie Provider | 说明 |
| --- | --- | --- |
| **Token 号池（默认）** | `gptfree-pool` | 有效 JWT 优先经 Codex 服务验证，成功后直接复用；无效/过期时使用可见浏览器 OAuth + TOTP 登录，并加密保存到独立号池。失效时尝试重新授权 |
| **原生 Codex 导入** | Magpie 内置 ChatGPT/Codex | 通过 OAuth 获取 access/id/refresh 全套凭证，使用 `magpie accounts import codex` 导入。仅有 access_token 时不能跳过 OAuth |

另有 `gptfree-import` **工具插件入口**用于从 Magpie 内执行 TXT 导入，两种模式共用同一套解析与登录逻辑。

> ⚠️ Token 号池与原生 Codex 导入的代码及模拟测试已完成，尚未经过真实 ChatGPT 账号 + Windows Magpie 桌面端的完整联调。上游可能限制非官方客户端或账号能力。请先在有权使用的测试账号上验证。

## 一、支持的 TXT 格式

每行一条，`----` 或 `---` 分隔，允许混用。第四字段若存在，会自动识别类型。

| 格式 | 样例 | 处理方式 |
| --- | --- | --- |
| **1 · 标准三字段** | `邮箱----密码----2FA密钥` | 使用 Codex OAuth/PKCE，自动填入邮箱、密码和 TOTP |
| **2 · 带邮箱链接** | `邮箱----密码----2FA密钥----https://mail.xxx.store/...` | 自动识别第四字段为邮箱/接码链接，但**只使用前三字段登录**；不访问第三方邮箱链接 |
| **3 · 带 access_token** | `邮箱----密码----2FA密钥----eyJhbGci...` | 先判断 JWT 过期状态；**号池模式**再向 Codex `/models` 验证 Token，通过才直接复用；否则 OAuth + TOTP 重新登录 |
| 可选兼容 | `邮箱----密码` | 不要求 TOTP，若有人工验证仍需手动完成 |

TXT 示例，以下均为占位符：

```text
first@example.com----YOUR_PASSWORD----GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
second@example.com---YOUR_PASSWORD---GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ---https://mail.xxx.store/example
third@example.com----YOUR_PASSWORD----GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ----eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjQ3MzM4NTYwMDB9.EXAMPLE_SIGNATURE
```

**注意：** 本地解析 JWT 的 `exp` 只说明其声明的到期时间，**不能验证签名或真实使用权限**。必须有 Codex 上游 `/models` 成功响应，才按“复用 Token”记录。单独 access_token 没有 refresh_token，不能被原生 Codex 导入器当作可长期续期的登录。

## 二、安装（Windows / macOS / Linux）

准备 Magpie、Node.js 20+、Chrome 或 Edge。执行：

```powershell
git clone --branch feat/standalone-batch-2fa https://github.com/yang0/magpie-gptfree.git
cd magpie-gptfree
npm install
```

开发分支尚未合入 main。请不要把真实账号 TXT 加入 Git 仓库，也不要将 TXT 发给其他人。

## 三、推荐：独立 Token 号池（优先复用有效 Token）

先检查 TXT 格式（不会登录或联网）：

```powershell
node bin/import.mjs --file .\accounts.txt --dry-run
```

然后导入（默认 `--mode pool`，完整参数如下）：

```powershell
node bin/import.mjs --file .\accounts.txt --mode pool --i-own-these-accounts
```

- 对第三种格式，先调用真实 Codex 模型接口确认该 Token 可用，再加密入池，跳过浏览器登录。
- 对三字段账号、附带邮箱链接的账号、失效/过期 Token，则打开可见 Chrome/Edge，完成 Codex OAuth + PKCE + TOTP；安全挑战需要用户自己操作。
- 号池保存在当前 OS 用户的 `~/.magpie-gptfree/`：`pool.enc.json` 是 AES-256-GCM 密文，`master.key` 是同用户专有的本地密钥（**不是系统硬件密钥库**）；绝不可泄漏密钥、备份明文账号或把数据目录共享出去。
- Token 过期或上游返回 401 时，运行中的 Provider 会尝试通过可见浏览器重新 OAuth。**这不是无交互保证**；遇到额外验证需要用户介入，浏览器不可用时账号会标记为不可用并可切换其他账号。

将插件安装到 Magpie，启用号池供应商：

```powershell
magpie plugin add .
magpie plugin login gptfree-pool
magpie provider gptfree-pool
```

随后在 Magpie Agents / Provider 中选择 `gptfree-pool/<模型 ID>`。模型列表来自 Codex 上游 `/models`，不会凭空声明不存在的模型。

## 四、原生 Codex 模式（需要 refresh_token）

如果希望导入到 Magpie 内置 ChatGPT/Codex 账号列表，而不是独立号池：

```powershell
node bin/import.mjs --file .\accounts.txt --mode native --i-own-these-accounts
magpie accounts codex
```

该模式永远通过 Codex OAuth 获取完整 `access_token` / `id_token` / `refresh_token`，并通过 Magpie CLI 进行原生导入；不将 access-only JWT 伪造成刷新凭证。

## 五、从 Magpie 插件界面启动导入

```powershell
magpie plugin add .
magpie plugin login gptfree-import
```

按提示选择 TXT 完整路径、`pool` 或 `native` 模式，并确认账号所有权。成功后：

- 选 `pool`：需要另外启用 `gptfree-pool` 才能选择模型。
- 选 `native`：到 Magpie 原生 ChatGPT/Codex 账号列表查看。

Magpie 插件宿主中启动本地 Playwright 和 Magpie CLI 仍需在真实桌面端验证。CLI 方式目前更适合先测试。

## 安全与限制

- 只导入自己有合法使用权的账号，遵守上游规则。此工具不生成账号、不代购、不共享账号。
- 不破解验证码、不绕过 2FA/风控；页面需要短信、邮件或验证码时由用户自行确认。
- 第四字段中的第三方邮箱链接**永远不会被自动访问**，防止接码链接导致数据泄露。
- TXT 密码、TOTP、JWT 不出现在 dry-run、成功日志、失败报告中。不会把账号资料发给仓库、DSH 或其他外部代理。
- 通过 HTTPS 访问 OpenAI 认证与 Codex 服务，禁用自动 HTTP 重定向；临时 OAuth 文件使用受限制的本地权限并删除。
- 账号的 Token、模型权限和配额因套餐而异；免费 ChatGPT 账号不等于无限免费 API 调用。短期 Token 无法保证长期有效，重新授权也可能失败。
- **实际 Codex Responses 协议可能变化**，本插件的请求适配和多账号流式调用尚需真实账号端到端验证。
- 不建议两个导入进程同时写入一个加密号池目录；Windows ACL 和文件备份权限需额外检查。

## 测试

```bash
npm run check
npm test
```

测试涵盖：三种格式、分隔符、TOTP、JWT 过期和上游确认、Token 优先复用/失败回退、加密存储、请求转发、账号切换与敏感数据脱敏。测试均使用模拟 Token，不连接真实 OpenAI 账号。

开发进度：[Issue #1](https://github.com/yang0/magpie-gptfree/issues/1) · [Draft PR #2](https://github.com/yang0/magpie-gptfree/pull/2)。
