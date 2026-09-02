# Contextual Studio

Contextual Studio 是一个面向短剧与 App 广告创意制作的本地 Web 工作台。用户从 Novvy AI Analysis API 选择已经完成的短剧与 App 解析，将两类结果组合为广告创意，并在同一个工作台中完成人物参考图、落版图、剧情分镜、逐镜视频和最终成片的制作与复审。

项目当前以本地运行为主：页面、Node.js 服务、SQLite 数据库和 Codex SDK 工作流运行在同一台机器上；图片与视频生成可连接 Novvy MCP 或 ImaRouter 等云端服务。

## 主要功能

### 短剧解析库

- 调用 `GET /api/drama-analysis/dramas` 读取远端已经完成整剧解析的短剧目录。
- 选择短剧后调用详情接口，展示整剧剧情、主要人物、逐集剧情梗概、逐集人物情绪和分集拼图；每个远端分集会独立映射到 `episodeAnalyses[]`，供后续创意流程读取。
- 创建工作台时把远端原始结果与兼容 `novvy.video-analysis.v3` 投影一并保存到 SQLite；缺失的对白、时间码、情绪曲线和人物角度保持未知，不再次调用模型补写。
- 一小时有效的签名图片通过本地稳定媒体地址按需刷新，旧工作台无需保存易过期的 URL。

### App 解析库

- 调用 `GET /api/product-analysis/products` 读取已完成玩法解析的 App，并支持按 iOS/Android 和英文品类过滤。
- 选择 App 后展示玩法、卖点、目标受众、商店截图和创意拼图。
- 创建工作台时保存远端原始 `aiGameplay`，同时生成现有创意流程可消费的 `novvy.product-analysis.v1` 兼容投影；不再提交商店 URL 或运行本地商品分析模型。

### 创意工作台

- 用户先选择一条远端已解析短剧和一个远端已解析 App，再进入独立工作台页面。
- 左侧是蛇形节点画布，保存每次确认的创意成果；节点之间用虚线表达创作顺序。
- 右侧是持续的创意助手对话，同一工作台沿用同一个 Codex session。
- 底部输入框支持文字同时附带图片或视频：图片直接作为多模态视觉输入，视频在本地均匀抽取关键帧后进入同一会话。
- 候选创意、人物图、落版图、分镜图和视频均以卡片呈现，可单独修改和重新生成。
- 已确认成果不会覆盖历史版本，旧版本可以随时展开回看。

### 图片与资产

- 支持生成和修改落版图、人物参考图、道具图、其他参考图及逐镜分镜图。
- 图片重新生成时，预览区域只显示“生成中”，不会用旧图片冒充新结果。
- 工作台底部提供资产区域，所有生成图片获得稳定的“图片 01、图片 02……”编号。
- 视频关键帧位于独立截图区，可通过“截图 01、截图 02……”引用。
- 每张资产可以填写意见后重新生成，也可以从当前工作台删除。
- “生成图片”列表末尾永远保留一张“添加图片”空白卡，可通过文字描述或引用现有图片生成新资产。
- 从左侧空白卡生成图片不会向右侧聊天框插入消息，适合连续制作大量资产。
- 右侧聊天区支持直接拖入本地 JPG、PNG、WebP 或视频文件；松开后先进入附件预览，可与文字一起发送，每条消息最多 6 个附件。文件选择按钮继续作为备用入口。

#### 图片位置标注使用方法

人物图、分镜图、落版图、参考图和资产图片可以点击“标注图片位置”，然后按修改意图选择工具：

- **点选**：用于指出一个较小或边界明确的对象，例如按钮、耳环、文字、眼睛或某一道菜。选择“点选”后，在目标位置按一下，然后在对应“区域”输入框中填写要求，例如“删除这里的文字”或“把这颗宝石改成浅蓝色”。
- **框选**：用于修改一个有面积的局部区域，例如人物、服装、天空、墙面或一组道具。选择“框选”后，从区域一角按住并拖到另一角，再填写“保持人物不变，只把这个背景换成夜景”等要求。只想局部重绘时优先使用框选。
- **箭头**：用于表达移动、朝向或两处位置之间的关系，例如把人物移到另一侧、让人物看向某个物体，或者把道具移动到桌面中央。选择“箭头”后，从对象当前位置按住拖向目标位置；圆点代表起点，箭头尖端代表终点。对应要求可以写“把花瓶从圆点位置移动到箭头指向的位置”。

