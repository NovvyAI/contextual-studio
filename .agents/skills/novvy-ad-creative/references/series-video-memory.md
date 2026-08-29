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
- 每集在全片范围均匀取 20 帧，所有成功帧只合成一张 `overviewSheets[0]`。20 帧或唯一拼图任一缺失都视为证据失败。
- 整剧证据固定关闭音频预览；不生成、读取或转写音频，不探测 Whisper/ASR，也不额外打开原视频或独立帧。
- 证据默认写入 `~/novvy_ad_workplace/video-memory/evidence/<fingerprint>/evidence`。内容相同即使改名或移动，也复用同一证据。
- 任一集证据失败都必须阻断完整整剧结果；不能跳过失败集或用相邻集补齐。

单视频证据：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/prepare_video_evidence.py" "<单个视频路径>" --frame-count 20 --no-audio-preview
```

整剧证据：

```bash
SKILL_DIR="<novvy-ad-creative skill 根目录>"
NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/prepare_series_evidence.py" "<整剧文件夹>"
```

`prepare_series_evidence.py` 只生成当前视频分析 agent 的 `series_evidence_manifest.json`。manifest 固定集序、每集证据、缓存位置和本 agent 要分析的集，不包含任何需要父流程提交的 task。

## 记忆复用

内容匹配不依赖绝对路径，也不依赖本轮所选游戏。视频分析 artifact 只保存剧集事实、叙事、人物、关系、视觉与通用广告改编锚点，禁止写入具体游戏名、游戏对象或某款游戏专属判断。单集键由文件大小和头部、中部、尾部内容采样指纹组成，并绑定 `analysisVersion`；整剧键由自然集序中的逐集指纹组成，全剧合辑单视频也必须用其内容指纹生成整剧键。增加、删除、替换或重排剧集会产生新的整剧键，但未变化单集仍可命中；同一剧更换所选游戏仍直接命中同一整剧 artifact。

视频分析 agent 按以下规则执行：

1. 整剧完整命中：用 `lookup --include-analysis` 读取整剧 artifact 并直接返回，不重新取帧、不查看拼图、不做逐集模型分析，也不重新做全剧汇总；`modelAnalysisRequired == false`、`requiredEpisodeModelPassCount == 0`、`requiredSeriesAggregationPassCount == 0`。本次运行状态使用 `currentRunReusedEpisodeIndexes == [1..episodeCount]`、`currentRunAnalyzedEpisodeIndexes == []`，不要改写 artifact 内首次生成时的历史字段。
2. 部分命中：复用命中集，只为每个未命中集准备一次证据并各做一次视觉分析，然后重新汇总完整整剧一次。
3. 完全未命中：为每集各准备一次证据并各做一次视觉分析，再汇总完整整剧一次。
4. 用户明确要求重新分析：给证据脚本加 `--force-reanalyze`，忽略分析记忆但仍可复用相同内容的已生成证据。

manifest 的 `seriesAgent.action` 只允许：

- `reuse_cached_series_analysis`
- `analyze_entire_series`
- `blocked_by_evidence_failure`

`seriesAgent.requiredAgentCount` 只能是 0 或 1。非完整命中且证据齐全时必须为 1，表示当前已经启动的视频分析 agent 自己完成整剧分析，不表示再创建一个 agent。

## 分析与写入顺序

1. 校验 `workflowMode == "single_series_video_analysis_agent"`、`fixedInvariants.framesPerEpisode == 20`、`fixedInvariants.overviewSheetsPerEpisode == 1`、`fixedInvariants.audioEvidenceEnabled == false`、`fixedInvariants.visualAnalysisPassesPerMissedEpisode == 1`、`fixedInvariants.parentMaySubmitEpisodeTasks == false`、`fixedInvariants.parentMaySubmitAggregationTask == false` 和 `fixedInvariants.modelMaySelectRepresentativeEpisodes == false`；当 `seriesAgent.action == "analyze_entire_series"` 时，另校验 `fixedInvariants.seriesAggregationPasses == 1`。
2. 对每个 `episodeJobs[].analysis.action == "analyze_in_series_agent"` 的集，只查看该集唯一拼图一次，并在同一次视觉分析中产出单集 JSON。metadata 只读取文件名、时长、宽高和帧数；不读取其他媒体。
3. 每个新单集 JSON 成功后立即写入 `analysis/episodes/<episodeKey>/analysis.json`；这里保存的是该集完整大模型总结，不是路径摘要或裁剪后的重点集摘要。结构修复不得触发第二次视觉分析。`reuse_cached_analysis` 的集直接加载缓存 JSON。
4. 按 `episodeIndex` 形成恰好 `episodeCount` 个单集 JSON。数量不足、重复或集序缺口时停止，不重复分析单集。
5. 只把按集序排列的全部单集 JSON 作为输入，执行恰好一次整剧汇总；不再读取拼图、metadata、视频或音频。校验逐集广告相关证据覆盖全部集，并形成至少包含主题/核心冲突、人物/关系弧和另一类跨集证据的全剧广告锚点。
6. `store-series` 写入前必须确认每个 `episodeAnalyses[]` 与对应独立单集缓存逐字段完全一致；随后把全部 `episodeAnalyses` 和最终 `seriesAnalysis` 一起写入 `analysis/series/<seriesKey>/analysis.json`。写入结果必须返回 `completeEpisodeAnalysesPersisted == true`、`finalSeriesSummaryPersisted == true`、`cacheReadyForExactReuse == true`。
7. 写完后再次执行 `lookup --include-analysis`；只有确认同一 `seriesKey` 的 `modelAnalysisRequired == false` 且两类 required pass 都为 0，才向主 agent 返回成功结果。

单集记忆写入：

```bash
"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/video_analysis_memory.py" store-episode "<单集视频>" --analysis-file "<单集分析 JSON>"
```

整剧记忆写入：

```bash
"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/video_analysis_memory.py" store-series "<全剧合辑视频或整剧文件夹>" --analysis-file "<含全部逐集总结和最终总结的完整 JSON>"
```

整剧命中读取：

```bash
"$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/video_analysis_memory.py" lookup "<全剧合辑视频或整剧文件夹>" --include-analysis
```

不要缓存未完成、无法解析或混入 Markdown 的结果。

## 返回主流程

- `uiImages`：首次生成或重新分析的每集唯一拼图绝对路径；主 agent 负责用 Markdown 图片展示。
- `reusedEpisodeIndexes`：复用记忆的集序。
- `analyzedEpisodeIndexes`：本次在视频分析 agent 内新分析的集序。
- `episodeAnalyses`：覆盖全部集、按集序排列的完整单集模型总结；必须与独立单集缓存完全一致。
- `seriesAnalysis`：完整整剧主线、人物/关系演进、跨集情绪、逐集广告相关证据、全剧广告锚点、重点改编集和连续性资产。
- `analysisArtifactPath`：包含完整 `episodeAnalyses` 和最终 `seriesAnalysis` 的整剧 artifact 路径；同一 `seriesKey` 后续直接读取此 artifact。
- `failedEpisodes`：失败集及原因；非空时 `ok` 必须为 `false`。
