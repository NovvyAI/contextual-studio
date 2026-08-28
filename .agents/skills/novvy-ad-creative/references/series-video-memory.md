# 单集、整剧证据与分析记忆

本文件只在用户提供本地单视频、整剧文件夹，或可能重复选择同一剧时使用。主流程把完整视频输入交给一个独立视频分析 agent；本文件规定该 agent 内部如何准备证据和复用记忆。

## 所有权边界

- 主 agent 只创建 1 个视频分析 agent，并把整个文件或整个文件夹一次性交给它。
- 视频分析 agent 独占文件枚举、取帧、逐集理解、记忆读写和整剧汇总。
- 主 agent 不枚举剧集，不逐集提交分析 task，不提交额外整剧汇总 task。
- 视频分析 agent 不创建子 agent，也不把逐集或汇总工作提交成 task；它在自己的上下文中完成全部分析并返回一个整剧结果。

## 输入与证据

- `prepare_video_evidence.py` 每次只接收一个视频文件。
- 文件夹代表整剧。递归识别 `.3gp`、`.avi`、`.m4v`、`.mkv`、`.mov`、`.mp4`、`.mpeg`、`.mpg`、`.mts`、`.m2ts`、`.ts`、`.webm`，忽略隐藏目录，并按文件名中的数字自然排序。
- 每集在全片范围均匀取最多 20 帧，所有成功帧只合成一张 `overviewSheets[0]`；不足 20 帧时网格自动适配。
- 证据默认写入 `~/novvy_ad_workplace/video-memory/evidence/<fingerprint>/evidence`。内容相同即使改名或移动，也复用同一证据。
- 任一集证据失败都必须阻断完整整剧结果；不能跳过失败集或用相邻集补齐。

单视频证据：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/prepare_video_evidence.py" "<单个视频路径>" --frame-count 20
```

整剧证据：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/prepare_series_evidence.py" "<整剧文件夹>"
```

`prepare_series_evidence.py` 只生成当前视频分析 agent 的 `series_evidence_manifest.json`。manifest 固定集序、每集证据、缓存位置和本 agent 要分析的集，不包含任何需要父流程提交的 task。

## 记忆复用

内容匹配不依赖绝对路径。单集键由文件大小和头部、中部、尾部内容采样指纹组成，并绑定 `analysisVersion`；整剧键由自然集序中的逐集指纹组成。增加、删除、替换或重排剧集会产生新的整剧键，但未变化单集仍可命中。

视频分析 agent 按以下规则执行：

1. 整剧完整命中：读取整剧记忆并返回，不重新取帧或分析。
2. 部分命中：复用命中集，只为未命中集准备证据并在当前 agent 内分析，然后重新汇总完整整剧。
3. 完全未命中：为每集各准备一次证据，在当前 agent 内逐集分析，再汇总完整整剧。
4. 用户明确要求重新分析：给证据脚本加 `--force-reanalyze`，忽略分析记忆但仍可复用相同内容的已生成证据。

manifest 的 `seriesAgent.action` 只允许：

- `reuse_cached_series_analysis`
- `analyze_entire_series`
- `blocked_by_evidence_failure`

`seriesAgent.requiredAgentCount` 只能是 0 或 1。非完整命中且证据齐全时必须为 1，表示当前已经启动的视频分析 agent 自己完成整剧分析，不表示再创建一个 agent。

## 分析与写入顺序

1. 校验 `workflowMode == "single_series_video_analysis_agent"`、`fixedInvariants.parentMaySubmitEpisodeTasks == false`、`fixedInvariants.parentMaySubmitAggregationTask == false` 和 `fixedInvariants.modelMaySelectRepresentativeEpisodes == false`。
2. 对 `episodeJobs[].analysis.action == "analyze_in_series_agent"` 的集，在当前 agent 内读取该集唯一拼图、metadata 和音频状态，产出单集 JSON。
3. 每个新单集 JSON 成功后立即写入单集记忆；`reuse_cached_analysis` 的集直接加载缓存 JSON。
4. 按 `episodeIndex` 形成恰好 `episodeCount` 个单集 JSON。数量不足、重复或集序缺口时停止。
5. 在当前 agent 内综合完整整剧结果，校验所有集结尾机会均被覆盖，再写入整剧记忆。
6. 最终只向主 agent 返回 `video-analysis-subagent.md` 定义的一个 JSON 对象。

单集记忆写入：

```bash
"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/video_analysis_memory.py" store-episode "<单集视频>" --analysis-file "<单集分析 JSON>"
```

整剧记忆写入：

```bash
"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/video_analysis_memory.py" store-series "<整剧文件夹>" --analysis-file "<整剧汇总 JSON>"
```

不要缓存未完成、无法解析或混入 Markdown 的结果。

## 返回主流程

- `uiImages`：首次生成或重新分析的每集唯一拼图绝对路径；主 agent 负责用 Markdown 图片展示。
- `reusedEpisodeIndexes`：复用记忆的集序。
- `analyzedEpisodeIndexes`：本次在视频分析 agent 内新分析的集序。
- `episodeAnalyses`：覆盖全部集、按集序排列的紧凑结果。
- `seriesAnalysis`：完整整剧主线、人物/关系演进、跨集情绪、各集结尾机会、重点植入集和连续性资产。
- `failedEpisodes`：失败集及原因；非空时 `ok` 必须为 `false`。

