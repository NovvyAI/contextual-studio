# Contextual Studio TODO

## 逐镜人物参考过滤（暂缓）

目标：视频生成时只发送当前镜头实际出现人物的参考图，避免无关人物被模型加入画面或污染人物身份。

当前保持现状：Novvy MCP 每镜仍使用全部已确认原始人物参考，ImaRouter（包括 MiniMax-H3）每镜仍使用全部已确认人物六视图，并把对应分镜图放在数组最后。暂不在生产流程中启用 `characterIds` 过滤。

暂缓原因：当前短剧人物姓名经常只有外观称谓或身份未核实，例如“白裙少女”“金黑礼服青年”；直接要求模型给每镜绑定人物 ID，可能把艾琳、维拉等对白姓名错误对应到画面人物。需要先确保人物实体、展示名、剧中姓名和六视图之间的映射可靠。

后续实施事项：

- [ ] 人物确认结果保存稳定的 `characterId`、展示称谓、可选剧中姓名、身份置信度及六视图 URL。
- [ ] 正式分镜任务的每个 shot 增加 `characterIds`；无人镜头明确使用空数组。
- [ ] 仅允许引用已确认人物 ID，未知 ID 在提交媒体任务前报错。
- [ ] Novvy MCP 按 `characterIds` 选择原始人物参考；ImaRouter 按相同 ID 选择六视图，并保持分镜图最后传入。
- [ ] 旧工作台没有人物映射或 `characterIds` 时继续回退到全部已确认人物。
- [ ] UI 在每个文字分镜和视频提示词卡中展示“本镜头出镜人物”，允许用户在生成前修正。
- [ ] 增加单人物、双人物、无人镜头、同名人物、未核实姓名和旧数据回退测试。

验收标准：用户能在提交视频前看见并确认每镜人物列表；过滤只依赖稳定 ID，不根据名字或服装临时猜测；生成结果不出现未选择人物；旧项目不受影响。

## 创意工作台单线程解耦与状态存储重设计（暂缓）

目标：把创意工作台从"一条 Codex thread 贯穿全部阶段"改成按阶段解耦的无状态调用，并把状态从"追加式聊天记录，靠扫描历史推导最新版本"改成有明确 `status`/`version` 的结构化表。

当前保持现状：`server/creative-agent.js` 的 `runCreativeTurn` 仍然用同一条 `codex_thread_id` 贯穿 concept/reference/final_card/audiovisual/storyboard/prompt 全部阶段；卡片状态仍然靠 `creative_messages.cards_json` 追加新消息 + 前端/后端各自扫描历史推导"最新版本"（`latestMutableCardMessageIds`、`creativeAssets()`、`richestFinalCard()` 等）。

背景（本轮会话里讨论并验证过的具体问题）：

- **单点故障**：`resumeThread(session.codex_thread_id)` 找不到本机 Codex 会话时（换机器、磁盘清理、云端容器重建）没有任何兜底，`runCreativeTurn` 直接把 session 打成 `error`，此后该工作台所有创意轮次永久失败。`TODO.md` 里"GCP 上云"一节也间接提到这个问题（Codex Session 持久化尚未解决）。
- **上下文重复膨胀**：`sourceContext()` 只有首轮走精简的 `initialDramaContext()`；从第二轮起每轮都把完整 `drama.analysis_json` 原样重新贴一遍（22 号工作台实测约 10.5 万字符），叠加 thread 自身已经保留的历史，成本和延迟随轮次线性甚至更快增长。
- **状态没有单一权威来源，靠扫描历史猜"最新"**：这是本轮实际修复的三个 bug 的共同根因——"定位到待确认步骤"跳到早已废弃的候选卡（同一 `card.id` 在多条历史消息里重复出现，前端优先级打平后按 DOM 顺序猜）；未选中的落版方向候选永远停留在 `candidate` 状态，按钮一直可点击，误点可触发一次真实付费生成；`workspace.confirmedCards` 需要专门的合并逻辑（`creative-agent.js` 171-183 行）手动把 Codex 可能漏保留的字段拿回来。
- **无法按阶段换模型/供应商、无法并行**：`CODEX_ANALYSIS_MODEL` 全局唯一，创意策略生成和琐碎卡片编辑被迫用同一个模型；`session.stage='working'` 是全局互斥锁，逻辑上独立的子任务也只能排队。
- **参考对照**：姊妹项目 `/Users/zhaoyi/novvy/contextual-ad-agent` 走的是完全解耦路线——每个 Agent（StoryboardAgent/DirectorAgent/VideoGenAgent/PlayableAgent/SupervisorAgent…）都是无状态一次性调用（`codex exec` 或 Vercel AI SDK），状态显式存在 `ab_episode`/`ab_ad`/`ab_creativePlan` 等独立表的结构化列里，天然没有"线程丢失"这个故障模式；代价记录在它自己的 `CLAUDE.md`（M10 待办）：评审逻辑在四个 Agent 里重复了四份，prompt 里的"指令"和"数据"没分离干净。

