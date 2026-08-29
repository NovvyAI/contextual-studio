# 本地参考图组直传子流程

用于审核通过的落版图、主人公截图或用户提供的现成参考图需要上传到 Novvy AI Platform 的场景。目标是把本地读取、HTTP 直传、Seedance 真人人像素材上传隔离在独立上传 subagent，主流程只接收可放入视频 payload 的多图数组和精简槽位摘要。`product_icon` 已从参考图组删除，不上传平台，也不传给后续生成模型。

## 父流程传入

只传必要上下文：

- 独立参考图审核 subagent 已生成并经 `reference_workflow.py plan-upload` 校验的 `uploadPlanPath`。它是上传槽位、来源、顺序、文件 SHA-256、视觉分类和上传模式的唯一来源。
- 审核 subagent 的精简摘要：`auditId`、`uploadMode`、`requiredSlots`、`waivedSlots`、`acceptedSlots`、`confirmedHumanSlots`、`skippedSlots`、按槽位排序的本地 `previewItems`；不要把未校验候选交给上传 subagent。
- `SKILL_DIR`：当前已加载 `novvy-ad-creative/SKILL.md` 所在目录。上传命令必须完全来自审核计划，并额外传 `--review-plan-json "$UPLOAD_PLAN_PATH"`。
- 父流程已经向用户展示参考图组上传执行说明；落版图已审核通过，槽位来源已满足。该步骤不再额外等待用户确认，上传 subagent 收到任务后直接批量上传。

不要传完整父对话、完整视频解析笔记、创意长文、视频 prompt、最终视频 payload、登录凭据或 bearer token。

## 本地参数

脚本会自动读取 `~/novvy_ad_workplace/novvy-plugin-config.json`。该文件由 `$novvy-env-check` 回填，可能包含 `pythonPath`、`ffmpegPath`、`ffprobePath` 和 `workspaceDir`。上传 subagent 不需要手动读取或展示这个文件；只需通过 `"$SKILL_DIR/scripts/novvy_python.sh"` 解析 Python，并把本地临时文件保留在 `~/novvy_ad_workplace` 或配置后的 Novvy workspace。如果 Codex 沙盒拒写默认 home workspace，父流程应请求用户授予 `~/novvy_ad_workplace` 写权限后重试一次，不得改写到当前 task 的 `work/` 目录。

## 认证

`scripts/upload_ai_platform_asset.py` 通过 HTTP 调用 AI Platform，不调用 MCP。服务地址从调用方显式传入的项目 `.mcp.json` 读取：

- `mcpServers.novvy_ai_platform.url` 必须是 Novvy MCP 地址，例如 `https://developer.novvy.ai/mcp`；脚本会由此推导 HTTP API base URL。
- 认证按顺序读取项目/插件本地 `novvy-plugin-local.json` 的 `adminUserApiKey`、`.mcp.json` 的 `http_headers.Authorization`、`NOVVY_API_KEY`、`NOVVY_MCP_AUTHORIZATION`；只使用首个有效值。
- Contextual Studio 的常规部署优先使用项目 `.env` 中的 `NOVVY_MCP_AUTHORIZATION`，不要要求普通用户理解或手工编辑插件缓存目录。
- 如果平台返回 `Invalid token`，只说明本机 Novvy key 无效、过期或未同步；提示用户检查项目鉴权配置后，从参考图组上传步骤重试。不要自动重传，不要猜测新 key。

不要把 apikey、token、密码、签名上传 URL 或本地二进制返回给父流程。

## 执行规则

