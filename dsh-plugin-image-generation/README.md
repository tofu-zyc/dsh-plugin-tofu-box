# dsh-plugin-image-generation

给 dsh 增加独立的绘图模型配置、`generate_image` 工具和「设置 → 绘图」面板。绘图模型不进入聊天模型列表，不改动现有会话存储或对话 provider。

## 安装与使用

本地开发安装（把 `web` 换成自己的 profile）：

```powershell
dsh plugin --profile web add "link:D:\program\dsh-plugins\dsh-plugin-image-generation"
```

重启 dsh，打开「设置 → 绘图 → 添加模型」：

1. 填写供应商 API 地址（默认 `https://api.openai.com/v1`）与 API Key。地址包含服务商要求的版本前缀，插件会追加 `/images/generations`；也接受粘贴该完整标准路径。特殊生成路径可在高级设置中直接修改「完整生成接口」。
2. 点击「获取模型列表」，搜索并选择模型。获取操作只请求供应商的模型目录，不生成图片，也不保存输入的 Key；模型 ID 仍可手动填写。
3. 点击保存即可。配置 ID 默认由模型名生成并自动避开重复，也可以在高级设置中指定；它是工具调用时选择的名称。首个模型自动成为默认项，之后可手动设置默认模型。
4. 尺寸、质量、凭据引用等集中在「高级设置」。凭据引用默认 `IMAGE_API_KEY`，可改用已有引用。Key 由 dsh 凭据服务单独保存，不写入模型设置、不返回给模型。留空 Key 保留已有值；留空凭据引用表示不发送 Authorization。每个模型拥有自己的接口、凭据和参数，修改在下一次请求生效。
5. 在聊天中说「用 my-art 画一张……」，或在设置页下方输入提示词直接生成。

设置保存使用 revision 检查，遇到并发修改请重新加载后编辑。保存 Key 与模型配置是两次独立操作；若后者失败，已保存的凭据仍然保留。删除模型不会删除共享凭据。

### 从供应商获取模型

默认将生成地址末尾的 `/images/generations` 替换成 `/models`，保留网关的路径前缀，使用 `GET` 与同一套 Bearer 凭据。例如 `https://gateway.example/proxy/v1/images/generations` 对应 `https://gateway.example/proxy/v1/models`。非标准目录地址可在高级设置中填写「模型列表接口」，该地址必须与生成接口同源。

本次输入的 Key 优先于已保存凭据。获取目录支持尚未保存的表单，不需要先填模型 ID 或配置 ID；请求限时 20 秒、响应上限 2 MiB。列表支持按模型 ID、显示名称搜索，重复 ID 合并。目录只保存于当前表单，修改地址或 Key 会清空旧结果。

