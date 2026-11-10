# GPT号池（magpie-gptfree）

> **3 分钟拥有一个自己的 GPT 号池：批量导入、自动轮询、生图额度一目了然。**
>
> 不装 Python 环境、不跑浏览器自动化、不用改配置。填个仓库地址，把账号文本粘进去，剩下的插件自己干。

[![Magpie](https://img.shields.io/badge/Magpie-Plugin-3177d9)](https://github.com/yetone/magpie)
[![license](https://img.shields.io/badge/license-MIT-16845c)](./package.json)
[![version](https://img.shields.io/badge/version-0.6.3-a36207)](./package.json)

---

## 这玩意儿能干什么

一个 Magpie 插件，把**一堆便宜的 GPT 普号**变成**一个会自动轮询、自动换号、自动重登的号池**：

- **批量导入**：一行一个账号，粘进文本框就行；格式不对可以直接改，不用重新上传文件。
- **多账号真轮询**：每个账号独立注册进 Magpie Providers，可单独启用/设为首选；某个号 401 / 429 挂了，自动切下一个。
- **生图真能用**：不只对话，`gpt-image-2` 文生图 / 改图一起走，白嫖普号的图片额度。
- **额度看得见**：「我的账号池」每个号旁边直接显示**真实剩余生图额度**；「额度统计」页给你 当前账号 / 可用 / 限流 / 剩余额度 / 成功 / 失败 六个数字。
- **数据不出本机**：凭证只落在本机 AES-256-GCM 加密号池；预览和界面只显示脱敏邮箱。

> [!IMPORTANT]
> 额度数字全部来自 ChatGPT 官方接口（`limits_progress` → `image_gen`）实时读取。**未检测就显示"待检测"，查不到就显示"查询失败"，绝不编造。** 号池统计文件只用槽位哈希做键，不写明文邮箱、密码、2FA 和 Token。

---

## 三毛钱起号池：先备料

号池的原料是普号。**买 GPT 普号可以上 [priceai.cc](https://priceai.cc/)**：

> **三毛钱能买 10 个普号。**

普号同样带图片模型额度，做号池完全够用。买完直接复制提取文本，粘贴进插件就是号池，一分钱都不浪费。

---

## 三步装好，有手就行

### 第 1 步：在 Magpie 里安装插件

打开 Magpie，点顶部 **「插件」** → 切到 **「发现」** → 在最底部的输入框里填仓库地址：

```
github:yang0/magpie-gptfree
```

点右边的 **「安装」**，稍等几秒搞定。

![在 Magpie 插件页填入 GitHub 仓库地址一键安装](docs/images/install-plugin.jpg)

### 第 2 步：导入账号

安装后，点顶部 **「GPT号池」** 进入自己的号池页面 → **「批量导入」** 标签页：

1. 点 **「选择 TXT 文件」**（或直接把文件拖进虚线框），文件内容会**自动填进下面的文本框**；
2. 如果某几行格式不对，**就在文本框里直接改**——不用重新上传，改完点「检查账号格式」看预览；
3. 勾选「跳过格式错误行，仅导入有效账号」（可选），填好代理（需要的话），点 **「导入并授权入池」**。

![在 GPT号池页面选择 TXT 或直接粘贴账号后导入](docs/images/import-accounts.jpg)

后台会按行做 HTTP 密码 + TOTP 登录，**不启动浏览器、不弹网页**。成功的账号会**自动分别同步到 Magpie Providers**，不用再去供应商页面手动添加。

### 第 3 步：看额度、开用

- 进 **「我的账号池」**：每个账号旁边直接显示 `生图额度：N`、限流状态、剩余恢复时间。
- 进 **「额度统计」**：六个大数字一眼看全局，还能单账号点「检测额度」。
- 回 Magpie 正常选模型聊天 / 画图即可，轮询和故障转移插件全接管。

---

## 支持的账号文本格式

每行一条，分隔符 `----` 与 `---` 都认：

| 格式 | 示例 | 处理方式 |
| --- | --- | --- |
| 标准三字段 | `邮箱----密码----2FA密钥` | 后台 HTTP OAuth + TOTP 登录 |
| 带邮箱链接 | `邮箱----密码----2FA密钥----https://mail.xxx.store/...` | 第四字段识别为邮箱链接，只使用前三项登录，不自动访问链接 |
| 带 Token | `邮箱----密码----2FA密钥----eyJhbGci...` | 先通过目标模型接口验证 Token；失效则尝试后台重新登录 |
| 五字段带 RefreshToken | `邮箱----密码----2FA密钥----eyJhbGci...----rt_...` | 兼容 DSH/卡密导出格式；JWT 先行验证，第五字段或链接不会写入日志/预览 |
| 无 2FA | `邮箱----密码` | 普通后台密码授权，平台要求额外验证时可能失败 |

> [!WARNING]
> **不要提交真实凭证 TXT 到 GitHub，也不要把账号密码 / 2FA / JWT 粘贴到公开聊天记录。** 本仓库 `.gitignore` 已忽略 `accounts*.txt`、`pool.enc.json`、`master.key` 等敏感文件。

---

## 「额度统计」页是什么

一张看板，把号池的健康度摊开给你看：

| 卡片 | 含义 |
| --- | --- |
| **当前账号** | 号池里已入池的账号总数 |
| **可用账号** | Token 有效且上游还有剩余生图额度（绿色高亮） |
| **限流账号** | 剩余额度为 0 或已触发限流 |
| **剩余额度** | 所有可用账号的生图剩余额度之和 |
| **成功调用** | 本机累计生图成功次数 |
| **失败调用** | 本机累计生图失败次数 |

外加一张明细表：`账号 / 类型 / 状态 / 剩余生图额度 / 成功·失败 / 最近检测 / 检测额度`。

> [!TIP]
> 如果导入成功但额度一直显示"查询失败"，通常是**登录走 `auth.openai.com`、而额度查询走 `chatgpt.com`** 的网络差异。在页面顶部填好能访问 `chatgpt.com` 的 HTTP(S) 代理，再点「刷新全部额度」即可。

---

## 常见问题

**Q：装完点「GPT号池」没反应？**
重启一次 Magpie 让它加载新插件，然后从顶部「插件」或左侧菜单进入。

**Q：需要自己装 Python 吗？**
不需要。插件首次运行会自动寻找系统 Python 3 并创建独立 venv 安装依赖；找不到会明确报错，不会偷偷失败。

**Q：会动到我 Magpie 里原来的 Codex 账号吗？**
不会。这是完全独立的临时号池，不改动 Magpie 原生账号。

**Q：为什么没有图片模型？**
号池里至少要有 1 个可用账号，`gpt-image-2` 才会出现在模型列表里。

**Q：账号会泄露吗？**
界面与接口只返回脱敏邮箱（如 `al***@example.com · 1a2b3c4d`）和槽位哈希；密码、2FA、JWT 只存在本机加密号池，不写入插件配置、不进 HTML、不进日志。

---

## 关于供应商页面（Providers）

- 在左栏 **GPT号池** 导入账号时，插件会自动同步写入 Magpie Providers，日常**不需要去「+ 添加供应商」**重复添加。
- 因 Magpie 宿主架构规定，凡在 Gateway 注册为 `gptfree-pool` 的认证插件都会出现在「来自插件」列表；本插件已移除多余的三个蓝色选择按钮，如果在供应商页点击 **GPT号池** 或「+ 重新登录」，会**直接弹出系统 TXT 文件选择框**：全部格式正确即直接后台批量入池；若有格式错误行，则自动把文本预加载到**左侧菜单「GPT号池」可编辑文本框**并提示你编辑修正。
- 插件为本机号池中的**每一个有效账号**分配独立槽位（首个沿用 `gptfree-pool`，其余使用 `gptfree-pool#s<hash>`）并显示脱敏标签（如 `al***@example.com · 1a2b3c4d`）与 `metadata.poolSlot`。

---

## 技术实现（想改代码的看这里）

### 认证

`python/auth_worker.py` 参考 [yang0/chatgpt2api-dsh](https://github.com/yang0/chatgpt2api-dsh) 的纯 HTTP 授权逻辑，使用独立 `curl_cffi` Session 执行密码、TOTP、PKCE 与 Token 交换；`utils/pkce.py`、`utils/sentinel.py` 依据 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 的 MIT 许可引入，见 `python/THIRD_PARTY.md`。

- 首次运行自动寻找系统 Python 3 并创建独立 venv 安装 `curl_cffi`，不调用 Codex CLI、Playwright 或 DSH 外部服务。
- 当号池至少有一个可用账号时，`discoverPoolModels` 同时暴露 Codex 对话模型（`@ai-sdk/openai` → `/responses`）与 `gpt-image-2` 绘图/改图模型（`@ai-sdk/openai-compatible` → `/images/generations` 与 `/images/edits`）。

### 生图额度

- `python/image_worker.py` 新增 `check_image_quota` action：`POST /backend-api/conversation/init` 解析 `limits_progress` 中 `feature_name == "image_gen"` 的 `remaining` 与 `reset_after`；best-effort 读取 `/backend-api/accounts/check/v4-2023-04-27` 的 `plan_type`。
- `lib/codex-pool.mjs` 的 `probeAccountImageQuota` 负责 401 自动重登后重试一次；`poolFetch` 在生图前把**已限流槽位置底**，生图成功后扣减额度、失败/429 记账。
- `lib/pool-stats.mjs` 以 `accountSlotTag()` 哈希为键原子写入 `~/.magpie-gptfree/pool-stats.json`（`0o600`），并对错误文本做 URL/JWT/邮箱脱敏。
- 统计接口：`GET /api/stats`，以及 `GET /api/accounts` / `POST /api/accounts/refresh`（支持 `quotaOnly: true`）。

### 本地开发与测试

```bash
npm run check
npm test
npm run test:python
```

需要 Node.js 20+ 与 Python 3，Magpie 需支持 `magpie.page.service`。

---

## 目录结构

```
index.mjs              Magpie 插件入口（GUI 页面 + Providers 认证）
lib/gui-service.mjs    左侧菜单页面后端（会话能力校验、导入、号池、额度统计）
lib/codex-pool.mjs     Codex /responses 与 /images 路由、账号轮询、额度探测
lib/chatgpt-web-image.mjs  图片请求解析、Worker 调用、生图执行与统计回调
lib/pool-stats.mjs     本机非敏感额度与调用统计存储
lib/importer.mjs       批量导入（DSH 风格 HTTP 登录）
lib/pool-vault.mjs     本机 AES-256-GCM 加密号池
python/auth_worker.py  HTTP 密码 + TOTP 授权 worker
python/image_worker.py ChatGPT Web picture_v2 生图 / 改图 / 额度查询 worker
gui/                   左侧菜单页面（无框架、无 localStorage、无 innerHTML）
```

---

## 免责声明

本项目为个人自用工具，与 OpenAI 无任何关联。插件只保存**你本人有权使用**的账号凭证，请遵守账号服务条款；因使用不当、批量采购账号或违反上游条款导致的封号、限流等后果由使用者自行承担。

**代码和模拟测试不代表真实 OpenAI 账号已完成端到端验收。** 请勿把 Platform OAuth 获取成功等同于 Magpie Codex 或 ChatGPT Web `picture_v2` 全部接口可用。

MIT License.