一张图片可以连续建立多个标注。每个标注都会获得独立的“区域 1、区域 2……”修改输入框，应分别写清该区域的要求。点击“使用这些标注”后，系统会把区域编号、归一化位置和对应意见写入原修改框，再点击“按意见重新生成”。“撤销”删除最近一次标注，“清空”删除当前图片上的全部标注。

选择原则：只是在说“这个东西”时用点选；需要说“这一整块怎么改”时用框选；需要表达“从哪里到哪里”或“朝哪个方向”时用箭头。未被标注、也未在文字中点名的画面内容默认要求保持不变。

### 视频制作

- 先生成并审核静态分镜，再逐镜生成视频。
- 每个视频镜头同时使用对应分镜图和已确认人物参考图。
- 最终视频可选择 Novvy MCP 或 ImaRouter。
- ImaRouter 任务 ID 会保存到数据库；服务重启后可继续查询原任务，不重复创建已提交的镜头。
- 多个镜头完成后可以逐镜播放复审，再按顺序拼接并追加已确认落版图。

## 项目结构

```text
contextual-studio/
├── .agents/skills/                  项目本地 Codex Skills
│   ├── analyze-short-drama/
│   ├── analyze-game-store-page/
│   └── novvy-ad-creative/
├── data/
│   ├── contextual-studio.sqlite     SQLite 数据库
│   ├── uploads/                     上传的短剧原视频
│   ├── chat-uploads/                对话图片、视频及视频关键帧
│   ├── local-telemetry.sqlite       本地 telemetry 接收数据库
│   ├── mlflow/                      本地 MLflow 数据与 artifacts
│   └── generated/landing-pages/     一键打包生成的 HTML5 落地页及 ZIP
├── config/
│   └── production-profile.json      本地视频生产预算与流程参数
├── public/
│   ├── index.html                   主页面
│   ├── app.js                       短剧、游戏及入口逻辑
│   ├── workbench.html               独立创意工作台
│   ├── workbench.js                 画布、聊天和资产交互
│   ├── telemetry-dashboard.html     本地 telemetry 监控网页
│   ├── telemetry-dashboard.js       telemetry 列表、时间线和筛选交互
│   └── styles.css                   页面样式
├── server/
│   ├── index.js                     HTTP 服务与 API 路由
│   ├── ai-analysis-api.js           远端解析查询、契约适配与签名图片刷新
│   ├── database.js                  SQLite 表结构与序列化
│   ├── analyzer.js                  历史本地短剧分析实现（当前首页流程不再调用）
│   ├── game-analyzer.js             历史本地 App 分析实现（当前首页流程不再调用）
│   ├── creative-agent.js            Codex 创意会话
│   ├── creative-telemetry.js        创意事件记录、outbox 与补发
│   ├── local-telemetry-server.js    本地采集 API 与监控页服务
│   ├── mlflow-tracing.js            模型和工具端到端 tracing
│   ├── chat-media.js                对话附件与视频关键帧预处理
│   ├── image-generator.js           落版图生成
│   ├── character-generator.js       人物图生成与修改
│   ├── asset-generator.js           资产区图片生成与修改
│   ├── storyboard-generator.js      分镜图生成
│   ├── video-generator.js           Novvy MCP 视频生成
│   ├── imarouter-video-generator.js ImaRouter 视频生成
│   ├── video-finalizer.js           视频拼接与最终成片
│   ├── video-quality-review.js       最终成片技术 QC、哈希与联络表
│   └── landing-page-packager.js     成片压缩与 HTML5 落地页一键打包
├── .env.example                     环境变量示例
├── AGENTS.md                        项目本地 Skill 规则
├── CHANGELOG.md                     中文修改历史
├── TODO.md                          后续开发及云端部署事项
├── package.json
├── install_environment.sh           全新 macOS 一键环境安装脚本
├── start_local_telemetry.sh         本地 telemetry 服务启动脚本
├── start_mlflow.sh                  本地 MLflow 服务启动脚本
└── start_server.sh                  本地启动脚本
```

## 运行要求

- macOS 或兼容的类 Unix 环境
- Node.js 24 或更高版本
- npm
- `ffmpeg` 和 `ffprobe`
- `zip`（用于生成可下载的 HTML5 落地页包）
- 已安装并登录的 Codex CLI / Codex SDK 运行环境
- 使用 ImaRouter 上传本地截图时，需要安装并登录 Google Cloud CLI（`gcloud`）

