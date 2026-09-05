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

## 创意工作台状态存储重设计（已完成状态层，线程解耦仍暂缓）

目标：把创意工作台从"追加式聊天记录，靠扫描历史推导最新版本"改成有明确 `status`/`version` 的结构化表；线程要不要拆成按阶段解耦的无状态调用，留到状态层稳定后再评估。

实现分支：`yizhao_decoupling`。

背景（本轮会话里讨论并验证过的具体问题，详见分支上的实现计划 `docs/`/commit 历史）：

- **状态没有单一权威来源，靠扫描历史猜"最新"**：这是本轮实际修复的三个 bug 的共同根因——"定位到待确认步骤"跳到早已废弃的候选卡；未选中的落版方向候选永远停留在 `candidate` 状态，按钮一直可点击，误点可触发一次真实付费生成；`workspace.confirmedCards` 需要专门的合并逻辑手动把 Codex 可能漏保留的字段拿回来。三个并行 Explore agent 确认了至少 10 处相互独立、写法还不一致的"扫描全部消息、按 id 建 Map、取最新"逻辑分散在 8 个后端模块和前端里。
- **单点故障**（仍未处理）：`resumeThread(session.codex_thread_id)` 找不到本机 Codex 会话时没有任何兜底，`runCreativeTurn` 直接把 session 打成 `error`。
- **上下文重复膨胀**（仍未处理）：`sourceContext()` 只有首轮走精简投影，从第二轮起每轮都把完整 `drama.analysis_json` 原样重新贴一遍（22 号工作台实测约 10.5 万字符）。
- **参考对照**：姊妹项目 `/Users/zhaoyi/novvy/contextual-ad-agent` 走的是完全解耦路线，状态显式存在独立表的结构化列里，天然没有"线程丢失"这个故障模式；代价是评审逻辑在多个 Agent 里重复、prompt 里"指令"和"数据"没分离干净（它自己的 `CLAUDE.md` M10 待办）。

已完成（`yizhao_decoupling` 分支）：

- [x] 新增 `creative_cards` 表（`server/database.js`）：`card_id`/`kind`/`version`/`status`/`preview_url`/`payload_json`/`message_id`，`UNIQUE(session_id,card_id,version)`；新增 `latestCard`/`cardVersion`/`cardHistory`/`latestCardsByKind`/`latestConfirmedCard`/`liveCardsForSession`/`insertCardVersion`/`updateCardStatus`/`supersedeCards` 查询/写入函数，替换掉 `image-generator.js`、`character-generator.js`、`storyboard-generator.js`、`audiovisual-direction.js`、`video-shot-review.js`、`video-finalizer.js`、`video-generator.js`、`imarouter-video-generator.js`、`asset-generator.js` 里各自重复实现的扫描逻辑。
- [x] `workspace.confirmedCards` 从 `creativeTurnSchema` 和系统提示词里整体退休；Codex 不再需要自己维护这个数组（对应规则 9/10/11 已删除或改写），confirmedCards 归档改由各个 `approve*` 函数在后端确定性写 `creative_cards`。为了不让 Codex 因此丢失对已确认成果的可见性，新增 `confirmedCardsSummary()` 每轮显式把当前各阶段最新确认结果重新贴进 prompt。
- [x] 一次性 `backfillCreativeCardsFromMessages()` 迁移：重放全部历史 `creative_messages.cards_json` 与每个 session 迁移前的 `workspace.confirmedCards` 快照到新表，服务启动时只跑一次；已用 22 号工作台真实数据验证过重放结果与迁移前完全一致。
- [x] `serializeCreativeSession()` 新增 `cards` 字段（来自 `liveCardsForSession()`）；前端 `legacyConfirmedCards()` 改为优先读这个新字段，`workspace.confirmedCards` 降级为只给尚未跑过新代码的旧 session 兜底。
- [x] 新增 `server/creative-cards.test.js`，覆盖全部新增函数，以及一个专门验证"回放结果等于旧扫描逻辑结果"的用例。

