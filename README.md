# Magpie GPTFree · GUI 账号批量导入插件

**无需命令行导入账号。** 在 [Magpie](https://github.com/yetone/magpie) 的 **Plugins → GPTFree 账号导入** 页面直接选择 TXT 文件、预览脱敏账号、选择导入模式、开始任务、观察逐行进度，并管理本地号池。

本仓库完全独立，不依赖 DSH，也不调用任何 DSH API。只用于用户自己拥有或获准管理的账号。

## GUI 安装与使用

1. 打开 Magpie 桌面版的 **Plugins（插件）** 页面，点击 **Add a plugin（添加插件）**，输入 `https://github.com/yang0/magpie-gptfree`，或选择已下载的本仓库文件夹。启用插件。
2. **两种入口都支持 GUI，不需要另外登录：**
   - 在 **Providers → 添加供应商 → 来自插件 → GPTFree Codex Pool** 中点击 GPTFree。插件提供唯一的「打开 GPTFree 图形界面导入账号」方式，Magpie 会在浏览器打开本机 GUI。完成第一个账号导入后，这个供应商登录流程自动完成。
   - 或者在 Magpie 左侧 **Plugins → GPTFree 账号导入** 直接打开内嵌 GUI。这种方式无需经过 Providers 登录页，导入成功后自动连接号池。
3. **点击「选择文件」或拖入 TXT 文件**。页面自动解析最多 100 条账号，展示掩码邮箱、三/四字段类型、JWT 过期状态、重复项和格式错误。明文密码、TOTP 和 Token 均不显示。
4. 选择 **独立 Token 号池**（默认）或 **原生 Codex 导入**，勾选账号归属确认，点击 **开始批量导入**。
5. 查看每条账号的状态、成功数、复用数、失败原因。支持 **停止导入**。使用「我的账号池」查看和移除独立池的账号。
6. **无需另外填写账号密码、API Key 或点击第二次「登录/启用」**：选择 Token 号池模式时，任意账号成功授权入池，插件就会自动把 `gptfree-pool` 连接到 Magpie；成功后直接在 Agent 里选择实际验证可用的模型。原生 Codex 模式则会自动导入 Magpie 原生账号列表。

> GUI 页面由 Magpie 插件服务运行在本机 `127.0.0.1:37986`，不要求另开终端导入。从 Providers 进入时 GUI 会在本机浏览器打开；从 Plugins 左侧进入时是 Magpie 内嵌 GUI。首次使用需要插件主机能启动服务，并且设备已装 Chrome / Edge 供正常的交互式 OAuth 登录。尚未在真实 Windows Magpie + 真实账号上完成端到端验证，请先用少量自有测试账号。

## 支持的账号格式

每行一条；分隔符支持 `----` 或 `---`，也允许混合。

| 输入格式 | GUI 行为 |
| --- | --- |
| `邮箱----密码----2FA密钥` | 标准 OAuth + TOTP 登录 |
| `邮箱----密码----2FA密钥----https://mail.xxx.store/...` | 识别邮箱链接，按前三字段登录；**不会自动访问**第三方邮箱链接 |
| `邮箱----密码----2FA密钥----eyJhbGci...` | 识别 JWT；号池模式优先向 Codex 的 `/models` 验证，验证通过才直接复用，否则走 OAuth + TOTP |
| `邮箱----密码` | 可用于无 TOTP 的账号，额外验证仍需人工完成 |

示例（仅供了解字段，不是真实凭证）：

```text
first@example.com----PASSWORD----GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
second@example.com---PASSWORD---GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ---https://mail.xxx.store/example
third@example.com----PASSWORD----GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ----eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjQ3MzM4NTYwMDB9.EXAMPLE_SIGNATURE
```

不要提交包含真实凭证的 TXT 到 GitHub。插件不会绕过验证码、异常登录挑战、短信或邮件二次确认；用户需要在打开的官方登录窗口完成。

## 两种导入模式

**独立 Token 号池（默认）**：已有 access_token 会被 Codex 上游实际验证；成功才算可复用，验证失败或过期则进入正常交互式 OAuth 登录。成功入池后自动注册 Magpie Provider，重启插件时有本地记录则自动恢复关联；移除最后一个号池账号会自动取消注册。账号池保存在当前运行 Magpie 机器用户的 `~/.magpie-gptfree/` 下，使用 AES-256-GCM 加密。密钥存放在同用户权限限定的 `master.key` 文件，**不是系统密钥链或硬件安全模块**。上游 Token 失效后会尝试重新 OAuth，可能仍需人工验证。

**Magpie 原生 Codex 导入**：每个账号必须通过 OAuth 得到 `access_token`、`id_token` 和 `refresh_token`，再经 Magpie 自带的导入接口入池。单独 access_token 不能被伪装成可续期的原生账号，故不会跳过 OAuth。

免费 ChatGPT 账号是否拥有 Codex 模型/额度，以官方服务验证为准；软件不保证免费、无限调用。

## GUI 设计与技术说明

- Magpie 的普通插件页面具有 `connect-src 'none'` 限制，因此初始插件页通过 `magpie.page.service` 导航到插件拥有的本地服务界面。它仍在 Magpie 插件的隔离框架内，不提供外网公开 API。
- 上传的 TXT 只放在后台内存中的临时草稿里；页面只拿到脱敏预览，15 分钟未开始则过期。导入过程中不会把密码/TOTP/Token 写入 Magpie 插件选项、普通 HTML 或日志。
- GUI API 仅监听 loopback、要求每个页面独立的随机能力令牌和受控请求来源，有限制文件大小。工作流可以取消、按账号查看状态，独立号池只输出掩码账号。
- **远程 magpie web 注意**：如果在另一台设备浏览 Magpie 网页端，TXT 会通过该网页连接发送到运行 Magpie 的主机。请仅在可信设备及受 TLS 保护的连接下使用。优先在本机桌面版执行账号导入。
- 服务默认端口 `37986`；如与其他本地程序冲突，可在插件设置中使用 `port` 自定义，页面和服务会读取该设置。禁止暴露服务到 LAN。

## 开发与自动测试

```bash
npm install
npm run check
npm test
```

测试覆盖 GUI 注册、文件上传/三格式识别、脱敏预览、随机会话校验、来源限制、开始/进度/取消任务、账号池查看/移除、原有 OAuth/TOTP/Token 与加密存储。测试均使用模拟凭证，**不接触真实 ChatGPT 账号**。

高级 CLI 仍保留在 `bin/import.mjs`，但不再是常规导入入口。

**登录是导入流程的一部分**：只有在官方提示额外安全验证时需要操作登录窗口。Providers 的 GPTFree 入口提供的是「打开 GUI 导入账号」方法，不再显示「插件没有提供登录方式」，不需要第二次启动账号池登录。

开发记录：[GUI Issue #3](https://github.com/yang0/magpie-gptfree/issues/3) · [原账号池 Issue #1](https://github.com/yang0/magpie-gptfree/issues/1)。

**待验证**：Windows Magpie 桌面实际嵌入页面 / 浏览器 OAuth / 模型请求全流程。不要把自动测试通过等同于真实账户验收。
