# 本地参考图组直传子流程

用于审核通过的落版图、主人公截图或用户提供的现成参考图需要上传到 Novvy AI Platform 的场景。目标是把本地读取、HTTP 直传、Seedance 真人人像素材上传隔离在独立上传 subagent，主流程只接收可放入视频 payload 的多图数组和精简槽位摘要。`product_icon` 已从参考图组删除，不上传平台，也不传给后续生成模型。

## 父流程传入

只传必要上下文：

- 已确认的槽位来源：`male_front`、`male_side`、`female_front`、`female_side`，以及审核通过的 `final_card`；若视频不是男女双主，传最重要角色的替代槽位说明。
- 每个槽位的人物身份、视角、可见特征、替代风险和置信度摘要。
- `visualStyle.renderingType`：`live_action_realistic` 或 `cartoon_animation`，以及应使用的上传模式。
- 参考图槽位顺序，普通 `asset` 模式保持：`male_front`、`male_side`、`female_front`、`female_side`、`final_card`；`seedance-human` 模式只上传真人槽位，非真人图不得进入 human upload。不要传 `product_icon`。
- 允许使用的脚本：父流程必须传入 `SKILL_DIR`，也就是当前已加载 `novvy-ad-creative/SKILL.md` 所在目录；先运行 `NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")"` 检查并解析可用 Python 3.10+，再运行 `"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py"`，用重复的 `--slot SLOT=SOURCE` 显式传入槽位。
- 父流程已经向用户展示参考图组上传执行说明；落版图已审核通过，槽位来源已满足。该步骤不再额外等待用户确认，上传 subagent 收到任务后直接批量上传。

不要传完整父对话、完整视频解析笔记、创意长文、视频 prompt、最终视频 payload、登录凭据或 bearer token。

## 本地参数

脚本会自动读取 `~/novvy_ad_workplace/novvy-plugin-config.json`。该文件由 `$novvy-env-check` 回填，可能包含 `pythonPath`、`ffmpegPath`、`ffprobePath` 和 `workspaceDir`。上传 subagent 不需要手动读取或展示这个文件；只需通过 `"$SKILL_DIR/scripts/novvy_python.sh"` 解析 Python，并把本地临时文件保留在 `~/novvy_ad_workplace` 或配置后的 Novvy workspace。如果 Codex 沙盒拒写默认 home workspace，父流程应请求用户授予 `~/novvy_ad_workplace` 写权限后重试一次，不得改写到当前 task 的 `work/` 目录。

## 认证

`scripts/upload_ai_platform_asset.py` 通过 HTTP 调用 AI Platform，不调用 MCP。服务地址仍从插件根目录 `.mcp.json` 读取；认证由本机参数文件统一管理，`.mcp.json` 只作为自动同步出来的运行时副本：

- `mcpServers.novvy_ai_platform.url` 必须是 Novvy MCP 地址，例如 `https://developer.novvy.ai/mcp`；脚本会由此推导 HTTP API base URL。
- 每台电脑优先维护插件根目录 `novvy-plugin-local.json` 的 `"adminUserApiKey": "<admin_user.apikey>"`，env-check 会把它回填到 `~/novvy_ad_workplace/novvy-plugin-config.json`。旧字段 `apiKey`、`authorization` 仍兼容，但 env-check 会迁移到 `adminUserApiKey`。
- `mcpServers.novvy_ai_platform.http_headers.Authorization` 与 `adminUserApiKey` 是同一个值加 `Bearer ` 前缀，必须由 `./install.sh` 或 `$novvy-env-check` 自动同步，不要让用户手工同时维护两处。
- 兼容读取 `NOVVY_AUTHORIZATION`、`NOVVY_API_KEY`、`novvy-plugin-config.json` 中的 `adminUserApiKey`/旧别名，以及 `.mcp.json` 的 `mcpServers.novvy_ai_platform.http_headers.Authorization`。
- 如果平台返回 `Invalid token`，只说明本机 Novvy key 无效、过期或未同步；让用户先在插件根目录 `novvy-plugin-local.json` 填写本机 `admin_user.apikey`，再运行 `$novvy-env-check`，由 env-check 回填并同步，再从参考图组上传步骤重试。不要自动重传，不要猜测新 key。

不要把 apikey、token、密码、签名上传 URL 或本地二进制返回给父流程。

## 执行规则