- [x] 给 `resumeThread` 失败增加最小兜底：`server/creative-agent.js` 的 `runCreativeTurn` 现在只在“本来要恢复一个已有 thread”且失败文案像是“会话/线程找不到”（`isMissingThreadError()`，按文案关键字做最佳努力匹配，宁可漏判也不误伤超时/schema 校验等真实错误）时才降级——用 `startThread()` 开一条全新 thread，把 `sourceContext()`、当前 `workspace_json`、`confirmedCardsSummary()` 和最近 12 条聊天记录（`recentMessagesDigest()`）重新贴进去悄悄重建上下文，不告诉用户“线程丢失”。之后的 repair 子调用和最终 `codex_thread_id` 落库都会自动使用降级后的新 thread。新增 `server/creative-agent.test.js` 覆盖 `isMissingThreadError`/`recentMessagesDigest`。
- [x] 给 `creative_sessions.stage` 加了一层最小状态机：原来分散在 10 个后端文件里的 66 处 `UPDATE creative_sessions SET stage=...` 裸 SQL（每处各写各的字面量或计算值，没有任何地方定义"合法阶段有哪些"），现在全部收拢成 `server/database.js` 的 `transitionCreativeStage(sessionId, toStage, { workspaceJson, errorMessage, codexThreadId, timestamp, keepErrorMessage })` 一个入口，配 `CREATIVE_STAGES` 常量（11 个合法阶段，和 `creativeTurnSchema.stage` 的 enum 完全对齐）。范围刻意收得很窄：只校验 `toStage` 是否合法（防手滑打错字符串），**不**校验"从 A 阶段能不能转到 B 阶段"——66 处里有几处（中途报错恢复、`storyboard_image` 等其它任务还在跑时暂不离开 `working`、服务重启恢复）转移关系不够直观，没有充分的现场验证就画死一张图，风险比不校验更大，留给以后调用点收拢完、真实转移关系摸清楚了再加。过程中顺带发现并保留了两处原本就"完全不碰 `error_message` 列"的调用点（`creative-agent.js` 单轮写回、`index.js` 新增用户消息时转 `working`）——用 `keepErrorMessage:true` 显式声明，而不是让新函数的默认行为悄悄改变这两处的原有语义。新增 `server/creative-stage.test.js`。用真实、已经跑到剧情与分镜阶段的 session 73 在浏览器里验证，界面和之前完全一致，控制台无报错。

后续实施事项（未完成）：

- [x] 非首轮 `sourceContext()` 统一改用 `initialDramaContext()`/`initialGameContext()` 的精简投影，不再区分 `compact` 参数。核对过 `dramaAnalysisView()` 丢弃的两块字段（`plotSignals`、`audienceAndMarketSignals`）只在 `server/analyzer.js` 的分析阶段 schema 里出现，创意工作台侧从未按字段名引用；系统提示词第 24 条本来就要求"短剧详细分析的唯一事实源是 `episodeAnalyses[].detailedAnalysis`，不要寻找或要求根级重复副本"，这两块正是被取代的早期粗判副本。用 65 号短剧（5 集，云端同步）实测：完整 `analysis_json` 118014 字符，精简投影 59071 字符，降了约 50%；游戏分析本来就小，降幅可以忽略。
- [ ] `creative_messages.cards_json` 目前仍在双写（作为迁移期间的安全网，`creativeAssets()`/`creativeCharacterReferenceAssets()` 这两个"永久编号目录"型函数仍然依赖它，语义上不是"取最新"而是"每个曾经出现过的不同 URL 永久占一个编号"，没有直接挪到新表）；等确认新表路径稳定运行一段时间后，可以评估要不要把这两个函数也改造成查 `creative_cards` 全部历史版本、彻底停止写 `cards_json`。
- [x]（部分完成）`describeWorkingTask()`/`inferCreativeStage()`/`currentStagePresentation()` 三个函数原来靠反查 `session.messages[].cards` 猜"最新版本"，已改成直接读 `session.cards`（`liveCardsForSession()`，权威、自动排除 superseded）：`describeWorkingTask()` 的"当前正在生成哪张卡"、`inferCreativeStage()` 的按卡片种类判断阶段、`currentStagePresentation()` 的"落版图是否已经真实生成"三处都已切换，行为不变但不再依赖消息历史扫描。
  - 未动：`describeWorkingTask()` 结尾那段按聊天文字关键字猜测的兜底（`textPatterns`）——这段本来就是给"结构化状态还没来得及写回"这个真实的时间窗口用的最后兜底，不是纯粹的历史遗留，暂不确定新表能否覆盖这个窗口，先保留。
  - 未动：`renderMessages()` 里 `latestMutableCardMessageIds`/`characterGroupMessageId`/`storyboardGroupMessageId` 那段扫描——这段特意保留了 superseded/failed 卡片以便在聊天记录里展示"这张候选后来被换掉了"，而 `session.cards` 默认排除 superseded，直接替换会让这些历史卡片从界面消失，语义不等价，需要单独设计（比如显式带 `excludeStatuses:[]` 查一份完整历史）才能安全切换，本轮没有动。
- [ ] 评估把 `runCreativeTurn` 按阶段拆成独立的一次性 Codex 调用（不再共用一条 thread），每阶段可以独立选模型/供应商，且互不阻塞排队——状态层已经理顺，这条的技术前提已经具备，但本轮判断优先级低于状态层本身，特意没有一起做。
- [ ] 参考 `contextual-ad-agent` 的 `evaluationAgent` 设计取舍（通用 `dimensions:{name,score}[]`，评分维度交给 skill markdown 而不是硬编码 schema），评估创意质量检查是否也要抽象成类似的可复用评审。

验收标准：单个 Codex 会话丢失不再导致整个工作台永久失败（已实现，最小兜底：降级新 thread + 重建上下文，未覆盖“新 thread 也失败”之外的场景）；同一张卡片的状态在任意时刻只有一个权威记录，不再需要扫描历史猜"最新版本"（已实现）；非首轮请求的输入体积不再随轮次线性重复贴大 JSON（已实现，65 号短剧实测降约 50%）；改动过程中旧工作台数据可以正常读取和继续使用（已用 22 号工作台验证）。

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
