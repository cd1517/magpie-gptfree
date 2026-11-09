# Magpie GPTFree · GUI 账号批量导入插件

**无需命令行导入账号。** 在 [Magpie](https://github.com/yetone/magpie) 的 **Plugins → GPTFree 账号导入** 页面直接选择 TXT 文件、预览脱敏账号、选择导入模式、开始任务、观察逐行进度，并管理本地号池。

本仓库完全独立，不依赖 DSH，也不调用任何 DSH API。只用于用户自己拥有或获准管理的账号。

## GUI 安装与使用

1. 打开 Magpie 桌面版的 **Plugins（插件）** 页面，点击 **Add a plugin（添加插件）**，输入 `https://github.com/yang0/magpie-gptfree`，或选择已下载的本仓库文件夹。启用插件。
2. **推荐：Magpie 左侧 Plugins → GPTFree 账号导入**。这是在 Magpie 主窗口内的完整插件页面（和社区 magpie-chat 的接入方式一致），可直接拖入 TXT、点击文件选择、预览脱敏账号、开始导入并查看逐行进度，**不会打开额外的 GPTFree 导入网页**。
   - 也支持 **Providers → 添加供应商 → 来自插件 → GPTFree Codex Pool**：点击名称首先出现 **Magpie 自己的登录表单**，先选择「从 TXT 文件批量导入」或「使用本机已有账号池」。选择 TXT 时会再询问账号授权确认；**完成表单后**才弹出系统 TXT 文件选择框，选定即开始批量自动登录。取消表单不会自动弹文件框，也不会假装登录成功。
   - Providers 入口直接导入到独立 Token 号池；如果需要选择「原生 Codex」模式，请使用左侧完整 GUI。
3. 在左侧 GUI **点击「选择文件」或拖入 TXT 文件**。页面自动解析最多 100 条账号，展示掩码邮箱、三/四字段类型、JWT 过期状态、重复项和格式错误。明文密码、TOTP 和 Token 均不显示。
4. 选择 **独立 Token 号池**（默认）或 **原生 Codex 导入**，勾选账号归属确认，点击 **开始批量导入**。
5. 查看每条账号的状态、成功数、复用数、失败原因。支持 **停止导入**。使用「我的账号池」查看和移除独立池的账号。
6. **无需另外填写账号密码、API Key 或点击第二次「登录/启用」**：选择 Token 号池模式时，任意账号成功授权入池，插件就会自动把 `gptfree-pool` 连接到 Magpie；成功后直接在 Agent 里选择实际验证可用的模型。原生 Codex 模式则会自动导入 Magpie 原生账号列表。

> 导入 GUI 内嵌于 Magpie；插件服务只监听本机 `127.0.0.1:37986`，供框架内部页面使用，不会额外打开 GPTFree 网站。Providers 入口**先出现 Magpie 原生选择/确认表单**，用户提交后再使用 Windows/macOS/Linux 系统文件选择器。**账号 OAuth 过程中如果需要官方安全验证，仍可能打开官方登录页面**，这与额外打开“导入管理网页”不同。真实 Windows Magpie + 账号端到端仍待验证。

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

**登录是导入流程的一部分**：只有在官方提示额外安全验证时需要操作登录窗口。Providers 的 GPTFree 入口通过无网页 OAuth 流程先展示 Magpie 的原生选择/确认表单，提交后才打开系统文件选择器并自动入池；左侧 Plugins 入口始终在 Magpie 内展示完整 GUI。

开发记录：[GUI Issue #3](https://github.com/yang0/magpie-gptfree/issues/3) · [原账号池 Issue #1](https://github.com/yang0/magpie-gptfree/issues/1)。

**待验证**：Windows Magpie 桌面实际嵌入页面 / 浏览器 OAuth / 模型请求全流程。不要把自动测试通过等同于真实账户验收。

## 参考实现与 Magpie 接口限制

- 社区参考：[Magiczerowxy/magpie-chat](https://github.com/Magiczerowxy/magpie-chat)，使用 `magpie.page`、`magpie.page.service`、仅在 Magpie 的 sandboxed iframe 中导航自身。
- Magpie 的 Providers 登录 hook **不能直接导航主窗口侧边栏标签**。因此本插件通过官方 `auth.methods[].prompts` 的 **Magpie 原生表单**先询问导入来源和账号归属确认，再通过**无 URL OAuth 等待流程**打开本机 TXT 文件选择框，不返回任何外部导入网页链接。与普通 API/keyless 登录不同，这个流程有较长的等待时间，首个账号成功后自动结束供应商登录；批量进度由左侧 Magpie 内嵌页显示。
- 两个入口共用本地导入服务及账号池。Providers 首个成功账号即可完成登录，余下账号继续导入；Magpie 左侧页面显示任务进度。
- 本实现遵守本机授权界面要求，但 Windows/macOS/Linux 系统对话框、Magpie 宿主与真实账号 OAuth 尚需实测。

开发记录：[Issue #9](https://github.com/yang0/magpie-gptfree/issues/9)。

## Provider 表单能力与当前边界

Magpie 官方插件登录弹窗目前支持 `select`、`text`、`password` 类型的**逐步表单问题**，尚不支持第三方插件直接往 Providers 弹窗嵌入自定义 HTML、文件上传控件或进度表格。因此这版点击 GPTFree 名称会**先看到 Magpie 的原生表单**，不会再立即跳出文件选择器；提交确认之后再由系统选择文件。复杂的 TXT 表格预览、批量状态和账号池管理继续在 **Magpie 左侧 Plugins → GPTFree 账号导入** 的内嵌页面。若需要在 Providers **同一个弹窗**中完成文件拖入、预览、进度，需要 Magpie 上游新增插件自定义表单 API。

跟踪：[Issue #11](https://github.com/yang0/magpie-gptfree/issues/11)。