- 先运行 `NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")"` 检查并解析可用 Python 3.10+，再运行 `"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py"` 一次批量上传全部槽位来源。必须通过 resolver 返回的解释器调用脚本，不要直接执行 `scripts/*.py`，也不要假设当前工作目录就是 skill 根目录。
- 必须使用命名槽位参数，格式为 `--slot "male_front=<路径或URL>"`。不要依赖位置参数推断槽位；位置参数只作为旧调用兼容，脚本会返回 warning。使用命名槽位时，脚本会按标准槽位顺序输出 `referenceUrls` 和 `slots`。
- 默认不要运行 `scripts/compose_reference_panel.py`，不要生成、上传或返回单张拼接参考图。最终视频必须使用多张参考图数组。
- 普通 `asset` 模式输入顺序必须与槽位顺序一致：`male_front`、`male_side`、`female_front`、`female_side`、`final_card`。缺少审核通过的 `final_card` 时，不得上传参考图组。
- 上传脚本会在请求 Novvy/Doubao 前用 Pillow 预检图片宽度，默认允许 300-6000px。若某个槽位图片宽度过小或过大，脚本返回 `failedStep: "image_validation"`，不要继续上传，不要自动重传；先让父流程替换、重新裁切、补边或放大该槽位图片后再重试。
- 不要把任何中间文件写到当前工作目录、插件缓存目录、视频源目录或系统临时目录。
- 卡通动画、2D/3D 动画、CG、漫画风、明显非真人写实素材使用普通 asset 上传：`--mode asset`。脚本成功后，`videoPayloadHint.imageUrls` 的完整数组放入视频 payload 的 `imageUrls`。
- 真人写实、实拍、短剧真人、写真人像照片素材使用 Seedance 真人人像上传：`--mode seedance-human`，脚本固定使用 `seedance-2.0-fast`。只上传确认是真人/人像的槽位，默认允许 `male_front`、`male_side`、`female_front`、`female_side`；`final_card`、游戏 UI、落版图、商品图、纯背景和任何非真人图不得上传，也不得进入 `humanImageUrls`。自定义真人槽位必须额外传 `--human-slot SLOT`，否则脚本会跳过。脚本会把真人图片二进制直传到 `/api/seedance-human-assets/upload`，服务端负责写入 GCS、创建 Seedance 素材并等待 `Active`，并在内部递归解析嵌套响应里的 `asset://...` 引用；脚本成功后，`videoPayloadHint.humanImageUrls` 的完整数组放入 Seedance payload 的 `humanImageUrls`。
- 只信任 `upload_ai_platform_asset.py` 默认成功 JSON 的顶层字段：`ok`、`uploadMode`、`referenceField`、`referenceUrls`、`videoPayloadHint`、`slots`、`skippedSlots`、`fileNames`、`warnings`。默认输出不得包含完整 `assets`；只有用户明确要求调试时，才允许加 `--include-assets`，且完整输出不得回传父流程。
- 普通素材上传会对限流、临时服务错误、签名过期和可安全重试的网络错误最多尝试 3 次，并在 `retrySummary` 记录尝试过程。真人素材创建属于非幂等提交；网络中断导致状态不确定时不得盲目重传，应先按 `safeNextStep` 查询平台资产状态。
- 上传失败时读取 `failedSlot`、`completedSlots`、`pendingSlots`、`errorClass`、`retryable` 和 `safeNextStep`。已经完成的槽位不重复上传，从失败槽位恢复；不要把平台原始响应、凭据或签名地址返回父流程。
- 从 `videoPayloadHint[referenceField]` 派生最终视频参考图数组，并校验它与 `referenceUrls` 和实际上传槽位数量一致；被跳过的 `product_icon` 或非真人槽位只出现在 `skippedSlots`，不参与数量校验。如果脚本退出码为 0 但 `referenceField` 缺失，或 `videoPayloadHint[referenceField]` 不是与实际上传槽位数量一致的完整数组，不要返回 `unavailable`，也不要自动重传。返回 `ok: false`，`failedStep: "http_upload_parse"`，并提示先通过平台资产记录找回本次新建 asset 引用，找不到再经用户确认后重传。
- 脚本失败时也会返回固定 JSON：`ok: false`、`error`、`failedStep`、`safeNextStep`、`warnings`。不要再从纯文本 stderr 猜测错误类型；`failedStep` 可能是 `cli_arguments`、`local_environment`、`local_io`、`image_validation`、`http_upload` 或 `http_upload_parse`。
- 只在 subagent 内部读取脚本完整输出。不要把完整 `uploadUrl`、token、密码、本地二进制、base64、MCP raw 或脚本调试日志发回父流程。
- 上传失败时，只返回错误摘要和下一步建议；不要返回本地文件 payload。

普通多图上传命令示例：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py" \
  --slot "male_front=<男主正视图路径或 URL>" \
  --slot "male_side=<男主侧视图路径或 URL>" \
  --slot "female_front=<女主正视图路径或 URL>" \
  --slot "female_side=<女主侧视图路径或 URL>" \
  --slot "final_card=<审核通过的落版图路径或 URL>" \
  --mode asset
```

Seedance 真人多图上传命令示例：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py" \
  --slot "male_front=<男主正视图路径或 URL>" \
  --slot "male_side=<男主侧视图路径或 URL>" \
  --slot "female_front=<女主正视图路径或 URL>" \
  --slot "female_side=<女主侧视图路径或 URL>" \
  --mode seedance-human
```

若视频不是男女双主，使用最重要的可见真人槽位，并为自定义真人槽位加 `--human-slot`：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py" \
  --slot "lead_front=<主角正视图路径或 URL>" \
  --human-slot lead_front \
  --mode seedance-human
```

## 返回 Schema

成功：

```json
{
  "ok": true,
  "uploadMode": "asset",
  "referenceField": "imageUrls",
  "referenceUrls": [],
  "videoPayloadHint": {
    "imageUrls": []
  },
  "slots": [
    {
      "slot": "male_front",
      "sourceName": "",
      "uploadedRefSummary": "",
      "character": "",
      "view": "front",
      "visibleFeatures": "",
      "confidence": "high",
      "risks": []
    }
  ],
  "fileNames": [],
  "skippedSlots": [],
  "warnings": []
}
```

失败：

```json
{
  "ok": false,
  "error": "",
  "failedStep": "cli_arguments|local_environment|local_io|image_validation|http_upload|http_upload_parse",
  "safeNextStep": "",
  "warnings": []
}
```

`referenceField` 只能是 `imageUrls` 或 `humanImageUrls`。父流程只允许保存 `referenceField`、`referenceUrls`、`videoPayloadHint`、槽位摘要、跳过槽位摘要、文件名摘要和告警。
