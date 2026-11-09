# Magpie GPTFree · 内嵌多账号批量导入

**Magpie 窗口内的账号导入表单**，支持选择或拖入 TXT 直接填入可编辑文本框、按行预览与修正、跳过错误行、多批次追加、批量检测/刷新以及多账号自动轮询与故障转移。无需终端操作、不单独打开 GPTFree 导入网页，不依赖 DSH 插件或服务。

> 当前版本 v0.5.0：基于独立 Python HTTP worker（DSH 风格密码/TOTP 认证）移植实现。**代码和模拟测试不代表真实 OpenAI 账号已完成端到端验收。** 请勿把 Platform OAuth 获取成功等同于 Magpie Codex 模型可用。

## 一、用户界面

启动 Magpie，打开左侧 **Plugins → GPTFree 账号导入**，或在 **Providers** 页面右键提供商行选择 **「GPTFree 批量导入 / 号池管理」** 直达：

1. 在同一页面点击「**选择 TXT 文件**」或拖入文件（文件内容会直接填入下方的可编辑文本框），也可直接粘贴多行凭证。
2. 点击「**检查账号格式**」，查看脱敏账号预览、格式类型与逐行错误提示；若部分行格式错误，可直接在文本框里编辑修正，或勾选「**跳过格式错误行，仅导入有效账号**」。
3. 可选填本批登录使用的 HTTP(S) 代理，勾选授权确认后点击「**导入并授权入池**」；插件后台处理 DSH 风格 HTTP 密码 + TOTP 登录，不启动 Playwright，也不自动打开浏览器。
4. 可多次批量追加导入（单批最多 100 条，本地加密号池累计支持 1000 个账号），并在「**我的账号池**」查看每个脱敏账号的 Token 状态、单独/全部检测刷新授权或一键「**同步到 Providers**」。成功入池的每个账号都会独立注册为 Magpie Providers 里的可勾选账号（支持设为首选、单独启用/禁用及按账号优先级路由，并在 401/429 时自动故障转移到号池其余有效账号）。

**支持的文本格式**（每行一条，分隔符兼容 `----` 与 `---`）：

| 格式 | 示例 | 处理方式 |
| --- | --- | --- |
| 标准三字段 | `邮箱----密码----2FA密钥` | 后台 HTTP OAuth + TOTP 登录 |
| 带邮箱链接 | `邮箱----密码----2FA密钥----https://mail.xxx.store/...` | 识别第四字段为邮箱链接，只使用前三项登录，不自动访问链接 |
| 带 Token | `邮箱----密码----2FA密钥----eyJhbGci...` | 先通过目标模型接口验证 Token；失效则尝试后台重新登录 |
| 五字段带 RefreshToken | `邮箱----密码----2FA密钥----eyJhbGci...----rt_...` | 兼容 DSH/卡密导出格式；解析 JWT 先行验证，第五字段或链接不会写入日志/预览 |
| 无 2FA | `邮箱----密码` | 普通后台密码授权，平台要求额外验证时可能失败 |

**不要提交真实凭证 TXT 到 GitHub，也不要把账号密码/2FA/JWT 粘贴到公开聊天记录。** GUI 预览仅返回掩码邮箱；凭证在后台内存草稿短时保存，成功账号在本机加密号池内保存。

## 二、Providers 登录入口与多账号同步机制

Magpie 的 **Providers → 来自插件 → GPTFree Codex Pool** 使用 Magpie 内置的 `auth.methods[].prompts` 登录表单，现在提供 3 种导入方式：

