# 参考图逐图审核子流程

本文件只提供给一个独立参考图审核 subagent。它只负责渲染候选图片、检查实际像素、生成带内容指纹的审核清单，并运行确定性脚本得到上传计划；它不上传素材、不调用图片或视频生成、不接收完整父对话。

## 父流程传入

- `SKILL_DIR`：当前 `novvy-ad-creative/SKILL.md` 所在目录。
- 候选槽位：槽位名、来源本地路径、人物身份、目标视角、来源说明和置信度。
- 如同一缺失槽位有多个近似候选，父流程同时传入每个候选的本地绝对路径、集数/帧号和风险；subagent 逐张查看，不得只看候选拼图或只返回文字结论。
- 目标上传模式：`asset`、`seedance-human` 或 `mixed`。同时含已确认真人和非真人素材时必须使用 `mixed`。
- `requiredSlots`：后续分镜保持人物/场景连续性不可缺少的槽位。审核失败的必需槽位会阻断上传。
- `waivedSlots`：仅放用户已明确接受缺失风险的必需槽位；没有用户确认时必须为空，subagent 不得自行豁免。
- 如由失败恢复触发，只传净化后的 `phase`、`errorClass`、`failedSlot` 和错误摘要；不要传平台原始响应、token、签名 URL 或完整生成日志。
- Novvy workspace 内用于保存审核 JSON 和脚本结果的目录。

远程 URL 不是稳定审核素材。所有准备进入上传计划的远程图都先用允许的下载脚本物化到 Novvy workspace，再查看该本地副本，并让 `source` 指向这份已审核的本地文件。`source` 只允许本地绝对路径；禁止审核一个 URL 后让平台重新拉取可能变化的另一份内容。

## 审核规则

逐张实际渲染图片并查看像素。不能根据文件名、槽位名、提示词、上游标签或旧审核结果判断；失败恢复必须重新看当前图片。每张图只能属于一个分类：

- `human_photorealistic`：清楚可辨的真人实拍，或达到真人照片观感的写实人物；身份和目标视角可核对，没有明显动漫、插画、卡通、CG、游戏建模、玩偶或蜡像感。
- `non_human`：动漫、插画、卡通、CG/游戏角色、玩偶、蜡像、UI、落版图、商品图、纯背景，或其他明确不是真人照片观感的素材。
- `uncertain`：人脸过小、严重模糊、遮挡、拼接混杂、图片打不开、身份/视角无法核对，或无法可靠判断。

`seedance-human` 模式的决策固定为：

- `human_photorealistic` 且身份、视角均通过：`pass`。
- `non_human`：`exclude`，不得上传、不得进入 `humanImageUrls`。
- `uncertain`：`block`，停止上传并要求替换或重新审核。
- `final_card`、`product_icon`、UI、落版、商品图和纯背景永远不能判为真人通过。

`asset` 模式若发现任何 `human_photorealistic + pass`，不要继续普通上传；全真人改走 `seedance-human`，真人与落版/UI 等非真人并存则改走 `mixed`。`mixed` 模式中，`human_photorealistic` 和 `non_human` 均为 `pass`，`uncertain` 为 `block`；脚本会把通过项确定性拆为真人组和非真人组。不确定人物不能进入任一数组，已确认真人不能进入 `imageUrls`。

## 固定输出

为每个已渲染的本地文件计算 SHA-256，格式为 `sha256:<64 位小写十六进制>`。写入一个严格符合 `references/reference-review.schema.json` 的 JSON 文件：

```json
{
  "schemaVersion": "novvy.reference-review.v1",
  "reviewId": "review-<稳定ID>",
  "requestedUploadMode": "seedance-human",
  "requiredSlots": ["male_front"],
  "waivedSlots": [],
  "priorFailure": null,
  "slots": [
    {
      "slot": "male_front",
      "source": "/absolute/path/inside/novvy/workspace/male-front.png",
      "sourceFingerprint": "sha256:<hex>",
      "pixelReviewed": true,
      "visualClass": "human_photorealistic",
      "reviewDecision": "pass",
      "reviewReason": "清楚可辨的真人照片观感，身份和正面视角均可核对。",
      "identityMatch": "pass",
      "viewMatch": "pass"
    }
  ]
}
```

`priorFailure` 非空时只允许 `phase`、`errorClass`、`failedSlot`、`summary` 四个字段。不得把平台原始响应写入审核清单。

## 脚本校验

写完审核 JSON 后必须运行：

```bash
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")"
"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/reference_workflow.py" plan-upload \
  "<审核 JSON 路径>" \
  --output-dir "<Novvy workspace 内的本次方案目录>"
```

脚本失败时按结构化 `errorClass` 和 `safeNextStep` 处理；不要绕过校验、手工删字段后假装通过，也不要上传。脚本成功后只向父流程返回：

```json
{
  "ok": true,
  "state": "UPLOAD_PLAN_READY",
  "auditId": "",
  "uploadMode": "asset|seedance-human|mixed",
  "requiredSlots": [],
  "waivedSlots": [],
  "acceptedSlots": [],
  "confirmedHumanSlots": [],
  "skippedSlots": [],
  "uploadGroups": {},
  "previewItems": [
    {"slot": "male_front", "localImagePath": "/absolute/path/inside/novvy/workspace/male-front.png"}
  ],
  "reviewManifestPath": "",
  "uploadPlanPath": ""
}
```

`previewItems` 必须与通过槽位顺序完全一致，供父流程用 `![槽位](</absolute/path>)` 直接展示；不能省略、改成远程 URL 或用上传引用替代。不要返回图片二进制、完整来源 URL、完整脚本输出或父流程长上下文。上传 subagent 从 `uploadPlanPath` 读取精确槽位、来源和哈希。
