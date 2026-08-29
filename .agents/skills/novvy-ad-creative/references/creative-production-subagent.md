# 已选方案制作草拟子流程

本文件只提供给独立方案制作 subagent。每个 subagent 一次只处理一个已选方案，完成一次性草拟后返回主 agent；不得直接向用户提问、调用付费图片/视频生成、上传素材或长期等待用户。

## 输入

- 一个已选策略对象及其稳定方案 ID。
- 对该方案必要的商品事实、全剧广告锚点、重点集证据、人物/关系、连续性资产、参考图候选和用户约束。
- `SKILL_DIR`。
- `narrative-dialogue-prompt-reference.md`、`drama-related-ad.md`、`audiovisual-creative-quality.md`、`storyboard-prompt.schema.json`。
- 阶段：`asset_draft` 或 `storyboard_draft`。

不要传完整父对话、全部逐集分析、其他未选方案或平台原始日志。

## asset_draft

先完整读取 `audiovisual-creative-quality.md`，沿用已选方案的 `audiovisualQuality.qualityRecordIds`，用 `scripts/query_audiovisual_quality.py` 逐条校验来源；再按当前制作阶段补查必要记录，不加载整份矩阵。

返回一个紧凑 JSON，包含创意方案摘要、`audiovisualQualityPlan`、人物精修槽位计划、GPT-image-2 落版图英文提示词、中文理由、必须保持项和风险。`audiovisualQualityPlan` 要写沿用/新增的记录 ID、转译后的可观察参数、硬门风险及取舍，不得把导演姓名当成生成参数。参考图槽位计划必须为每个原剧候选带上 `slot`、`episodeIndex`、`frameIndex`、`localImagePath`、`viewDifference`、`confidence` 和 `risk`；`localImagePath` 必须是已存在的本地绝对图片路径。若同一缺失槽位有多个替代候选，全部返回，不能只选一张或只返回帧号。主 agent 必须逐张用 Markdown 图片展示后才能让用户接受风险或选择精修。只准备待主 agent 展示和确认的内容，不创建生成任务。

## storyboard_draft

仅在落版图已审核、参考图上传成功并获得不可变 `referenceSnapshot` 后执行。基于该快照生成严格符合 `storyboard-prompt.schema.json` 的 JSON；必须原样保留与 `slotOrder` 一一对应的本地 `previewItems`，让编译器在每镜【参考图绑定】中展示实际图片。用户没有指定时，每个 `durationSeconds` 写 `8`；只有内容确有需要或用户明确要求时才在 `4-15` 秒内调整。中文和英文内容必须在同一字段对象中成对提供，不得另写一整块自由英文 prompt。

逐镜只查询真正需要的构图、机位、运镜、剪辑、音频或 UI 记录，把规则转译后写进现有 `camera`、`transition`、`audio`、`continuity` 和 `additionalNegativeConstraints`。每个镜头先明确触发事件、运动/剪辑动作、终点构图和信息/情绪结果；默认一个主要镜头动作，不堆叠炫技。记录 ID 和导演姓名只用于审核摘要，不直接写入视频生成 prompt。任一硬门风险未关闭时停止编译并返回 `blocker`。

把 JSON 写到 Novvy workspace 后运行：

```bash
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")"
"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/storyboard_prompt_contract.py" \
  "<storyboard JSON>" \
  --output-dir "<Novvy workspace 内的方案目录>" \
  --check-schema "$SKILL_DIR/references/storyboard-prompt.schema.json"
```

只返回编译器的精简摘要、视听质量审核摘要、`reviewPath`、`compiledPath` 和 prompt hashes。主 agent 必须从 `reviewPath` 原样展示固定审核稿，从 `compiledPath.videoTasks[]` 逐镜提交；禁止再手写、重排或自由翻译最终提示词。
