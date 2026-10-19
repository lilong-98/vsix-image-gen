# VSIX Image Gen Skill

`VSIX Image Gen` 是一个给 `Codex`、`Claude Code`、`Hermes` 等 AI coding agent 使用的 skill，用来通过 `VSIX` 的 `gpt-image-2` / `gpt-image-2.5-sunburst` 接口完成：

- 文生图
- 图生图
- 本地参考图转 `data URI` 后上传
- 首次 API Key 配置引导

仓库地址：

- [https://github.com/lilong-98/vsix-image-gen](https://github.com/lilong-98/vsix-image-gen)

## 安装

### Codex

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/lilong-98/vsix-image-gen ~/.codex/skills/vsix-image-gen
```

### Claude Code / 兼容 Skills 目录的 Agent

如果你的 agent 使用自己的 skills 目录，把这个仓库 clone 到对应目录即可，例如：

```bash
git clone https://github.com/lilong-98/vsix-image-gen ~/.claude/skills/vsix-image-gen
```

## 配置 API Key

先去 [https://vsix.cc](https://vsix.cc) 创建 API Key。

推荐方式一：环境变量

```bash
export VSIX_API_KEY="YOUR_VSIX_KEY"
```

方式二：写入配置文件

macOS / Linux:

```bash
mkdir -p ~/.vsix
printf '%s\n' '{"api_key":"YOUR_VSIX_KEY"}' > ~/.vsix/config.json
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.vsix" | Out-Null
Set-Content -Path "$env:USERPROFILE\.vsix\config.json" -Value '{"api_key":"YOUR_VSIX_KEY"}'
```

## 触发方式

当用户说这些话时，agent 应该触发这个 skill：

- 生图
- 画图
- 生成图片
- 帮我画
- gpt-image
- Image2 生图
- 参考这张图
- 把这张图改成
- generate an image
- edit this photo
- transform this picture

## 模型选择

- `gpt-image-2`：默认模型，原有命令保持兼容。
- `gpt-image-2.5-sunburst`：显式通过 `--model` 选择。

```bash
node scripts/generate.js \
  --model "gpt-image-2.5-sunburst" \
  --prompt "A yellow ceramic teapot on a pale blue table" \
  --size "1024x1024" \
  --out "./sunburst.png"
```

本次只接入已通过 VSIX 文生图实测的 Sunburst；Flare 上游测试尚未通过，暂不提供。图片编辑的请求构造与参考图保留已通过离线验证，Sunburst 的真实图片编辑仍需后续验证。上游服务仍可能返回 502/503；脚本会报告错误，不会自动切换模型。

## 命令行直接使用

CLI 会按任务类型自动选择接口：

- 无参考图：`POST /v1/images/generations`
- 有本地图片或 data URI 参考图：优先 `POST /v1/images/edits`，使用 `multipart/form-data` 上传文件
- 含远程 URL 参考图（包括混合本地与远程图片）：使用 JSON `images[].image_url`
- 如果 multipart 图生图遇到可重试网关/网络错误，自动回退到 JSON 图片引用
- 如果 `edits` 上游返回可重试错误，自动回退到 `generations` 的兼容图片输入
- 如果参考图接口全部失败，返回错误，保留参考图要求；不切换模型或退为纯文生图。

```bash
node scripts/generate.js \
  --prompt "A cinematic mechanical keyboard product shot" \
  --size "1024x1024" \
  --out "./keyboard.png"
```

参考图：

```bash
node scripts/generate.js \
  --prompt "Turn this into a watercolor poster" \
  --image-url "/absolute/path/to/reference.png"
```

## 支持的尺寸

- `1024x1024`
- `1024x1536`
- `1536x1024`
- `768x768`
- `768x1152`
- `1152x768`
- `1536x864`
- `864x1536`
- `1920x1080`
- `1080x1920`
- `2048x2048`
- `3840x2160`
- `2160x3840`
- `2160x2160`
- `auto`

也支持这些别名：

- `1:1`
- `3:4`
- `4:3`
- `16:9`
- `9:16`
- `square`
- `portrait`
- `landscape`
- `wide`
- `vertical`
- `2k`
- `2k-landscape`
- `2k-portrait`
- `4k`
- `4k-landscape`
- `4k-portrait`
- `4k-square`

如果传入 `--out`，CLI 会在接口返回 `data:image/...;base64` 或图片 URL 时直接保存成本地图片文件，并把文件路径打印到 stdout。

重试保持选定模型和请求尺寸；失败时返回错误，不自动降低尺寸或进行本地放大。

当 SubRouter/VSIX 网关短暂返回 `502/503/504`、超时或 TLS/SSL 断连时，CLI 会对每个接口请求做多次退避重试。可用 `VSIX_IMAGE_RETRY_LIMIT` 和 `VSIX_IMAGE_RETRY_BASE_DELAY_MS` 调整每个接口的尝试次数和基础等待时间；`VSIX_IMAGE_RETRY_LIMIT=1` 表示不重试。请求超时默认 120 秒，可用 `VSIX_IMAGE_REQUEST_TIMEOUT_MS` 调整。

如果要直接走 SubRouter，可临时设置：

```bash
VSIX_API_BASE="https://subrouter.ai/v1" VSIX_API_KEY="YOUR_SUBROUTER_KEY" node scripts/generate.js ...
```

也可以把网关地址持久写入本地配置：

```json
{"api_key":"YOUR_KEY","api_base":"https://vsix.cc/v1"}
```

如果 `api_base` 只写到域名根地址（例如 `https://vsix.cc`），CLI 会自动补齐 `/v1`。

## 仓库结构

- `SKILL.md`: skill 触发规则和执行流程
- `agents/openai.yaml`: agent UI 元数据
- `scripts/generate.js`: 实际调用 VSIX 图片接口的 CLI
