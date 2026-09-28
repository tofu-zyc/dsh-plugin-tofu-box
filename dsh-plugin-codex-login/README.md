# dsh-plugin-codex-login

在 DSH Desktop 或 Web 的「设置 → 模型」中给 `openai-codex` 提供商增加 ChatGPT OAuth 登录、进度、验证码输入、取消和本地退出。插件调用宿主已经注册的 `llm-pi-ai` 授权流程；OAuth 端点、令牌存储与刷新由 DSH 和模型适配器负责。它不是 OpenAI API Key 登录，也不会复制令牌到浏览器。

## 前提与安装

需要提供 `authorization`、`credentials`、`llm-pi-ai` 的 DSH Desktop 或 Web profile，以及支持 `settings.models.provider-card` 的模型设置页。插件 Host 使用 Typert Remote，界面通过已有的鉴权 `/api` 连接调用；不开放额外 HTTP 路由。与发行版使用兼容的 DSH 版本（参见 `package.json` 中的 peer dependencies）。

在 DSH 可执行文件所在的环境中，选择实际使用的 profile 安装本目录：

```powershell
dsh plugin --profile desktop add "link:D:\program\dsh-plugins\dsh-plugin-codex-login"
# 如果使用的是 Web profile，改用：
dsh plugin --profile web add "link:D:\program\dsh-plugins\dsh-plugin-codex-login"
```

bundle 的 `cordis.patch.yml` 插入 `codex-login` 行；安装、卸载或更新本目录代码后，完全退出并重新打开 Desktop（Web 则重启对应 profile 并刷新网页）。本目录不会自动修改正在运行的 profile 或读取任何现存的登录凭据。

在「设置 → 模型」中添加并保存 `openai-codex`：**API 密钥留空，不配置 `apiKeyEnv`**。保存后该提供商卡片才显示登录按钮。点击「使用 ChatGPT 登录」，按页面上的 HTTPS 链接在浏览器完成认证；需要手动输入验证码时，在插件表单里提交。登录成功后由原来的 `llm-pi-ai` 适配器持有并自动刷新授权凭据；不需要第二份凭据设置。若提供商设置中写了 API 密钥引用，可能覆盖这一 OAuth 路径，应先清除引用。

## 安全与生命周期

- 宿主只向发起登录的卡片返回一次性的随机 ticket 和长度受限的 OAuth 通知/问题（通知可含一次性设备码）。访问、刷新令牌和已输入的答案不出现在状态响应中。答案仅通过已有的鉴权 Remote 通道回传宿主；不要在浏览器控制台记录验证码。
- 如果浏览器提示授权成功而卡片仍显示“未登录”，表示 DSH 尚未确认保存一条新凭据。失败状态只向持有 ticket 的卡片返回安全类别：`record-not-committed`（本次未提交凭据）、`credential-store`、`network`、`oauth-rejected`、`http-4xx/5xx` 或 `unknown`；宿主日志也只包含这些类别，不包含异常原文、授权链接、验证码或令牌。`unknown` 不能据此判断根因；若需排查，请只提供卡片上的类别，不要发送授权链接或验证码。
- 同一 Codex 凭据同时只运行一次登录；只有持有 ticket 的客户端能查看这次登录的通知或回答问题。关闭卡片会取消它发起的登录；页面断线后最迟 `timeoutSeconds` 秒取消（默认 600 秒，可配置 60–3600 秒）。宿主卸载会中止并等待登录结束。
- “退出登录”仅调用 DSH 凭据服务删除本机 `llm-pi-ai/openai-codex` 记录；**不会在 OpenAI 端撤销已颁发的授权**。如需吊销，在 OpenAI/ChatGPT 的帐号安全页面管理授权。已完成授权但尚在提交中的取消操作可能仍留下一份凭据，卡片状态以宿主 `describeRecord` 为准。
- 本地 Web 界面的帐号安全性继承 DSH 的 Connection/Gateway 鉴权；不要把 DSH Web 暴露为未受保护的公共站点。

## 验证

在本目录运行 `node --test tests/*.test.mjs`。测试以替身授权流覆盖 ticket 隔离、通知 URL 协议、问题回答、取消、卸载、本地退出和敏感信息不返回。实际 OAuth 回调需使用自己的 ChatGPT 帐号手动验证；测试不触发真实登录。