检查版本：

```bash
node --version
npm --version
ffmpeg -version
ffprobe -version
zip -v
```

## 配置环境变量

首次运行时复制示例配置：

```bash
cp .env.example .env
```

| 变量 | 用途 |
| --- | --- |
| `PORT` | 本地服务端口，默认 `4180` |
| `CODEX_ANALYSIS_MODEL` | 可选；留空时使用本机 Codex 默认模型 |
| `AI_ANALYSIS_API_BASE_URL` | AI Analysis API 地址，默认 `https://developer.novvy.ai` |
| `AI_ANALYSIS_API_KEY` | `adm_user.apikey`，后端以 Bearer 方式发送；未设置时兼容使用 `NOVVY_MCP_AUTHORIZATION` |
| `AI_ANALYSIS_API_TIMEOUT_MS` | 查询超时，默认 30 秒 |
| `AI_ANALYSIS_API_CACHE_TTL_MS` | 详情与签名图片解析缓存，默认 5 分钟 |
| `NOVVY_MCP_URL` | Novvy MCP 地址 |
| `NOVVY_MCP_AUTHORIZATION` | Novvy MCP 鉴权；本地也可读取已安装插件配置 |
| `IMAROUTER_API_KEY` | ImaRouter API 密钥 |
| `IMAROUTER_BASE_URL` | ImaRouter API 地址 |
| `IMAROUTER_GCS_BUCKET` | 本地参考图上传使用的 GCS Bucket |

不要把真实密钥提交到 Git。云端部署时应通过 GCP Secret Manager 注入。

仅执行 `cp .env.example .env` 不会自动获得 Novvy MCP 权限。其他开发者如果没有安装包含有效 `.mcp.json` 的 Novvy 插件，必须在自己的 `.env` 中填写有效的 `NOVVY_MCP_AUTHORIZATION`，否则落版图、人物图和分镜图生成会持续失败。

## 启动项目

### 可选：创意过程 Telemetry

Telemetry 用于记录一条创意从短剧与游戏输入、方案生成、用户修改，到图片、分镜和最终视频确认的完整生产过程。记录由服务端根据真实数据库状态确定性产生，不依赖 Codex 对话主动上报，也不会因为采集服务不可用而阻断创作。

#### 工作方式

```text
Contextual Studio 业务操作
        ↓
creative-telemetry.js 确定性生成事件
        ↓
主数据库 creative_telemetry_outbox（先本地落库）
        ↓ 后台异步发送、幂等去重、失败指数退避
本地采集服务或未来公司远端服务
        ↓
local-telemetry.sqlite / 公司数据平台
```

发送端和接收端是两层独立存储：

- `data/contextual-studio.sqlite` 中的 `creative_telemetry_runs` 保存工作台与采集任务的映射，`creative_telemetry_outbox` 保存 `pending`、`sent`、`failed` 事件和重试状态。
- `data/local-telemetry.sqlite` 是开发环境的本地接收库，保存已经接收到的任务、阶段、资产、反馈和 Skill 版本。
- 公司远端尚未配置或暂时不可用时，事件继续留在 outbox，不影响工作台，也不会被静默丢弃。

#### 采集内容

| 事件 | 内容 |
| --- | --- |
| `run_start` | 工作台、短剧/游戏标识、紧凑 Brief、产品名称和 Skill 版本 |
| `stage` | `product_analysis`、`video_analysis`、`recommendation`、`creative_plan`、`final_card`、`reference_panel`、`video_generation`、`video_review` 等阶段结果与状态 |
| `asset` | 有安全公开 URL 的落版图、参考图、分镜图和生成视频，以及版本和父资产关系 |
| `feedback` | 用户对候选或版本的反馈原话，以及 `approved`、`rework`、`rejected`、`unclassified` 决策 |
| `run_complete` | 用户确认最终成片后的 `completed`，或明确取消/不可恢复失败状态 |

Telemetry 不采集 API key、Authorization、Cookie、签名查询参数、base64、完整上传响应、完整聊天、聊天附件内容、模型逐步推理或本机绝对路径。监控接口还会再次隐藏认证字段、绝对路径和 URL 查询参数。

#### 本地运行与监控网页

公司远端采集服务尚未部署时，在 `.env` 配置本地接收端：

