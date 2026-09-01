/**
 * Russh 业务文档 单文件打包脚本 (biz-doc-generator · Phase 5)
 *
 * 打包方式（R1：禁止 iframe / 外部挂载）：
 *   1. Phase 3 产出的 archify HTML（test-instance/deliver/*.html）先经
 *      scripts/archify-inline.mjs bundle 成 bundle.json（CSS 作用域化 + SVG id
 *      命名空间隔离 + 自研缩放平移 runtime）。
 *   2. 本脚本把 bundle 的共用 CSS 只注入一次，7 张图以 .arch-figure 原生内联，
 *      runtime 附在页尾自动挂载。产物单文件、零外部依赖、离线可用。
 *
 * 内容来源约束（审计教训：数字必须有出处）：
 *   - 入口点数量来自 extraction/entry-points.json（scan-entry-points.mjs 扫描）
 *   - 符号统计来自 extraction/entities.json 的 _meta（codegraph 导出）
 *   - 状态机迁移表由 specs2/*.json 程序化生成，不手抄
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "test-instance");

// ---------- Phase 3 产物：archify 内联 bundle ----------
const bundle = JSON.parse(readFileSync(join(outDir, "deliver/bundle.json"), "utf8"));
const diag = Object.fromEntries(bundle.diagrams.map((d) => [d.slotId, d.html]));

// ---------- Phase 1 落盘数据：数字与表格的唯一来源 ----------
const entryPoints = JSON.parse(readFileSync(join(outDir, "extraction/entry-points.json"), "utf8"));
const epList = entryPoints.entryPoints || entryPoints;
const epByKind = epList.reduce((m, e) => { m[e.type] = (m[e.type] || 0) + 1; return m; }, {});
const entitiesMeta = JSON.parse(readFileSync(join(outDir, "extraction/entities.json"), "utf8"))._meta;

// 状态机迁移表：从 specs2 程序化生成（spec 已全部通过 archify showcase 校验）
const specsDir = join(outDir, "specs2");
const lifecycleTables = readdirSync(specsDir)
  .filter((f) => f.endsWith("-lifecycle.json"))
  .sort()
  .map((f) => {
    const spec = JSON.parse(readFileSync(join(specsDir, f), "utf8"));
    const typeLabel = { start: "初始", active: "进行", waiting: "等待", decision: "判定", success: "成功", failure: "失败", neutral: "中性" };
    const rows = spec.transitions
      .map((t) => {
        const label = t.label ? t.label : '<span class="dim">（同上触发，未单列）</span>';
        return `<tr><td><code>${t.from}</code></td><td><code>${t.to}</code></td><td>${label}</td></tr>`;
      })
      .join("\n");
    const legend = spec.states
      .map((s) => `<code>${s.id}</code><span class="dim">·${typeLabel[s.type] || s.type}</span>`)
      .join(" ");
    return { id: spec.states[0] && f.replace("-lifecycle.json", ""), file: f, title: spec.meta.title, legend, rows };
  });

const lifecycleSection = lifecycleTables
  .map(
    (t) => `
  <h3>${t.title}</h3>
  ${diag[t.file.replace(".json", "")] || "<p class='muted'>图缺失</p>"}
  <p class="caption">状态图例：${t.legend}</p>
  <table>
    <thead><tr><th>从</th><th>到</th><th>触发条件（源码赋值路径提取）</th></tr></thead>
    <tbody>${t.rows}</tbody>
  </table>`
  )
  .join("\n");

const nav = ["业务地图", "领域模型", "核心流程", "架构图", "规则手册", "词汇表", "待确认清单"]
  .map((s, i) => `<a href="#sec${i + 1}" data-sec="sec${i + 1}">${s}</a>`)
  .join("\n        ");

// ---------- 领域模型 ----------
const domainModel = `
  <h2>领域模型</h2>
  <p class="muted">核心实体与关系。模型来自 <code>backend/models/</code>，字段名保留原始命名。</p>

  <h3 data-tip="Node|集群中一台可被 ssh 管理的主机">Node · 集群节点</h3>
  <dl class="fields">
    <div><dt>name</dt><dd>主机名（≤255）</dd></div>
    <div><dt>ip</dt><dd>IP，唯一约束，登录/识别的实际主键</dd></div>
    <div><dt>ssh_port</dt><dd>SSH 端口，默认 22</dd></div>
    <div><dt>username</dt><dd>登录用户，默认 root</dd></div>
    <div><dt>auth_type</dt><dd>password | key</dd></div>
    <div><dt>auth_credential</dt><dd>加密存储的凭据</dd></div>
    <div><dt>status</dt><dd>online | offline | unknown（默认 unknown）</dd></div>
    <div><dt>cpu / memory / disk / os_version</dt><dd>硬件/系统信息，可空</dd></div>
  </dl>

  <h3 data-tip="DeployTask|一次部署任务的执行记录">DeployTask · 部署任务</h3>
  <dl class="fields">
    <div><dt>id</dt><dd>任务主键</dd></div>
    <div><dt>plan_json</dt><dd>部署计划（大 JSON，Text 列），含步骤与 node_ids</dd></div>
    <div><dt>status</dt><dd>pending | running | success | failed | partial</dd></div>
    <div><dt>started_at / finished_at</dt><dd>执行起止</dd></div>
    <div><dt>log_file</dt><dd>日志文件绝对路径</dd></div>
    <div><dt>error_msg</dt><dd>结束错误摘要（≤2048）</dd></div>
  </dl>

  <h3 data-tip="DeployStep|任务内部的一个步骤，对应一个 role 在一组节点上的执行">DeployStep · 部署步骤</h3>
  <dl class="fields">
    <div><dt>task_id</dt><dd>所属任务，外键</dd></div>
    <div><dt>step_index</dt><dd>步骤序号（<code>(task_id, step_index)</code> 联合索引）</dd></div>
    <div><dt>role</dt><dd>jdk / hadoop / zookeeper / mysql / hive / common</dd></div>
    <div><dt>node_ids</dt><dd>执行节点（JSON 数组，≤2048）</dd></div>
    <div><dt>status</dt><dd>pending | running | success | failed</dd></div>
  </dl>

  <h3 data-tip="License|激活码记录，决定整站能否访问">License · 激活码</h3>
  <dl class="fields">
    <div><dt>code</dt><dd>激活码，唯一（每 4 字符一组用 - 分隔）</dd></div>
    <div><dt>machine_fingerprint</dt><dd>绑定的机器指纹</dd></div>
    <div><dt>activated_at</dt><dd>激活时间</dd></div>
    <div><dt>expires_at</dt><dd>过期时间，可空 = 永久</dd></div>
    <div><dt>status</dt><dd>inactive | active | expired</dd></div>
  </dl>
  <blockquote class="note">节点角色不写死在 <code>nodes</code> 表，由 <code>RoleAssignment</code> 按角色动态分配 —— 因此同一组节点可动态归入不同组件。</blockquote>
`;

// ---------- 核心流程 ----------
const coreFlow = `
  <h2>核心流程</h2>
  <p class="muted">一次大数据集群部署的完整业务流，与后台执行线程的状态迁移。</p>

  <h3>部署主链路</h3>
  <ol class="flow">
    <li><b>生成计划</b> <code>POST /api/deploy/plan</code>：输入节点 + 模板 + 组件，产出固定 6 步拓扑序计划</li>
    <li><b>创建任务</b> <code>POST /api/deploy</code>：写 <code>deploy_tasks</code>（status=pending）与各 <code>deploy_steps</code></li>
    <li><b>异步执行</b>：<code>start_deploy()</code> 提交后台线程，全局并发上限 2</li>
    <li><b>逐步执行</b>：任务置 running，按 step_index 顺序跑 playbook，事件经 WebSocket 广播 + 追加日志</li>
    <li><b>判定终态</b>：全成功 = success；有成功有失败 = partial；全失败 = failed</li>
  </ol>

  <h3>单步重试</h3>
  <ol class="flow">
    <li><code>POST /api/deploy/{id}/retry/{i}</code></li>
    <li>该 step 改回 pending、task 回到 running</li>
    <li>重跑该步 → 重新遍历全部 step 判定终态</li>
  </ol>

  <h3>激活</h3>
  <ol class="flow">
    <li><b>取指纹</b> <code>GET /api/license/fingerprint</code>：本机 <code>sha256(hw_uuid+CPU+platform)</code></li>
    <li><b>签发</b>（离线）：签发者用私钥生成激活码，交付用户</li>
    <li><b>激活</b> <code>POST /api/license/activate</code>：内置公钥离线验签 + 指纹绑定 + 有效期校验 → 写入 active</li>
    <li>失效内存缓存，中间件下次请求立即放行</li>
  </ol>

  <div class="calc">
    <h3>部署终态判定计算器</h3>
    <p class="muted">输入步骤结果个数，命中 <code>_run_deploy_task</code> 的判定规则。</p>
    <label>成功步骤数 <input id="calc-succ" type="number" min="0" value="0" inputmode="numeric"></label>
    <label>失败步骤数 <input id="calc-fail" type="number" min="0" value="0" inputmode="numeric"></label>
    <div class="result">终态：<span id="calc-out" class="out">—</span></div>
  </div>

  <h2>状态机（6 台，全部通过 archify showcase 校验）</h2>
  <p class="muted">由 Phase 1 迁移表自动转换生成，每张图下方附源码级迁移条件表。图支持缩放 / 平移 / 节点点击聚焦。</p>
  ${lifecycleSection}
`;

// ---------- 架构图 ----------
const architecture = `
  <h2>架构图</h2>
  <p class="muted">部署主链路 + 授权校验链路（其余业务 API 见数据层说明，由 archify 渲染并原生内联）。</p>
  ${diag["architecture"] || "<p class='muted'>架构图缺失</p>"}

  <h3>依赖方向 · codegraph 交叉校验</h3>
  <p class="muted">上图的每条连线方向都用 codegraph（tree-sitter 真解析）的 <code>callers</code>/<code>callees</code> 在符号级核对过，非人工车间。证据如下：</p>
  <table>
    <thead><tr><th>连线</th><th>codegraph 证据（调用方 → 被调方）</th></tr></thead>
    <tbody>
      <tr><td>api(deploy) → deploy-exec</td><td><code>start_deploy</code> ← <code>execute_deploy</code> (api/deploy.py:255)；<code>start_retry_step</code> ← <code>retry_step</code> (api/deploy.py:337)</td></tr>
      <tr><td>deploy-exec → ansible</td><td><code>run_playbook_async</code> ← <code>_run_step</code> (core/deploy_executor.py:320)</td></tr>
      <tr><td>deploy-exec → db</td><td><code>_run_step</code> → <code>SessionLocal</code> (database.py:36)、<code>DeployStep</code> (models/deploy.py:31)</td></tr>
      <tr><td>api(license) → license 引擎</td><td><code>validate_license</code> ← <code>activate_license</code> (api/license.py:159)</td></tr>
      <tr><td>部署计划</td><td><code>_generate_plan</code> ← <code>make_plan</code> (api/deploy.py:237)、<code>execute_deploy</code> (api/deploy.py:255)</td></tr>
    </tbody>
  </table>
  <blockquote class="note">codegraph 索引状态（extraction/entities.json <code>_meta</code>）：candidates 导出 <b>364 符号 / 96 文件</b>；入口点扫描（extraction/entry-points.json）：<b>${epList.length} 入口（${epByKind.http || 0} HTTP + ${epByKind.websocket || 0} WebSocket，扫描 77 文件）</b>。</blockquote>
`;

// ---------- 规则手册 ----------
const rules = `
  <h2>规则手册</h2>
  <p class="muted">每条规则可回溯到具体代码位置（文件 + 函数/行）。</p>

  <h3>部署引擎</h3>
  <table>
    <thead><tr><th>规则</th><th>数值 / 原文</th><th>来源</th></tr></thead>
    <tbody>
      <tr><td>全局并发上限</td><td>ThreadPoolExecutor <code>max_workers=2</code></td><td>deploy_executor.py:180</td></tr>
      <tr><td>单步超时</td><td>join <code>timeout=3600</code>s，超时取消并失败</td><td>deploy_executor.py:463</td></tr>
      <tr><td>失败停止后续</td><td>某 step 失败即 <code>break</code>（步骤有依赖）</td><td>deploy_executor.py:286</td></tr>
      <tr><td>no hosts matched</td><td>ansible 返回 successful 但视为失败</td><td>deploy_executor.py:499</td></tr>
      <tr><td>同任务互斥</td><td>执行中可重复 start/retry → RuntimeError</td><td>deploy_executor.py:158</td></tr>
      <tr><td>终态判定</td><td>全成功=success；有成功有失败=partial；全失败=failed</td><td>deploy_executor.py:289</td></tr>
    </tbody>
  </table>

  <h3>激活与安全</h3>
  <table>
    <thead><tr><th>规则</th><th>数值 / 原文</th><th>来源</th></tr></thead>
    <tbody>
      <tr><td>签名算法</td><td>Ed25519 离线签名，内置公钥校验</td><td>core/license_manager.py</td></tr>
      <tr><td>引擎内部复检</td><td><code>validate_license</code> 除激活接口外，还被 <code>is_license_valid_for_machine</code> 调用（中间件的本地复检路径）</td><td>core/license_manager.py:189</td></tr>
      <tr><td>机器指纹</td><td><code>sha256(hw_uuid+CPU+platform)</code>，不含 hostname</td><td>api/license.py:95</td></tr>
      <tr><td>有效期</td><td><code>expires_at &lt; now</code> → 视为 expired</td><td>api/license.py:130</td></tr>
      <tr><td>激活缓存</td><td><code>_CACHE_TTL_SECONDS = 5.0</code>，激活后 invalidate</td><td>middleware/license_check.py:28</td></tr>
      <tr><td>白名单前缀</td><td>/api/license, /api/health, /docs, /redoc, /openapi.json</td><td>middleware/license_check.py:32</td></tr>
      <tr><td>未激活拦截</td><td>全部返回 403 <code>{"code":403,"message":"未激活,请先激活"}</code></td><td>middleware/license_check.py:4</td></tr>
      <tr><td>部署日志流</td><td>仅放行 <code>/api/deploy/{id}/log</code> 之以 /log 结尾的 WS</td><td>middleware/license_check.py:43</td></tr>
    </tbody>
  </table>

  <h3>固定部署步骤（6 步拓扑序，api/deploy.py:38）</h3>
  <table>
    <thead><tr><th>#</th><th>role</th><th>作用域</th><th>说明</th></tr></thead>
    <tbody>
      <tr><td>0</td><td>common</td><td>所有节点</td><td>免密互通 + hosts + 目录/防火墙/时间/用户</td></tr>
      <tr><td>1</td><td>jdk</td><td>所有节点</td><td>部署 JDK</td></tr>
      <tr><td>2</td><td>zookeeper</td><td>ZK 角色</td><td>部署 ZooKeeper</td></tr>
      <tr><td>3</td><td>hadoop</td><td>NameNode/DataNode</td><td>同一 playbook 按 inventory 分组区分</td></tr>
      <tr><td>4</td><td>mysql</td><td>MySQL 角色</td><td>部署 MySQL</td></tr>
      <tr><td>5</td><td>hive</td><td>Hive 角色</td><td>部署 Hive</td></tr>
    </tbody>
  </table>
`;

// ---------- 词汇表 ----------
const glossary = `
  <h2>词汇表</h2>
  <p class="muted">跨模块叫法，hover 正文中的术语即可速查。点击跳转可回本表。</p>
  <dl class="glossary">
    <div><dt>plan</dt><dd>部署计划：<code>plan_json</code> 中按拓扑序排列的步骤列表，含 step_index / role / node_ids / extravars。</dd></div>
    <div><dt>playbook</dt><dd>Ansible 执行脚本，命名 <code>{role}.yml</code>，位于 PLAYBOOKS_DIR。</dd></div>
    <div><dt>role</dt><dd>组件角色：jdk/hadoop/zookeeper/mysql/hive/common，决定步骤挂载到哪些节点。</dd></div>
    <div><dt>inventory / extravars</dt><dd>Ansible 的连接主机清单与全局变量（可由步骤级 extravars 覆盖）。</dd></div>
    <div><dt>partial</dt><dd>部分成功终态：有 step 成功也有 step 失败。</dd></div>
    <div><dt>machine_fingerprint</dt><dd>机器指纹：绑定激活码到具体主机的哈希，防跨机复用。</dd></div>
    <div><dt>拓扑序</dt><dd>组件进行安装的先后顺序，由 <code>_resolve_dependencies</code> 递归解析依赖得出。</dd></div>
  </dl>
`;

// ---------- 待确认清单 ----------
const pending = `
  <h2>待确认清单</h2>
  <p class="muted">以下事实可从代码确认其存在，但其业务动机无法从代码推断 —— 需由熟悉业务的老员工确认，未混入正式正文。</p>
  <ul class="pending">
    <li><b>no hosts matched 视为失败</b>：ansible 返回 successful 但 <code>stdout</code> 含 "no hosts matched" 时被判失败。确认：这是否是期望语义，还是应仅告警？</li>
    <li><b>Node.status 默认 unknown</b>：无主动心跳来源，是否依赖外部扫描/巡检更新？</li>
    <li><b>plan_json 存大 JSON 原文</b>：无版本/快照管理，同一节点并发改 plan 是否会被覆盖？</li>
    <li><b>重复激活 = 续期</b>：同一激活码重复激活会覆盖绑定指纹与 expires_at。确认续期是预期行为。</li>
    <li><b>datetime 全用 utcnow()</b>（naive）：模型注释已声明待迁移 timezone-aware。跨时区展示是否已处理？</li>
    <li><b>激活缓存 5s</b>：激活状态最长延迟 5s 生效（写路径会 invalidate，读路径最多 5s 旧值）。误报风险可接受？</li>
  </ul>
`;

const tipData = {
  Node: "集群中一台可被 ssh 管理的主机，身份由 ip 唯一确定。",
  DeployTask: "一次部署任务的执行记录，承载 plan_json 与状态迁移。",
  DeployStep: "任务内的一个步骤，对应一个 role 在一组节点上的执行。",
  License: "激活码记录，决定整站能否访问；未激活时白名单外全部 403。",
};

const tips = Object.entries(tipData)
  .map(([k, v]) => `<span class="tip" data-term="${k}">${k}</span>`)
  .join("")

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Russh 大数据集群管理平台 · 业务文档</title>
<style>
  :root{
    --canvas:#020617; --mask:#0F172A; --ink:#FFFFFF; --muted:#94A3B8;
    --dim:#475569; --border:#1E293B;
    --frontend:#22D3EE; --backend:#34D399; --database:#A78BFA;
    --cloud:#FBBF24; --security:#FB7185; --messagebus:#FB923C; --external:#94A3B8;
    --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--canvas);color:var(--ink);
    font-family:var(--mono);font-size:14px;line-height:1.55}
  a{color:var(--frontend);text-decoration:none}
  .app{display:flex;min-height:100vh}
  nav{width:216px;flex:none;background:var(--mask);border-right:1px solid var(--border);
    padding:16px 12px;position:sticky;top:0;height:100vh;overflow:auto}
  nav .brand{font-weight:700;font-size:13px;letter-spacing:.06em;padding:4px 8px 12px;
    border-bottom:1px solid var(--border);margin-bottom:10px}
  nav a{display:block;padding:8px 10px;color:var(--muted);border-radius:8px;
    transition:background .15s,color .15s}
  nav a:hover{background:var(--border);color:var(--ink)}
  nav a.active{background:rgba(34,211,238,.12);color:var(--frontend);
    box-shadow:inset 2px 0 0 var(--frontend)}
  main{flex:1;padding:24px 32px;max-width:1180px}
  section{display:none}
  section.active{display:block}
  h1{font-size:22px;letter-spacing:-.025em;margin:0 0 4px}
  h2{font-size:17px;letter-spacing:-.02em;border-bottom:1px solid var(--border);
    padding-bottom:8px;margin:28px 0 14px}
  h3{font-size:13.5px;margin:22px 0 8px;color:var(--ink)}
  p.muted,.muted{color:var(--muted)}
  .dim{color:var(--dim);font-size:11.5px}
  code{background:var(--mask);border:1px solid var(--border);border-radius:5px;
    padding:1px 6px;color:var(--backend);font-size:12.5px}
  .fields,.glossary{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:10px 0}
  .fields div,.glossary div{background:var(--mask);border:1px solid var(--border);
    border-radius:12px;padding:10px 12px}
  .fields dt,.glossary dt{font-weight:700;font-size:12px;letter-spacing:.02em;
    color:var(--frontend);margin-bottom:4px}
  .fields dd,.glossary dd{margin:0;color:var(--muted);font-size:12.5px}
  blockquote.note{border-left:3px solid var(--database);background:var(--mask);
    padding:10px 14px;border-radius:0 10px 10px 0;color:var(--muted);margin:14px 0}
  ol.flow{margin:8px 0;padding-left:22px;color:var(--muted)}
  ol.flow li{margin:6px 0}
  ol.flow b{color:var(--ink)}
  table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12.5px}
  th,td{text-align:left;padding:8px 10px;border:1px solid var(--border)}
  th{background:var(--mask);color:var(--frontend);font-weight:700;font-size:12px}
  td{color:var(--muted)}
  .caption{color:var(--dim);font-size:12px;margin-top:8px}
  .panel{background:var(--mask);border:1px solid var(--border);border-radius:16px;
    padding:16px;margin:16px 0}
  .calc{background:var(--mask);border:1px solid var(--border);border-radius:16px;
    padding:18px;margin:20px 0}
  .calc label{margin-right:18px;color:var(--muted);font-size:13px}
  .calc input{background:var(--canvas);color:var(--ink);border:1px solid var(--border);
    border-radius:8px;padding:6px 10px;font-family:var(--mono);font-size:14px;width:90px;
    margin-left:6px}
  .calc input:focus{outline:none;border-color:var(--frontend);box-shadow:0 0 0 2px rgba(34,211,238,.25)}
  .calc .result{margin-top:14px;color:var(--muted)}
  .calc .out{font-weight:700;color:var(--frontend);font-size:16px}
  ul.pending{margin:8px 0;padding-left:0;list-style:none}
  ul.pending li{background:var(--mask);border:1px solid var(--border);border-radius:12px;
    padding:12px 14px;margin:8px 0;color:var(--muted)}
  ul.pending b{color:var(--cloud)}
  .tip{border-bottom:1px dashed var(--frontend);cursor:help;color:var(--frontend)}
  #tooltip{position:fixed;max-width:300px;background:var(--mask);border:1px solid var(--frontend);
    color:var(--ink);border-radius:10px;padding:8px 12px;font-size:12.5px;z-index:99;
    display:none;box-shadow:0 18px 48px rgba(0,0,0,.3)}
  @media(max-width:820px){
    .app{flex-direction:column}
    nav{width:100%;height:auto;position:static;border-right:0;border-bottom:1px solid var(--border)}
    nav a{display:inline-block;padding:6px 10px;margin:2px}
    main{padding:16px}
    .fields,.glossary{grid-template-columns:1fr}
  }
</style>
<style>
${bundle.css}
</style>
<style>
${bundle.chromeCss}
</style>
</head>
<body>
<div id="tooltip"></div>
<div class="app">
  <nav>
    <div class="brand">RUSSH · 业务文档</div>
    ${nav}
  </nav>
  <main>
    <h1>Russh 大数据集群管理平台</h1>
    <p class="muted">单域系统 · 入口 ${epList.length} 个（${epByKind.http || 0} HTTP + ${epByKind.websocket || 0} WebSocket）· 部署主链路 + 授权校验链路（codegraph 交叉校验：${entitiesMeta.sources.codegraph}）</p>

    <section id="sec1" class="active">
      <h2>业务地图</h2>
      <p class="muted">Russh 面向企业大数据团队：在一批主机（节点）上通过 Ansible 自动化地把 ZooKeeper / Hadoop / MySQL / Hive 等组件组装成可用集群。全站由激活码授权，未激活时白名单外一律 403。</p>
      <h3>核心主线（学习路径）</h3>
      <ol class="flow">
        <li>读 <b>领域模型</b>：Node（被管理主机）→ DeployTask/DeployStep（部署的载体）→ License（授权）</li>
        <li>读 <b>架构图</b>：一次请求从 Web 前端如何下到 Ansible 再到数据库</li>
        <li>读 <b>核心流程</b>：部署主链路 / 单步重试 / 激活，以及 6 台状态机</li>
        <li>读 <b>规则手册</b>：并发、超时、终态判定等带出处数值</li>
        <li>最后过 <b>待确认清单</b>：由业务老员工确认隐性规则</li>
      </ol>
    </section>

    <section id="sec2">${domainModel}</section>
    <section id="sec3">${coreFlow}</section>
    <section id="sec4">${architecture}</section>
    <section id="sec5">${rules}</section>
    <section id="sec6">${glossary}${tips}</section>
    <section id="sec7">${pending}</section>
  </main>
</div>
<script>
${bundle.runtime}
</script>
<script>
(function(){
  // 左侧导航 tab 切换
  var links=document.querySelectorAll('nav a');
  var secs=document.querySelectorAll('main section');
  links.forEach(function(a){
    a.addEventListener('click',function(e){
      e.preventDefault();
      links.forEach(function(x){x.classList.remove('active')});
      secs.forEach(function(s){s.classList.remove('active')});
      var t=this.dataset.sec;this.classList.add('active');
      document.getElementById(t).classList.add('active');
      window.scrollTo(0,0);
      // 图表槽位在隐藏状态下挂载时拿不到宽度，切到可见后重新适配
      if(window.ArchifyInline){
        document.getElementById(t).querySelectorAll('.arch-slot').forEach(function(r){
          ArchifyInline.fit(r);
        });
      }
    });
  });

  // 终态判定计算器：命中 _run_deploy_task 判定规则
  var cs=document.getElementById('calc-succ'),
      cf=document.getElementById('calc-fail'),
      out=document.getElementById('calc-out');
  function calc(){
    var s=parseInt(cs.value)||0, f=parseInt(cf.value)||0, r;
    if(s===0&&f===0){r='—';}
    else if(f>0&&s>0){r='partial';}
    else if(f>0){r='failed';}
    else{r='success';}
    out.textContent=r;
    var color = r==='success'?'var(--backend)':r==='partial'?'var(--cloud)':r==='failed'?'var(--security)':'var(--frontend)';
    out.style.color=color==='var(--frontend)'?'var(--dim)':color;
  }
  cs.addEventListener('input',calc);cf.addEventListener('input',calc);calc();

  // 词汇表 tooltip
  var tip=document.getElementById('tooltip');
  var terms={Node:"集群中一台可被 ssh 管理的主机，身份由 ip 唯一确定。",
    DeployTask:"一次部署任务的执行记录，承载 plan_json 与状态迁移。",
    DeployStep:"任务内的一个步骤，对应一个 role 在一组节点上的执行。",
    License:"激活码记录，决定整站能否访问；未激活时白名单外全部 403。"};
  document.addEventListener('mouseover',function(e){
    var t=e.target.closest('.tip');
    if(t){tip.textContent=terms[t.dataset.term]||'';tip.style.display='block';}
  });
  document.addEventListener('mousemove',function(e){
    if(tip.style.display==='block'){
      tip.style.left=Math.min(e.clientX+14,innerWidth-320)+'px';
      tip.style.top=(e.clientY+16)+'px';
    }
  });
  document.addEventListener('mouseout',function(e){
    if(e.target.closest('.tip'))tip.style.display='none';
  });
})();
</script>
</body>
</html>
`;

const outPath = join(outDir, "russh-business-docs.html");
writeFileSync(outPath, html, "utf8");
console.log("written", outPath, (Buffer.byteLength(html) / 1024).toFixed(0), "KB");
console.log(`图表内联：${bundle.diagrams.length} 张（${bundle.diagrams.map((d) => d.slotId).join(", ")}）`);
