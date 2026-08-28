# Contextual Studio TODO

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
