# 已选方案制作草拟子流程

本文件只提供给独立方案制作 subagent。每个 subagent 一次只处理一个已选方案，完成一次性草拟后返回主 agent；不得直接向用户提问、调用付费图片/视频生成、上传素材或长期等待用户。

## 输入

- 一个已选策略对象及其稳定方案 ID。
- 对该方案必要的商品事实、重点集尾帧证据、人物/关系、连续性资产、参考图候选和用户约束。
- `narrative-dialogue-prompt-reference.md`、`tail-ad-insertion.md`、`storyboard-prompt.schema.json`。
- 阶段：`asset_draft` 或 `storyboard_draft`。

不要传完整父对话、全部逐集分析、其他未选方案或平台原始日志。

## asset_draft

返回一个紧凑 JSON，包含创意方案摘要、人物精修槽位计划、GPT-image-2 落版图英文提示词、中文理由、必须保持项和风险。只准备待主 agent 展示和确认的内容，不创建生成任务。

## storyboard_draft

仅在落版图已审核、参考图上传成功并获得不可变 `referenceSnapshot` 后执行。基于该快照生成严格符合 `storyboard-prompt.schema.json` 的 JSON；中文和英文内容必须在同一字段对象中成对提供，不得另写一整块自由英文 prompt。

把 JSON 写到 Novvy workspace 后运行：

```bash
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")"
"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/storyboard_prompt_contract.py" \
  "<storyboard JSON>" \
  --output-dir "<Novvy workspace 内的方案目录>" \
  --check-schema "$SKILL_DIR/references/storyboard-prompt.schema.json"
```

只返回编译器的精简摘要、`reviewPath`、`compiledPath` 和 prompt hashes。主 agent 必须从 `reviewPath` 原样展示固定审核稿，从 `compiledPath.videoTasks[]` 逐镜提交；禁止再手写、重排或自由翻译最终提示词。