暂缓原因：改动面较大（需要同时改后端状态存储、Codex 调用方式和前端渲染/去重逻辑），且当前单线程设计在工作台数量不多、流程较短时问题不算致命，值得先记录方案，等出现更多类似"陈旧候选卡还活着"或"线程丢失"的真实故障再优先排期。

后续实施事项：

- [ ] 给 `resumeThread` 失败增加最小兜底：退化成 `startThread()` 并用当前 `workspace_json`/`confirmedCards`/历史消息重建上下文，而不是直接把 session 判死（可以先单独做这一条，不依赖下面的大改）。
- [ ] 非首轮 `sourceContext()` 也统一改用 `dramaAnalysisView()`/`initialDramaContext()` 的精简投影，而不是每轮重贴完整 `drama.analysis_json`。
- [ ] 把 `workspace_json` 里需要被下游阶段查询或改状态的部分（落版方向候选、视听方向、分镜候选、视频提示词）拆成独立表，每条记录带 `status`（candidate/confirmed/superseded）和 `version` 列，用 `UPDATE` 推进状态，而不是靠追加新聊天消息 + 扫描历史推导最新版本。
- [ ] `creative_messages` 收窄为纯聊天记录展示用途，不再兼职"卡片状态的事实来源"；`creativeAssets()`、`richestFinalCard()`、`latestMutableCardMessageIds` 等扫描式推导逻辑改为直接查询新表。
- [ ] 评估把 `runCreativeTurn` 按阶段拆成独立的一次性 Codex 调用（不再共用一条 thread），每阶段可以独立选模型/供应商，且互不阻塞排队。
- [ ] 参考 `contextual-ad-agent` 的 `evaluationAgent` 设计取舍（通用 `dimensions:{name,score}[]`，评分维度交给 skill markdown 而不是硬编码 schema），评估创意质量检查是否也要抽象成类似的可复用评审。
- [ ] 补充状态机迁移测试：确保旧工作台（仍然是聊天记录驱动）在迁移期间行为不受影响。

验收标准：单个 Codex 会话丢失不再导致整个工作台永久失败；同一张卡片的状态在任意时刻只有一个权威记录，不再需要扫描历史猜"最新版本"；非首轮请求的输入体积不再随轮次线性重复贴大 JSON；改动过程中旧工作台数据可以正常读取和继续使用。

## GCP 上云与媒体存储

目标：将当前本地文件与 SQLite 架构迁移到适合云端部署的 GCP 架构，同时保留本地开发模式。

### 推荐架构

- Cloud Run：网页和业务 API。
- Cloud Run Jobs：短剧、游戏等耗时分析任务。
- Cloud SQL for PostgreSQL：分析记录、工作台、消息、任务状态和媒体元数据。
- Google Cloud Storage（GCS）：原始视频、抽帧截图、人物截图、游戏素材、落版图、参考面板和生成视频。
- 独立、具有持久磁盘的 Codex Worker：保存并恢复创意工作台对应的 Codex Session。
- Secret Manager：保存 API Key 和其他敏感配置。