```bash
NOVVY_TELEMETRY_URL=http://127.0.0.1:4191
NOVVY_TELEMETRY_TOKEN=contextual-local-dev
NOVVY_TELEMETRY_USER_ID=你的团队用户名
NOVVY_SKILL_VERSION=contextual-studio-v1

LOCAL_TELEMETRY_PORT=4191
LOCAL_TELEMETRY_TOKEN=contextual-local-dev
```

分别使用两个终端启动采集端和工作台。必须在启动工作台前写好 `.env`；修改配置后需要重启工作台服务。

```bash
# 终端 1：本地 telemetry 接收端和监控页
./start_local_telemetry.sh
# 或 npm run telemetry:local

# 终端 2：Contextual Studio
./start_server.sh
```

浏览器打开 <http://127.0.0.1:4191/dashboard>，可以查看：

- 任务、阶段、资产和反馈总数；
- 按产品名、任务编号或用户搜索任务；
- 单个任务的阶段时间线和每阶段结构化结果；
- 已记录的公开资产、版本与关联阶段；
- 用户采用、修改、拒绝和普通讨论反馈；
- 手动刷新或每 10 秒自动刷新。

本地接收端和监控页只监听 `127.0.0.1`，仅供本机开发使用，不要直接暴露到公网。Dashboard 的只读数据无需在浏览器填写 Token；写入 API 仍要求 `X-API-Key`。

#### 状态、重试和旧任务回补

工作台运行后可以检查发送队列：

```bash
curl http://127.0.0.1:4180/api/telemetry/status
```

返回结果中的 `configured` 表示工作台启动时是否成功读取采集地址和 Token；`counts.pending`、`counts.sent`、`counts.failed` 分别表示等待发送、已经发送和发送失败的事件数。

修复网络、Token 或服务地址后，可以把失败事件重新放回发送队列：

```bash
curl -X POST http://127.0.0.1:4180/api/telemetry/retry
```

旧工作台可以从现有数据库中的消息、卡片、公开资产和确认状态生成回补事件。`<工作台ID>` 是 `workbench.html#14` 中的数字部分：

```bash
curl -X POST http://127.0.0.1:4180/api/telemetry/backfill/14
```

回补和正常事件均使用稳定 `idempotency_key`，重复调用不会重复写入同一事件。也可以直接查看本地接收数量：

```bash
curl -H "X-API-Key: contextual-local-dev" \
  http://127.0.0.1:4191/v1/local/status
```

#### 切换公司远端采集服务

远端服务实现同一组 Skill 版本解析、run、stage、asset、feedback 和状态接口后，只需修改 `.env` 并重启 Contextual Studio；业务代码和本地 outbox 不需要改变：

```bash
NOVVY_TELEMETRY_URL=https://telemetry.company.example
NOVVY_TELEMETRY_TOKEN=由团队管理员提供
NOVVY_TELEMETRY_USER_ID=employee-123
NOVVY_SKILL_VERSION=contextual-studio-v1
```

正式部署时应通过 GCP Secret Manager 等密钥系统注入 Token，不要把真实凭据写入 Git。远端恢复后可调用重试接口补发本地积压事件。

### 可选：MLflow GenAI tracing

项目 Python 环境安装 MLflow Server/UI 3.15.2，Node 依赖包含官方 `@mlflow/core` tracing SDK。启动本地 MLflow：

```bash
./start_mlflow.sh
# 或 npm run mlflow:server
```

UI 默认位于 <http://127.0.0.1:5050>（避免与 macOS Control Center 常用的 5000 端口冲突），数据写入 `data/mlflow/`。`.env.example` 提供 `MLFLOW_TRACKING_URI`、`MLFLOW_PORT` 和 `MLFLOW_EXPERIMENT_ID`。配置后，Codex SDK 的编译后 Prompt/最终输出、Novvy MCP 工具输入输出和 ImaRouter 请求结果会写入 MLflow；`GET /api/mlflow/status` 可确认当前服务是否启用。发送前会移除认证字段、签名查询参数、base64、二进制和本机绝对路径。

### 全新电脑一键安装（推荐）

如果电脑没有安装 Node.js、Python、FFmpeg 或其他开发工具，在项目目录中运行：

```bash
chmod +x install_environment.sh start_server.sh
./install_environment.sh
```

脚本会自动完成：

