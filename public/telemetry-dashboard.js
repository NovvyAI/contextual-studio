const $ = (selector) => document.querySelector(selector);
const el = (tag, className = "", text = "") => { const node = document.createElement(tag); if (className) node.className = className; if (text !== "") node.textContent = text; return node; };
const stageNames = { product_analysis:"游戏分析",video_analysis:"短剧分析",recommendation:"创意推荐",creative_plan:"创意与分镜",final_card:"落版图",reference_panel:"参考图",video_generation:"视频生成",video_review:"视频审核" };
const decisionNames = { approved:"采用",rework:"修改",rejected:"拒绝",unclassified:"讨论" };
let state = { runs:[], totals:{}, generatedAt:"" }, selectedId = null, activeTab = "stages", timer;

function date(value){ if(!value)return "—"; return new Date(value).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}); }
function pretty(value){ return JSON.stringify(value ?? {},null,2); }
function badge(text,status=""){ return el("span",`badge ${status}`,text); }

function renderMetrics(){
  const labels = [["runs","任务"],["stages","阶段事件"],["assets","资产"],["feedback","用户反馈"]];
  $("#metrics").replaceChildren(...labels.map(([key,label])=>{const card=el("article","metric");card.append(el("span","",label),el("strong","",String(state.totals[key]||0)));return card;}));
}

function filteredRuns(){ const query=$("#search").value.trim().toLowerCase(); return state.runs.filter((run)=>!query||[run.productName,run.briefRaw,run.createdBy,run.id,`#${run.id}`].some((v)=>String(v||"").toLowerCase().includes(query))); }
function renderRuns(){
  const nodes=filteredRuns().map((run)=>{const card=el("button",`run-card ${run.id===selectedId?"active":""}`);card.type="button";const title=el("div","run-title");title.append(el("strong","",run.productName||`任务 #${run.id}`),badge(run.status,run.status));card.append(title,el("p","",run.briefRaw||"Contextual Studio 创意任务"));const meta=el("div","run-meta");meta.append(el("span","",`#${run.id}`),el("span","",`${run.counts.stages} 阶段`),el("span","",`${run.counts.assets} 资产`),el("span","",date(run.updatedAt)));card.append(meta);card.addEventListener("click",()=>{selectedId=run.id;renderRuns();renderDetail();});return card;});
  $("#run-list").replaceChildren(...(nodes.length?nodes:[el("div","section-empty","没有匹配的任务")]));
}

function stagePanel(run){ const wrap=el("div","timeline"); if(!run.stages.length)return el("div","section-empty","尚无阶段记录"); run.stages.forEach((item)=>{const event=el("article","event");const head=el("div","event-head");const title=el("div");title.append(el("h3","",stageNames[item.stage]||item.stage),el("small","",`V${item.version} · ${item.status}`));head.append(title,el("time","",date(item.createdAt)));event.append(head);const pre=el("pre","json",pretty(item.payload));event.append(pre);wrap.append(event);});return wrap; }
function assetPanel(run){ const grid=el("div","asset-grid"); if(!run.assets.length)return el("div","section-empty","尚无公开资产记录"); run.assets.forEach((item)=>{const card=el("article","asset");const head=el("div","event-head");head.append(el("h3","",item.assetType),badge(`V${item.version}`));card.append(head);if(item.storageUri){const link=el("a","",item.storageUri);link.href=item.storageUri;link.target="_blank";link.rel="noreferrer";card.append(link);}card.append(el("small","",`${item.stageOutputId||"未关联阶段"} · ${date(item.createdAt)}`));if(Object.keys(item.metadata||{}).length)card.append(el("pre","json",pretty(item.metadata)));grid.append(card);});return grid; }
function feedbackPanel(run){ const list=el("div","tab-panel"); if(!run.feedback.length)return el("div","section-empty","尚无用户反馈记录"); run.feedback.forEach((item)=>{const card=el("article","feedback");const head=el("div","event-head");head.append(badge(decisionNames[item.decision]||item.decision,item.decision),el("time","",date(item.createdAt)));card.append(head);const quote=el("blockquote","",item.feedback);card.append(quote);if(item.stageOutputId||item.creativeVersion)card.append(el("small","",[item.stageOutputId,item.creativeVersion].filter(Boolean).join(" · ")));list.append(card);});return list; }

function renderDetail(){
  const run=state.runs.find((item)=>item.id===selectedId);if(!run){$("#run-detail").innerHTML='<div class="empty"><strong>选择一个任务</strong><p>查看它的阶段时间线、生成资产和用户反馈。</p></div>';return;}
  const root=$("#run-detail");root.replaceChildren();const header=el("header","detail-header");const copy=el("div");copy.append(el("span","eyebrow",`${run.skillName} · ${run.skillVersion}`),el("h2","",run.productName||`任务 #${run.id}`),el("p","",run.briefRaw||"Contextual Studio 创意任务"));const meta=el("div","detail-meta");meta.append(badge(run.status,run.status),el("div","",`用户：${run.createdBy}`),el("div","",`创建：${date(run.createdAt)}`),el("div","",`更新：${date(run.updatedAt)}`));header.append(copy,meta);root.append(header);
  const tabs=el("nav","tabs");[["stages",`阶段 ${run.counts.stages}`],["assets",`资产 ${run.counts.assets}`],["feedback",`反馈 ${run.counts.feedback}`]].forEach(([key,label])=>{const button=el("button",`tab ${activeTab===key?"active":""}`,label);button.addEventListener("click",()=>{activeTab=key;renderDetail();});tabs.append(button);});root.append(tabs,activeTab==="stages"?stagePanel(run):activeTab==="assets"?assetPanel(run):feedbackPanel(run));
}

async function load(){
  try{const response=await fetch("/v1/local/dashboard-data",{cache:"no-store"});if(!response.ok)throw new Error(`HTTP ${response.status}`);state=await response.json();if(selectedId&&!state.runs.some((run)=>run.id===selectedId))selectedId=null;if(!selectedId&&state.runs.length)selectedId=state.runs[0].id;$("#connection").textContent=`已连接 · ${date(state.generatedAt)}`;$("#connection").classList.remove("error");renderMetrics();renderRuns();renderDetail();}
  catch(error){$("#connection").textContent=`连接失败 · ${error.message}`;$("#connection").classList.add("error");}
}
function schedule(){clearInterval(timer);if($("#auto-refresh").checked)timer=setInterval(load,10000);}
$("#refresh").addEventListener("click",load);$("#auto-refresh").addEventListener("change",schedule);$("#search").addEventListener("input",renderRuns);load();schedule();
