import { db, now, insertCardVersion, latestCard, transitionCreativeStage } from "./database.js";
import { recordCreativeFeedback, recordCreativeStage } from "./creative-telemetry.js";
import { directorStyle } from "./director-library.js";

export function approveAudiovisualDirection(sessionId, cardId, directorChoice) {
  const session = db.prepare("SELECT * FROM creative_sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("创意工作台不存在");
  if (session.stage === "working") throw new Error("当前仍有任务正在处理");
  if (session.stage !== "audiovisual_review") throw new Error("当前不在视听方向确认阶段");
  const card = latestCard(sessionId, cardId);
  if (!card || card.kind !== "audiovisual_direction") throw new Error("找不到视听方向卡片");
  const choice = String(directorChoice || "").trim();
  if (!choice) throw new Error("请选择一个导演参考，或选择不使用导演参考");
  const selectedDirector = choice === "不使用导演参考" ? null : directorStyle(choice);
  if (choice !== "不使用导演参考" && !selectedDirector) throw new Error("所选导演不属于本地导演风格库");
  const parameters = selectedDirector?.parameters.join("；") || "不额外套用导演参考；只遵循原剧证据与视听语言 Bible。";

  const timestamp = now();
  const workspace = session.workspace_json ? JSON.parse(session.workspace_json) : {};
  const confirmed = {
    ...card,
    title: "已确认视听方向",
    details: [
      ...(card.details || []).filter((item) => !/^(?:AI推荐导演|导演选项)｜/.test(String(item.label || ""))),
      { label: "导演参考选择", content: choice },
      { label: "采用的可执行参数", content: parameters },
    ],
    status: "confirmed",
    confirmedAt: timestamp,
  };
  workspace.productionPlan = { ...(workspace.productionPlan || {}), videoPromptStatus: "storyboard_pending", audiovisualDirectionStatus: "approved", directorReference: choice };
  db.prepare("INSERT INTO creative_messages (session_id,role,content,created_at) VALUES (?,'user',?,?)").run(sessionId, `确认视听方向；导演参考：${choice}`, timestamp);
  const result = db.prepare("INSERT INTO creative_messages (session_id,role,content,cards_json,created_at) VALUES (?,'assistant',?,?,?)")
    .run(sessionId, `视听方向已确认，导演参考选择为“${choice}”。我现在自动生成剧情与分镜候选。`, JSON.stringify([confirmed]), timestamp);
  insertCardVersion(sessionId, Number(result.lastInsertRowid), confirmed);
  transitionCreativeStage(sessionId, "working", { workspaceJson: JSON.stringify(workspace), timestamp });
  recordCreativeFeedback(sessionId, `确认视听方向；导演参考：${choice}`, { decision: "approved", stageOutputId: card.id, key: `session:${sessionId}:audiovisual-direction:approved:${timestamp}` });
  recordCreativeStage(sessionId, "audiovisual_direction", { cardId: card.id, directorReference: choice, details: confirmed.details }, { status: "confirmed", key: `session:${sessionId}:audiovisual-direction:${timestamp}` });
  const instruction = `已确认视听方向卡 ${card.id}，用户从本地导演库选择“${choice}”。采用的可执行参数为：${parameters}。严格沿用已确认成果中最新的 audiovisual_direction Bible 和上述参数，现在生成 3 个稳定编号 storyboard-A/B/C 的剧情与分镜候选；不得模仿具体作品或复制镜头，进入 storyboard_review，不提交图片或视频生成。`;
  import("./creative-agent.js").then(({ runCreativeTurn }) => runCreativeTurn(sessionId, instruction, false));
}
