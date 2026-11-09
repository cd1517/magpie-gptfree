# Magpie GPTFree · 内嵌账号批量导入

**Magpie 窗口内的账号导入表单**，支持直接粘贴多行账号、选择或拖入 TXT、脱敏预览、进度和号池管理。无需终端操作、不单独打开 GPTFree 导入网页，不依赖 DSH 插件或服务。

> 开发分支 `feat/dsh-http-auth`（计划 v0.4.0）：正在把 DSH 的纯 HTTP 密码/TOTP 登录移植为独立 Python worker。**代码和模拟测试不代表真实 OpenAI 账号已完成端到端验收。** 请勿把 Platform OAuth 获取成功等同于 Magpie Codex 模型可用。

## 一、用户界面

启动 Magpie，打开左侧 **Plugins → GPTFree 账号导入**。

1. 在「**粘贴账号**」标签直接输入多行凭证，或切换到「**导入 TXT 文件**」选择、拖入文件。
2. 点击「**检查账号格式**」，检查脱敏账号预览、格式类型、错误与重复。
3. 点击「**导入并授权入池**」；插件后台处理 DSH 风格 HTTP 密码 + TOTP 登录，不启动 Playwright，也不自动打开浏览器。
4. 在同一页查看成功、失败、复用 Token、逐行状态，可请求停止。点击「**我的账号池**」管理已存账号。

**支持的文本格式**（每行一条，分隔符兼容 `----` 与 `---`）：

| 格式 | 示例 | 处理方式 |
| --- | --- | --- |
| 标准三字段 | `邮箱----密码----2FA密钥` | 后台 HTTP OAuth + TOTP 登录 |
| 带邮箱链接 | `邮箱----密码----2FA密钥----https://mail.xxx.store/...` | 识别第四字段为邮箱链接，只使用前三项登录，不自动访问链接 |
| 带 Token | `邮箱----密码----2FA密钥----eyJhbGci...` | 先通过目标模型接口验证 Token；失效则尝试后台重新登录 |
| 无 2FA | `邮箱----密码` | 普通后台密码授权，平台要求额外验证时可能失败 |

**不要提交真实凭证 TXT 到 GitHub，也不要把账号密码/2FA/JWT 粘贴到公开聊天记录。** GUI 预览仅返回掩码邮箱；凭证在后台内存草稿短时保存，成功账号在本机加密号池内保存。

## 二、Providers 登录入口与内嵌页的区别

Magpie 的 **Providers → GPTFree** 使用 Magpie 内置的 `auth.methods[].prompts` 登录弹窗。该官方接口只支持逐项 `select`、`text`、`password`，目前**不能直接插入任意 HTML 多行输入框、文件上传组件和完整进度表格**。因此那里先显示原生「选择 TXT 导入 / 使用已有号池」表单，TXT 模式确认后才出现系统文件选择框。

完整的截图式批量账号表单在 **Magpie 左侧 Plugins → GPTFree 账号导入**，是真正内嵌于 Magpie 的插件页，使用 `magpie.page` 与 `magpie.page.service`，实现方式参考社区 [magpie-chat](https://github.com/Magiczerowxy/magpie-chat)。不会单开 GPTFree 导入管理网页。

如果必须在 **Providers 卡片点击后弹出的同一个原生弹窗**内直接完成多行粘贴、上传、预览及进度，那需要 Magpie 上游新增自定义插件 modal API，单独修改第三方插件无法实现。

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