通用目录不可靠地声明绘图能力，因此展示供应商返回的全部型号，不按名称自动过滤。请选择供应商明确支持 Images API 的模型。供应商不支持 `/models`、返回空列表或所需型号不在列表时可手动填写；返回 `has_more` 时界面提示目前仅展示首批结果，不自动跟随分页地址。[官方模型目录接口](https://developers.openai.com/api/reference/ruby/resources/models)

本插件提交到远程仓库后，也可从对应版本安装：

```sh
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-image-generation
```

## 协议与参数

首版仅支持 `openai-images`：JSON `POST` 到完整生成接口，解析 `data[].b64_json` 或 `data[].url`。默认每次 1 张，可请求 1–4 张；具体模型可能只支持 1 张。参数留空时完全不发送，避免将某个模型特有参数强加给其他模型。

模型设置可指定 `size`、`quality`、`background`、`output_format`、`response_format`、`style`。工具调用可覆盖 `size`、`quality` 和数量。GPT Image 的 `response_format` 应留空；该系列返回 Base64。其他兼容模型是否接受这些参数取决于服务商，插件不会根据模型名猜测能力。[官方 Images API 参数说明](https://developers.openai.com/api/reference/cli/resources/images/methods/generate)

URL 图片会在宿主立即下载并持久化。结果地址可以是网关返回的任意主机（例如放在第三方 CDN 上），不需要预先声明。下载只接受公开的 HTTP(S) 地址（拒绝 `file:` 等协议和内嵌凭据的地址），不携带生成接口的 Authorization，且不跟随重定向；支持 Base64 的网关建议直接返回 Base64，可以少一次下载。

生成超时默认 300 秒，可调至 10–600 秒。取消和超时会停止本地等待，但服务端可能仍完成并计费。插件不自动重试。接口 JSON 响应限制 112 MiB，单张原图限制 20 MiB；dsh 自身还有像素、图片数量与附件限制。

## 对话、预览与原图

- `list_image_models`：列出配置 ID、模型 ID、协议与默认参数，不返回地址或凭据。
- `generate_image`：发送独立提示词，不发送完整聊天历史。当前聊天模型声明支持图片输入时，工具结果包含图片附件，本插件提供多图预览卡片。
- 纯文本模型或无法确认输入能力时，工具只返回原图路径，不把图片放进模型上下文。此模式没有对话内缩略图，可打开返回的宿主文件；需要预览和浏览器下载时使用直接绘图面板。
- 面板生成不调用聊天模型、不插入当前会话。面板通过短请求启动任务并轮询状态，支持取消，避免长请求被 RPC 超时打断。
- 预览使用 dsh 规范化后的附件；原图另存为逐字节保留的文件附件。面板「下载原图」下载原始字节。宿主存储路径由 dsh 附件后端决定，本插件不覆盖工作区文件。远程宿主路径不是浏览器本机路径。
- 面板任务记录只保存在宿主内存中：最多 32 个，启动新任务时清理超过一小时的已完成记录，宿主重启后记录消失。同一浏览器标签页记住最后一个任务 ID，刷新可以继续查看尚未过期的任务。原图附件仍在宿主存储中，请及时下载。

未来切换到不支持图片的聊天模型时，已有图片历史仍受 dsh 自身的上下文兼容规则约束。首版不提供图像编辑、参考图、流式绘图、Responses 内置绘图工具、Gemini 原生协议或聊天模型的逐模型协议改写。

## 配置结构

设置页写入 profile 条目 id `image-generation` 的 volatile Config 字段（`models` 和 `defaultModel`）；宿主直接读取稳定引用，改动对下一次生成生效。也可以在插件的 Cordis `config` 中提供基础配置：

```yaml
models:
  - id: my-art
    name: 我的绘图模型
    model: your-model-id
    api: openai-images
    endpoint: https://api.openai.com/v1/images/generations
    # modelsEndpoint: https://api.openai.com/v1/models  # 可选，默认推导
    apiKeyEnv: IMAGE_API_KEY
    timeoutSeconds: 300
defaultModel: my-art
```

这些字段属于本插件，不是 `llm-pi-ai.providers`。原有聊天模型继续使用 dsh 的 provider 设置。

## 验证与兼容性

本分支要求 dsh ≥ 0.1.7-alpha.2，使用该版本的 tools、profile-backed SettingsForms、attachments 和 typert Remote 接口。开发验证包含：

```sh
node --test dsh-plugin-image-generation/tests/plugin.test.mjs
node dsh-plugin-image-generation/tests/attachments.mjs
node dsh-plugin-image-generation/tests/browser.mjs
```

- 自动测试覆盖本地 HTTP 请求、参数和路由、凭据缺失、结果地址校验、重定向、取消、错误响应、设置热更新、工具图片投影、Remote 任务和卸载清理，以及目录地址推导、未保存 Key、模型去重、空列表、分页提示与错误处理。
- `attachments.mjs` 使用已安装的 dsh 附件后端，所有产物写入新建临时目录；可通过 `DSH_ATTACHMENT_MODULE` 指定后端模块入口。
- `browser.mjs` 使用 React 和模拟 Remote 服务检查设置、Key 分离保存、生成、下载、窄屏布局与任务恢复。依赖安装到测试目录，用 `IMAGE_QA_MODULES` 指定包含 playwright、react、react-dom、esbuild 的目录；默认使用系统临时目录下的 `dsh-image-generation-qa`，浏览器使用 Edge 无头模式。
- `live.mjs` 只用于一次性隔离 profile：设置 `DSH_IMAGE_TEST_URL` 为该实例的认证 URL，并设置 `DSH_IMAGE_TEST_ISOLATED=1`。测试会在该 profile 保存模拟模型与模拟凭据，通过真实 settings、credentials、Remote 网关、附件存储完成本地 HTTP 绘图与下载。不要指向日常使用的 profile。
- Windows 本地 HTTP 与浏览器夹具测试、隔离 dsh 0.1.7-alpha.2 profile 的完整绘图流程验证通过；生产数据副本中的旧绘图模型设置也经官方自动导入并在浏览器确认两项均存在。尚未调用真实付费绘图服务；其他平台与不同网关需要实际验证。

卸载：`dsh plugin --profile web remove dsh-plugin-image-generation`，然后重启 dsh。已有附件与共享凭据不会被删除。