- 先运行 `NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")"` 检查并解析可用 Python 3.10+，再运行 `"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py"` 一次批量上传全部槽位来源。必须通过 resolver 返回的解释器调用脚本，不要直接执行 `scripts/*.py`，也不要假设当前工作目录就是 skill 根目录。
- 单一模式从 `uploadPlanPath` 读取 `uploadArgs`；`mixed` 模式分别读取 `uploadGroups.asset.uploadArgs` 和 `uploadGroups.seedance-human.uploadArgs`，各运行上传脚本一次，并都增加 `--review-plan-json "$UPLOAD_PLAN_PATH"`。不得自行增删、重排或替换槽位/来源；命令与计划不一致会在任何 HTTP 调用前失败。
- 默认不要运行 `scripts/compose_reference_panel.py`，不要生成、上传或返回单张拼接参考图。最终视频必须使用多张参考图数组。
- 普通 `asset` 模式输入顺序必须与槽位顺序一致：`male_front`、`male_side`、`female_front`、`female_side`、`final_card`。缺少审核通过的 `final_card` 时，不得上传参考图组。
- 上传脚本会在请求 Novvy/Doubao 前用 Pillow 预检图片宽度，默认允许 300-6000px。若某个槽位图片宽度过小或过大，脚本返回 `failedStep: "image_validation"`；先按 `safeNextStep` 重新裁切、补边或缩放对应图片，再重跑。不得把内容不合格的人物图仅靠放大伪装成真人审核通过。
- 不要把任何中间文件写到当前工作目录、插件缓存目录、视频源目录或系统临时目录。
- 卡通动画、2D/3D 动画、CG、漫画风和其他非真人素材使用已校验的 `asset` 计划。计划若含 `human_photorealistic + pass`，会在网络调用前拒绝普通上传并要求改走真人模式。
- 真人实拍或真人照片观感的人像使用 `seedance-human`。上传器强制消费审核计划，并把当前文件字节 SHA-256 与计划逐槽位比对；远程真人图必须先物化并审核本地副本。只有 `human_photorealistic + pass` 会上传，`non_human` 排除，`uncertain` 阻塞，`final_card`/UI/落版/商品图/背景永不进入 `humanImageUrls`。
- 同一参考图组同时含真人与非真人时使用 `mixed` 审核计划：真人组走 `seedance-human`，其返回的公网 `https://...` 或 `asset://asset-...` 写入 `humanImageUrls`；非真人组走普通 `asset` 上传，其公网链接写入 `imageUrls`。两组都成功后运行 `reference_workflow.py build-mixed-snapshot`，最终每个视频 payload 同时携带两组字段。
- 上传成功后，快照必须保留审核计划中的 `previewItems`；这些绝对本地路径只用于用户界面预览，不进入视频生成 payload。父流程必须按 `slotOrder` 展示每张本地图片，不能只展示 `asset://` 或远程上传引用。
- 只信任默认成功 JSON 的顶层字段：`ok`、`uploadMode`、`referenceField`、`referenceUrls`、`videoPayloadHint`、`referenceSnapshotId`、`referenceSnapshot`、`slots`、`skippedSlots`、`fileNames`、`warnings`、`retrySummary`，真人模式另含 `confirmedHumanSlots`。默认输出不得包含完整 `assets`；只有用户明确要求调试时才允许加 `--include-assets`，且完整输出不得回传父流程。
- 从 `videoPayloadHint[referenceField]` 派生最终视频参考图数组，并校验它与 `referenceUrls` 和实际上传槽位数量一致；被跳过的 `product_icon` 或非真人槽位只出现在 `skippedSlots`，不参与数量校验。如果脚本退出码为 0 但 `referenceField` 缺失，或 `videoPayloadHint[referenceField]` 不是与实际上传槽位数量一致的完整数组，不要返回 `unavailable`，也不要自动重传。返回 `ok: false`，`failedStep: "http_upload_parse"`，并提示先通过平台资产记录找回本次新建 asset 引用，找不到再经用户确认后重传。
- 脚本失败时返回固定 JSON：`ok: false`、`errorClass`、`error`、`failedStep`、`failedSlot`、`safeNextStep`、`retryable`、`attempts`、`completedSlots`、`pendingSlots`、`retrySummary`、`warnings`，HTTP 错误还可含 `statusCode`。默认永不返回 `responseBody`；不要从 stderr 或平台 raw 猜错误。
- 只在 subagent 内部读取脚本完整输出。不要把完整 `uploadUrl`、token、密码、本地二进制、base64、MCP raw 或脚本调试日志发回父流程。
- 只对收到明确失败响应的瞬时远程错误按 `Retry-After` 有上限重试，默认最多 3 次。Seedance 非幂等 POST 的超时/断线属于 `ambiguous_commit`，先按平台记录找回资产，不直接重发。认证、参数、图片宽度、哈希变化、真人审核、非真人拒绝、非临时 4xx 和响应解析失败不自动重试。
- `material_not_human`、`human_review_required`、`reference_mode_mismatch` 必须返回父流程并重新启动参考图审核 subagent；上传 subagent 不能自行改判。`response_contract`/`ambiguous_commit` 先找回已创建资产。只有输入或外部状态改变后才重跑；同类修复最多 1 次，脚本总运行最多 3 次。
- 上传失败时，只返回错误摘要、已执行的重试次数和下一步建议；不要返回本地文件 payload。