1. **从 TXT 文件批量导入账号**：调用系统文件选择器选定 TXT；首个有效账号入池后立即完成登录，其余账号在后台逐个入池并自动注册为 Providers 里的独立账号；若 TXT 存在格式错误（除非选择「自动跳过格式错误行」），文件内容会先安全暂存到内存草稿，提示你打开左侧 **Plugins → GPTFree 账号导入** 在文本框内直接编辑改错。
2. **选择 TXT 并预加载到「GPTFree 账号导入」文本框编辑**：先选中本地 TXT 文件并自动载入 **Plugins → GPTFree 账号导入** 的可编辑文本框，方便改完格式再导入。
3. **同步本机已有 GPTFree 账号池到 Providers（全部账号）**：若你已在内嵌页导入多账号，点击此项可将本机号池中的所有有效账号一次性同步到 Magpie Providers 列表。

多账号能力实现机制：

- Magpie 的 `auth.single` 已取消限制；插件会为本机加密号池里的**每一个有效账号**分配独立槽位（首个沿用 `gptfree-pool`，其余使用 `gptfree-pool#s<hash>`）并设置脱敏展示名（如 `al***@example.com · 1a2b3c4d`）与 `metadata.poolSlot`，避免全部折叠成单一 `API key …l-v1` 条目。
- 选中某个账号时，请求会优先路由到对应账号并在 401/429/5xx 时自动向同号池其余账号故障转移。
- 由于 Magpie 官方 `prompts` 接口不支持直接嵌入任意 HTML 多行文本框，完整的文本框预览与实时导入进度表放在 **Magpie 左侧 Plugins → GPTFree 账号导入**（基于 `magpie.page` 与 `magpie.page.service`），也可通过 Providers 行菜单的 **「GPTFree 批量导入 / 号池管理」** 直达。

## 三、后台认证实现（与 DSH 独立）

`python/auth_worker.py` 参考 [yang0/chatgpt2api-dsh](https://github.com/yang0/chatgpt2api-dsh) 的纯 HTTP 授权逻辑，使用独立 `curl_cffi` Session，执行密码与 TOTP 认证、PKCE、Token 交换；`utils/pkce.py`、`utils/sentinel.py` 依据 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 及其 MIT 许可证引入，见 `python/THIRD_PARTY.md`。

- 登录和失效后的重新登录共用同一独立 HTTP worker，**不调用 Codex CLI、Playwright 或 DSH 后端**。
- 认证 worker 保留用户要求的 DSH 网络 TLS 行为；这会关闭证书校验，需仅在用户信任的网络使用。
- 第一次运行尝试寻找系统 Python 3 并创建插件专属 venv，自动通过 pip 安装 `curl_cffi`；需要安装 Python 3，并允许首次联网获取依赖。Windows/macOS/Linux 的实际 bootstrap 还未在用户机器实测。
- Python 进程通过 stdin 接收账号和 TOTP，stdout JSON 由插件读取，原始密码和 Token 不会写入普通 GUI 事件和 Magpie provider 登录元数据。
- 已有有效 JWT 可优先验证复用；被服务器拒绝或过期时自动进行 HTTP 重新授权；账号池仍使用本地 AES-256-GCM。

### 重要兼容性边界

**DSH 认证拿到的是 OpenAI Platform OAuth Token，Magpie 现有供应商请求的是 ChatGPT Codex 服务。两种凭证不能假设相互通用。** 本插件只有在目标服务实际接受 Token、模型列表验证成功后才将账号计入可用号池；失败时会显示「Platform Token 未通过 Magpie 模型访问验证」，不会把登录成功误算成模型可调用。

这一点必须通过拥有合法使用权限的账号完成真实端到端验证。如果不兼容，后续需要重新实现目标服务的认证/请求适配，而不是跳过服务器验证或伪造成功。

## 四、本地开发与测试

```bash
npm run check
npm test
```

Python worker 在登录时自动创建隔离环境。需要 Python 3 和首次依赖下载。Node.js 20+，Magpie 需支持 `magpie.page.service`。

其他参考：<https://github.com/yang0/magpie-gptfree/issues/14>（DSH HTTP 认证）和 <https://github.com/yang0/magpie-gptfree/issues/15>（内嵌表单）。

已有旧版的 CLI 导入工具仅用于开发/诊断，不是 GUI 的使用前提。