### GCS 对象规划

```text
gs://contextual-studio-media/
  dramas/{dramaId}/source.mp4
  dramas/{dramaId}/frames/{frameId}.jpg
  dramas/{dramaId}/characters/{character}-{angle}.jpg
  games/{gameId}/screenshots/{assetId}.jpg
  creatives/{workspaceId}/reference-panel.jpg
  creatives/{workspaceId}/final-video.mp4
```

数据库只保存 `bucket`、`object_key`、`mime_type`、`size`、`checksum` 和处理状态，不保存图片 BLOB，也不保存会过期的 Signed URL。读取时由后端临时签发访问地址。

### 实施事项

- [ ] 新增统一的 `StorageProvider` 接口。
- [ ] 保留 `LocalStorageProvider`，供本地开发使用。
- [ ] 实现 `GcsStorageProvider`，通过环境变量切换存储后端。
- [ ] 增加后端上传初始化接口，为浏览器创建 GCS resumable upload session。
- [ ] 前端改为将大视频直接上传到 GCS，不再通过 Node API 中转完整文件。
- [ ] 将原视频、截图和创意素材的本地路径改为 GCS object key。
- [ ] 将 SQLite 中的截图 BLOB 迁移为 GCS 对象，并在数据库中保存对象元数据。
- [ ] 将 SQLite 迁移到 Cloud SQL PostgreSQL，并增加数据库迁移脚本。
- [ ] 将进程内 `fire-and-forget` 分析改为持久化任务，由 Cloud Run Job 执行。
- [ ] 分析 Job 从 GCS 下载视频到临时目录，运行 ffmpeg/ffprobe 和 Codex 分析，再将生成素材上传回 GCS。
- [ ] 为任务增加 queued、running、completed、failed 状态、重试次数和错误信息。
- [ ] 为 GCS 配置私有访问、最小权限 IAM、生产域名 CORS 和文件生命周期规则。
- [ ] 为上传、读取和任务接口增加用户认证及资源归属校验。
- [ ] 把密钥和敏感配置迁移到 Secret Manager。
- [ ] 增加开发、测试、生产环境的 bucket、数据库和服务账号隔离。
- [ ] 增加上传失败、Job 重试、重复执行和大文件分析的集成测试。

### Codex Session 持久化

GCS 只用于媒体和产物存储，不直接用作 `CODEX_HOME`。当前创意工作台依赖 `~/.codex/sessions` 和 `codex_thread_id` 恢复同一个 Codex thread，而 Cloud Run 本地文件系统不保证持久化。

- [ ] 初期使用 Compute Engine + Persistent Disk 部署专用 Codex Worker。
- [ ] 根据 `creative_session_id` 将同一工作台请求路由到保存其 Session 的 Worker。
- [ ] 在 PostgreSQL 中继续保存完整对话、已确认卡片和结构化工作台状态，作为可恢复的业务事实来源。
- [ ] 设计 Worker 故障后的 Session 恢复方案；不要依赖把正在使用的 Session 目录直接挂载到 GCS。
- [ ] 后续评估是否改为每轮从 PostgreSQL 重建上下文，从而降低对本地 Codex Session 文件的依赖。

### 建议实施顺序

1. 抽象 StorageProvider，并保持现有本地功能不变。
2. 接入 GCS 浏览器直传和私有读取。
3. 把截图 BLOB 和本地媒体路径迁移为对象元数据。
4. 将 SQLite 迁移到 Cloud SQL PostgreSQL。
5. 将分析任务迁移到 Cloud Run Jobs。
6. 部署具有持久磁盘的 Codex Worker，迁移创意工作台会话。
7. 补齐认证、权限、监控、重试和备份策略。