- 安装 Apple 命令行工具和 Homebrew。
- 安装 Codex CLI，并登录 Codex。
- 从 `NovvyAI/skills` 下载或更新 `novvy-ad-creative` 插件并执行安装；若在交互式终端运行且尚未配置，会用隐藏输入询问本机 `admin_user.apikey`，同步到插件运行缓存的 MCP Authorization。直接回车可跳过，之后运行 `$novvy-env-check` 补配。
- 安装 Node.js 24、npm、Python 3.12、FFmpeg/FFprobe。
- 安装 OpenCV，并下载 Apache 2.0 的 YuNet 人脸模型；短剧人物检测、角度判断和候选截图筛选均在本机完成，不会把全量视频帧发送给第三方人脸服务。
- 安装 Google Cloud CLI，供 ImaRouter 上传本地参考图。
- 执行 `npm install`。
- 在不存在时从 `.env.example` 创建 `.env`，但不会写入或覆盖团队密钥。
- 检查项目代码，并打开浏览器引导完成 `codex login`。

Apple 命令行工具第一次安装时，macOS 会弹出系统窗口。安装完成后，需要再次运行 `./install_environment.sh`。输入电脑密码时终端不显示字符属于正常现象。

如果暂时不使用 ImaRouter，可执行：

```bash
./install_environment.sh --without-gcloud
```

如果只想安装软件、稍后再登录，可执行：

```bash
./install_environment.sh --skip-login
```

安装完成后启动：

```bash
./start_server.sh
```

> 一键脚本只负责安装本地软件，不能自动获得团队的 Novvy MCP 或 ImaRouter 密钥。管理员仍需把有效凭据配置到本机 `.env`。

### 手动安装

首次 Clone 后，先安装依赖并登录 Codex：

```bash
git clone https://github.com/NovvyAI/contextual-studio.git
cd contextual-studio
npm install
npx codex login
cp .env.example .env
```

`@openai/codex-sdk` 会通过 npm 安装项目所需的 Codex CLI，因此不需要另外全局安装 Codex。`npx codex login` 仍然是必需的：创意助手对话、创意方案、剧情台词、文字分镜和视频提示词会使用该登录状态；短剧和 App 解析改由 AI Analysis API 提供，不使用本机 Codex 登录。

推荐使用启动脚本：

```bash
./start_server.sh
```

启动后访问 <http://127.0.0.1:4180>。

其他模式：

```bash
# 开发模式，文件变化后自动重启
./start_server.sh --dev

# 只执行语法检查，不启动服务
./start_server.sh --check
```

也可以直接运行：

```bash
npm start
npm run dev
npm run check
```

按 `Ctrl+C` 停止服务。

## 数据存储

- SQLite 数据库：`data/contextual-studio.sqlite`
- 上传原视频：`data/uploads/`
- 对话上传的图片、视频及临时关键帧：`data/chat-uploads/`
- 短剧截图：SQLite 的 `drama_screenshots` 表，以 BLOB 保存
- 短剧分析：`drama_analyses.analysis_json`
- 游戏分析：`game_analyses.analysis_json`
- 工作台状态：`creative_sessions.workspace_json`
- 对话与资产卡：`creative_messages`
- 逐镜视频任务：`creative_video_shots`
- 落地页打包记录：`creative_landing_packages`
- 最终成片：`data/generated/videos/`
- HTML5 落地页目录和 ZIP：`data/generated/landing-pages/`

生成后的远程图片和视频保存在对应服务商提供的对象存储中，数据库保存其 URL 和任务 ID。后续上 GCP 时，原视频、截图、图片与成片计划统一迁移到 GCS。

最终成片确认后，成片卡片会显示“一键打包落地页”。系统将成片压缩为不超过 5 MB 的 H.264 MP4，连同自包含的 `index.html`、`analytics.js`、游戏图标和商店 CTA 打成 ZIP；CTA 在视频播放 3 秒后出现。游戏图标无法下载时会使用游戏名称首字母，不阻止打包。

## 项目本地 Skills

实际参与运行流程的 Skills 必须存放在 `.agents/skills/` 并随项目版本管理：

- `.agents/skills/analyze-short-drama`
- `.agents/skills/analyze-game-store-page`
- `.agents/skills/novvy-ad-creative`
- `.agents/skills/audiovisual-language-design`
- `.agents/skills/creative-quality-review`
- `.agents/skills/storyboard-production-contract`

