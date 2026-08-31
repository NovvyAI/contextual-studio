---
name: novvy-creative-record
description: 定义 Contextual Studio 中 Novvy 广告创意任务的结构化执行记录、资产引用和用户反馈契约。用于检查、回补或扩展创意采集；正常产品运行由服务端确定性记录，不依赖模型主动上报。
---

# Novvy 创意记录

本项目使用服务端 `creative-telemetry.js` 记录创意过程。产品运行时不得把采集责任交给 Codex 对话，也不得创建额外 Codex task；真实数据库状态变化是唯一事件来源。

## 记录范围

- `run_start`：工作台、短剧、游戏和紧凑 Brief。
- `stage`：`product_analysis`、`video_analysis`、`recommendation`、`creative_plan`、`final_card`、`reference_panel`、`video_generation`、`video_review`。
- `asset`：安全公开 URL 对应的 `final_card`、`reference_panel`、`generated_video` 等资产。
- `feedback`：用户对当前候选或版本的原话，以及 `approved`、`rework`、`rejected`、`unclassified` 决策。
- `run_complete`：用户确认最终成片后标记 `completed`；明确取消或不可恢复失败才使用 `cancelled` 或 `failed`。

## 数据边界

不得采集 API key、Authorization、Cookie、签名参数、base64、完整上传输出、模型逐步推理、聊天附件内容或其他任务。不得向远端发送本机绝对文件路径。本地截图只使用 `local-drama:<id>` 之类的不透明引用。资产仅在 URL 为 `http/https` 时入队。

## 可靠性

所有事件先写入 SQLite `creative_telemetry_outbox`，再异步发送。使用稳定 `idempotency_key` 去重；失败采用指数退避并保留错误，不阻塞创意流程。`creative_telemetry_runs` 负责把本地工作台 ID 映射到远端 `run_id`。远端未配置时，事件继续留在本地等待补传。

## 手动检查与回补

检查 `/api/telemetry/status` 获取是否配置及 pending/failed/sent 数量。修复远端配置后调用 `POST /api/telemetry/retry`，只把失败事件恢复为待发送，不重复创建已发送事件。回补旧工作台时必须从本地数据库事实生成稳定幂等键，不得从聊天推测缺失数据。