普通多图上传命令示例：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
UPLOAD_PLAN_PATH="<reference_workflow.py 生成的 upload plan JSON>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py" \
  --slot "male_front=<男主正视图本地绝对路径>" \
  --slot "male_side=<男主侧视图本地绝对路径>" \
  --slot "female_front=<女主正视图本地绝对路径>" \
  --slot "female_side=<女主侧视图本地绝对路径>" \
  --slot "final_card=<审核通过的落版图本地绝对路径>" \
  --review-plan-json "$UPLOAD_PLAN_PATH" \
  --mode asset
```

Seedance 真人多图上传命令示例：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
UPLOAD_PLAN_PATH="<reference_workflow.py 生成的 upload plan JSON>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py" \
  --slot "male_front=<男主正视图本地绝对路径>" \
  --slot "male_side=<男主侧视图本地绝对路径>" \
  --slot "female_front=<女主正视图本地绝对路径>" \
  --slot "female_side=<女主侧视图本地绝对路径>" \
  --confirmed-human-slot male_front \
  --confirmed-human-slot male_side \
  --confirmed-human-slot female_front \
  --confirmed-human-slot female_side \
  --review-plan-json "$UPLOAD_PLAN_PATH" \
  --mode seedance-human
```

若视频不是男女双主，使用最重要的可见真人槽位，并为每个通过逐图视觉审核的槽位加 `--confirmed-human-slot`：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
UPLOAD_PLAN_PATH="<reference_workflow.py 生成的 upload plan JSON>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py" \
  --slot "lead_front=<主角正视图本地绝对路径>" \
  --confirmed-human-slot lead_front \
  --review-plan-json "$UPLOAD_PLAN_PATH" \
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
  "referenceSnapshotId": "ref-...",
  "referenceSnapshot": {
    "snapshotId": "ref-...",
    "referenceField": "imageUrls",
    "slotOrder": [],
    "referenceUrls": [],
    "previewItems": [
      {"slot": "male_front", "localImagePath": "/absolute/path/inside/novvy/workspace/male-front.png"}
    ]
  },
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
  "retrySummary": {
    "maxAttemptsPerOperation": 3,
    "retryCount": 0,
    "events": []
  },
  "warnings": []
}
```

失败：

```json
{
  "ok": false,
  "errorClass": "source_invalid|human_review_required|material_not_human|reference_mode_mismatch|reference_invalid_or_inactive|transient_remote|auth|ambiguous_commit|response_contract|prompt_or_parameter|unknown",
  "error": "",
  "failedStep": "cli_arguments|local_environment|local_io|source_download|image_validation|human_visual_validation|http_upload|http_upload_parse",
  "failedSlot": "",
  "safeNextStep": "",
  "retryable": false,
  "attempts": 1,
  "completedSlots": [],
  "pendingSlots": [],
  "retrySummary": {
    "maxAttemptsPerOperation": 3,
    "retryCount": 0,
    "events": []
  },
  "warnings": []
}
```

单一上传结果的 `referenceField` 只能是 `imageUrls` 或 `humanImageUrls`；组合快照的 `referenceField` 为 `mixed`。单一模式运行 `build-snapshot`，混合模式运行 `build-mixed-snapshot`；父流程只保存不可变快照、槽位摘要、跳过槽位摘要、文件名摘要、精简重试摘要、真人确认槽位和告警。