其中，视听语言 Skill 负责把创意转译为可执行镜头参数，质量审核 Skill 与 `novvy-ad-creative` 的只读视听质量库提供 129 条规则和 60 个唯一导演样本，运行时只查询必要记录并转成可观察参数；分镜生产 Skill 负责最多三镜的文字分镜、静态分镜图和逐镜视频任务合同。内容镜头默认使用 0.35 秒音画交叉淡化，再确定性追加已确认落版图。外部资料中的 `single_final_video_pass` 在本项目中仅为用户明确选择时的严格模式；默认仍使用静态分镜图审核、逐镜生成/修改、Novvy MCP 或 ImaRouter、审核后拼接的现有流程。

项目还选择性吸收了 Contextual Ad Skill Suite 的剧集理解、情绪连续性、参考用途、视听语言、视觉导演、对白表演、制作全案和视觉交接 Schema。分镜使用“输入→实体动作→实体结果→UI反馈→人物反应→更大钩子”的因果链，并在进入视频前检查人物、空间、物件、摄影、表演、玩法、UI/VFX 和文字图层。没有吸收 Suite 的强制单次视频、强制全素材落本地或 Novvy 只能生成落版图规则。

个人目录、插件缓存和其他项目里的同名 Skill 仅作为参考。外部 Skill 更新时，应先比较差异，再选择性合并到项目本地版本，不能覆盖项目定制逻辑。

## 本地生产 Profile

视频生产策略由 `config/production-profile.json` 统一控制。当前默认不是外部 Suite 的 `single_final_video_pass`，而是符合现有工作台的 `reviewed_storyboard_multishot`：最多三个镜头、每镜 4–15 秒、默认 8 秒，静态分镜统一审核后逐镜生成和复审，允许用户明确操作后重新生成，支持 Novvy 与 ImaRouter，最后只输出一支拼接成片并确定性追加 3 秒落版图。

`max_ai_video_submissions` 当前为 `null`，表示不设置跨工作台的固定总次数；每一次新提交仍必须来自用户点击确认或重新生成。`auto_retry_allowed` 为 `false`，后台不能在失败后擅自创建收费任务；`user_authorized_retry_allowed` 为 `true`，用户可以主动修改并重做某个镜头。修改该文件后需要重启服务，服务启动时会校验配置。

多个镜头合成为最终成片后，后端会自动做一次技术 QC：完整解码、720×1280、时长、编码、像素格式、音轨和 SHA-256，并在 `data/generated/video-qc/` 保存 JSON 报告与 1fps 联络表。技术 QC 通过后才显示可确认的最终成片；人物、连续性、表演、产品真实性、文字和声音时序仍需用户人工复审。

## 常见问题

### 页面一直显示“生成中”

图片和视频由云端异步生成。一般图片需要1至3分钟，视频单镜通常需要2至5分钟。人物图片、资产图片和 ImaRouter 视频任务支持服务重启恢复。超过正常时间时，应同时检查数据库任务状态和云端任务状态，不能只依赖页面文案。

### ImaRouter 提示 Google 登录失效

本地截图需要通过 GCS 转成公网素材地址。重新执行：

```bash
gcloud auth login
```

如果登录了多个账号，再选择正确账号：

```bash
gcloud config set account YOUR_ACCOUNT
```

### 端口被占用

修改 `.env` 中的端口，例如：

```dotenv
PORT=4181
```

### Codex 分析失败

确认 Node.js 版本满足要求，然后重新登录 Codex 并运行检查：

```bash
npx codex login
./start_server.sh --check
```

### 落版图反复生成失败

先查看失败卡片中的具体错误。如果出现 `Novvy MCP HTTP 401/403` 或“缺少 `NOVVY_MCP_AUTHORIZATION`”，说明这台电脑没有可用的 Novvy MCP 鉴权。请在本机 `.env` 填写团队提供的有效凭据后重启服务；`cp .env.example .env` 只会复制空模板，不会自动配置权限。

## 当前注意事项

- 本项目仍处于本地产品原型阶段，暂未包含正式的用户账号、权限、多租户和云端数据库。
- 不要在图片或视频生成期间随意强制终止服务；虽然部分任务可以恢复，但仍会增加等待时间。
- 删除资产只会从当前工作台资产区隐藏，不会删除历史消息或远程对象存储中的原文件。
- 短剧、游戏和创意推理统一通过 Codex SDK；图片和视频生成通过 Novvy MCP 或用户选择的 ImaRouter 执行。
