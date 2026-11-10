# GPT号池（magpie-gptfree）

Magpie 内嵌插件，**左侧菜单「GPT号池」页面**提供完整的多账号号池批量导入与管理能力：支持选择或拖入 TXT 直接填入可编辑文本框、按行预览与修正、跳过错误行、多批次追加、批量检测/刷新、每账号实时生图额度展示、「**额度统计**」全局看板，以及每个账号独立同步到 Magpie Providers 轮询与故障转移。

> 当前版本 v0.6.3：基于独立 Python HTTP worker（DSH 风格密码/TOTP 认证）与独立 ChatGPT Web `picture_v2` 生图/改图 worker 实现。**代码和模拟测试不代表真实 OpenAI 账号已完成端到端验收。** 请勿把 Platform OAuth 获取成功等同于 Magpie Codex 或 ChatGPT Web `picture_v2` 全部接口可用。

## 一、左侧菜单「GPT号池」完整使用流程

安装并启用插件后，在 Magpie **左侧菜单点击「GPT号池」**（或在 **Providers** 页面右键 `GPT号池` 供应商行选择 **「打开 GPT号池」** 直达）：

1. 在页面内点击「**选择 TXT 文件**」或拖入 `.txt` 文件（文件内容会直接填入下方的可编辑文本框），也可直接粘贴多行凭证。
2. 点击「**检查账号格式**」，查看脱敏账号预览、格式类型与逐行错误提示；若部分行格式错误，可直接在文本框里编辑修正，或勾选「**跳过格式错误行，仅导入有效账号**」。
3. 可选填本批登录使用的 HTTP(S) 代理，勾选授权确认后点击「**导入并授权入池**」；插件在后台执行 DSH 风格 HTTP 密码 + TOTP 登录，不启动 Playwright，也不自动打开浏览器。
4. 导入成功的所有有效账号都会**自动分别注册到 Magpie Providers 里的「GPT号池」下**（支持设为首选、单独启用/禁用、按槽位优先路由及 401/429 自动故障转移），无需再到供应商页面手动添加；在「**我的账号池**」标签页中每个账号旁边可直接查看真实生图剩余额度，并在「**额度统计**」标签页查看当前账号、可用账号、限流账号、剩余额度、成功调用与失败调用汇总（统计保存在本机非敏感文件 `pool-stats.json`，以槽位哈希为键，不写入明文邮箱/凭据）。

**支持的文本格式**（每行一条，分隔符兼容 `----` 与 `---`）：

| 格式 | 示例 | 处理方式 |
| --- | --- | --- |
| 标准三字段 | `邮箱----密码----2FA密钥` | 后台 HTTP OAuth + TOTP 登录 |
| 带邮箱链接 | `邮箱----密码----2FA密钥----https://mail.xxx.store/...` | 识别第四字段为邮箱链接，只使用前三项登录，不自动访问链接 |
| 带 Token | `邮箱----密码----2FA密钥----eyJhbGci...` | 先通过目标模型接口验证 Token；失效则尝试后台重新登录 |
| 五字段带 RefreshToken | `邮箱----密码----2FA密钥----eyJhbGci...----rt_...` | 兼容 DSH/卡密导出格式；解析 JWT 先行验证，第五字段或链接不会写入日志/预览 |
| 无 2FA | `邮箱----密码` | 普通后台密码授权，平台要求额外验证时可能失败 |

**不要提交真实凭证 TXT 到 GitHub，也不要把账号密码/2FA/JWT 粘贴到公开聊天记录。** GUI 预览仅返回掩码邮箱；凭证只在内存草稿短时保存，成功账号保存在本机 AES-256-GCM 加密号池中。

## 二、关于供应商页面（Providers）的说明

- 在左栏 **GPT号池** 导入账号时，插件会自动同步写入 Magpie Providers，日常无需去「+ 添加供应商」重复添加。
- 因 Magpie 宿主架构规定，凡在 Gateway 注册为 `gptfree-pool` 的认证插件都会出现在「来自插件」列表；本插件已移除多余的三个蓝色选择按钮，如果在供应商页点击 **GPT号池** 或「+ 重新登录」，会**直接弹出系统 TXT 文件选择框**：全部格式正确即直接后台批量入池；若有格式错误行，则自动把文本预加载到**左侧菜单「GPT号池」可编辑文本框**并提示你编辑修正。
- 插件为本机号池中的**每一个有效账号**分配独立槽位（首个沿用 `gptfree-pool`，其余使用 `gptfree-pool#s<hash>`）并显示脱敏标签（如 `al***@example.com · 1a2b3c4d`）与 `metadata.poolSlot`。

## 三、后台认证与生图实现

`python/auth_worker.py` 参考 [yang0/chatgpt2api-dsh](https://github.com/yang0/chatgpt2api-dsh) 的纯 HTTP 授权逻辑，使用独立 `curl_cffi` Session 执行密码、TOTP、PKCE 与 Token 交换；`utils/pkce.py`、`utils/sentinel.py` 依据 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 的 MIT 许可引入，见 `python/THIRD_PARTY.md`。

- 首次运行自动寻找系统 Python 3 并创建独立 venv 安装 `curl_cffi`，不调用 Codex CLI、Playwright 或 DSH 外部服务。
- 当号池至少有一个可用账号时，`discoverPoolModels` 同时暴露 Codex 对话模型（`@ai-sdk/openai` → `/responses`）与 `gpt-image-2` 绘图/改图模型（`@ai-sdk/openai-compatible` → `/images/generations` 与 `/images/edits`）。

## 四、本地开发与测试

```bash
npm run check
npm test
npm run test:python
```

需要 Node.js 20+ 与 Python 3，Magpie 需支持 `magpie.page.service`。
