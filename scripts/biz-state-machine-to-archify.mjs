#!/usr/bin/env node
/**
 * biz-state-machine-to-archify.mjs
 *
 * 二次开发适配层：把本 skill Phase 1 提取出的状态迁移表（结构化 JSON）
 * 自动转换成 archify 的 lifecycle diagram spec，减少每次手写 JSON 的工作量和出错率。
 *
 * 不修改 archify 任何源码/渲染器内部逻辑——只是在它的输入层做转换，
 * 产出的 spec 仍然要走 archify 自己的 validate → deliver 流程，
 * 校验失败时按 archify 返回的 diagnostics 修正（多半是 col/lane 布局需要人工微调）。
 *
 * 输入格式（本 skill Phase 1 提取的状态机中间数据，见 references/01-extraction.md 1.2 节）：
 * {
 *   "title": "订单状态机",
 *   "states": [
 *     { "id": "created", "label": "已创建", "kind": "start" },
 *     { "id": "paid", "label": "已支付", "kind": "active" },
 *     { "id": "shipped", "label": "已发货", "kind": "active" },
 *     { "id": "completed", "label": "已完成", "kind": "success" },
 *     { "id": "cancelled", "label": "已取消", "kind": "failure" }
 *   ],
 *   "transitions": [
 *     { "from": "created", "to": "paid", "label": "支付成功" },
 *     { "from": "created", "to": "cancelled", "label": "超时未支付" },
 *     { "from": "paid", "to": "shipped", "label": "仓库发货" },
 *     { "from": "shipped", "to": "completed", "label": "用户签收" }
 *   ]
 * }
 *
 * kind 取值映射到 archify 的 state.type：start/active/waiting/decision/success/failure
 * （本 skill 提取时如果只有"正常/异常"二元信息，异常分支一律映射为 failure，
 *  由人工在 review 阶段精修成更准确的 waiting/decision，转换脚本不替业务做判断）
 *
 * 用法：
 *   node biz-state-machine-to-archify.mjs <input.json> <output-spec.json>
 *
 * 实测结论（用一个 7 状态 + 7 条迁移、带 2 条分支的订单状态机跑通的）：
 * 这个转换脚本能保证产出 schema 合法、且大幅减少"状态互相重叠"这类基础问题
 * （自动做多泳道分配，避免同列多个状态挤在一起）。但涉及跨泳道的迁移边线
 * （比如从主干直接连到某条分支泳道里较远的状态）仍然可能被 archify validate
 * 标记为穿越了其他状态——这类问题需要按诊断信息里给的 fromSide/toSide/via/
 * channelX/channelY 建议手动加一两个覆盖字段修一轮，不是这个脚本能一次自动解决的。
 * 按 archify 自己的原则：跑 validate → 按诊断修 → 再跑 validate，2-3 轮内应该能收敛；
 * 如果 2 轮修完错误数没有下降，如实向用户报告没修完的诊断，不要硬包装成"已完成"。
 */

import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_STATE_TYPES = new Set(['start', 'active', 'waiting', 'decision', 'success', 'failure', 'neutral']);

// ===== archify lifecycle 布局预算（来自 renderers/lifecycle/README.md，实测 validate 印证）=====
// main 泳道（相位带）：col 0..4，x 中心 = [94,248,402,556,710]，y=126，118×62
// terminal 带（结果带）：col 0..2，x 中心 = [402,556,710]，y=450，118×58
// event 带（事件带）：col 0..2，x 中心同 terminal，y=278，126×58；多条 event 泳道共享同一带，靠 yOffset 分离
// 官方设计规则：主干一条水平 rail；下带只放"中断/恢复/终态出口"；终态尽量从源事件垂直下落。
const MAIN_CAP = 5;   // main 泳道最多 5 列
const BAND_CAP = 3;   // terminal / event 带最多 3 列

/**
 * 布局算法（v2）：
 * 1. kind 为 failure 的状态 → terminal 带（终态出口），按出现顺序占 col 0..2，超出的落到 event 带。
 * 2. 其余状态按"非通配边"的最长路径分层后排进 main 泳道（col 0..4）；超出 5 个的溢出到 event 带。
 * 3. 通配（*）展开出来的重置/兜底边不参与分层——它们是"恢复边"，按官方规则不该影响主干的列次。
 * 4. main 之外的状态若与同带其他状态同列，用 yOffset 拉开（同带共享一条水平带）。
 */
function layoutMachine(states, transitions) {
  const nonWc = transitions.filter((t) => !t._wildcard);
  const isFailure = new Set(states.filter((s) => s.kind === 'failure').map((s) => s.id));

  // —— 在非通配前向图上做最长路径分层（Kahn 拓扑 + 列号取最大前驱+1）——
  const col = new Map(states.map((s) => [s.id, 0]));
  const outEdges = new Map(states.map((s) => [s.id, []]));
  const inDeg = new Map(states.map((s) => [s.id, 0]));
  for (const t of nonWc) {
    if (t.from === t.to) continue;
    if (!outEdges.has(t.from) || !inDeg.has(t.to)) continue;
    outEdges.get(t.from).push(t.to);
    inDeg.set(t.to, inDeg.get(t.to) + 1);
  }
  const queue = states.filter((s) => inDeg.get(s.id) === 0).map((s) => s.id);
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift();
    for (const nx of outEdges.get(cur) || []) {
      if (col.get(nx) < col.get(cur) + 1) col.set(nx, col.get(cur) + 1);
      if (!seen.has(nx)) { seen.add(nx); queue.push(nx); }
    }
  }
  // 只被通配边引用、没有任何非通配定位信息的状态（如 Node.offline）——归零，交给泳道规则摆放
  for (const s of states) if (!seen.has(s.id)) col.set(s.id, 0);

  const byOrder = (a, b) => (col.get(a.id) - col.get(b.id)) || (a._idx - b._idx);

  // —— failure → terminal，其余 → main（溢出 → event）——
  const lane = new Map();
  const yOffset = new Map();
  const rail = states.filter((s) => !isFailure.has(s.id)).sort(byOrder).slice(0, MAIN_CAP);
  const overflow = states.filter((s) => !isFailure.has(s.id)).sort(byOrder).slice(MAIN_CAP);
  const failures = states.filter((s) => isFailure.has(s.id)).sort(byOrder);

  rail.forEach((s, i) => { lane.set(s.id, 'main'); col.set(s.id, i); });
  overflow.forEach((s, i) => {
    lane.set(s.id, 'event');
    col.set(s.id, Math.min(BAND_CAP - 1, i % BAND_CAP));
    yOffset.set(s.id, Math.floor(i / BAND_CAP) * 88); // event 带 y=278，向下错行
  });
  failures.forEach((s, i) => {
    lane.set(s.id, 'terminal');
    col.set(s.id, Math.min(BAND_CAP - 1, i));
    if (i >= BAND_CAP) yOffset.set(s.id, Math.floor(i / BAND_CAP) * 80); // terminal 带 y=450，向下会顶到图例，超出即加高 viewBox
  });

  const lanes = [{ id: 'main', label: '主流程' }];
  if (overflow.length) lanes.push({ id: 'event', label: '中断/恢复' });
  lanes.push({ id: 'terminal', label: '终态' });

  return {
    col,
    lane,
    yOffset,
    lanes,
    mainIds: new Set(rail.map((s) => s.id)),
    needsTallViewBox: failures.length > BAND_CAP,
  };
}

/**
 * 把 Phase 1 落盘的多状态机格式归一化成单状态机格式。
 *
 * 背景（实测发现的契约断裂）：references/01-extraction.md 的 1.2 节只描述了
 * "汇总成状态迁移表"的方法，但没有定义落盘 JSON 的 schema；而本脚本原本只接受
 * 单个状态机的 {title, states, transitions}。按 SKILL.md 的 R10 落盘优先产出的
 * state-machines.json 是 { stateMachines: [...] }（一个文件装多个实体的状态机），
 * 直接喂进来会报"输入缺少 title / states / transitions"。
 * 这里做归一化，让两种格式都能吃，避免每次都要人工拆文件。
 */
const FAILURE_HINT = /fail|error|expired|offline|reject|abort|cancel/i;
const SUCCESS_HINT = /success|complete|done|installed|online|active|approved|paid|finished/i;

function inferKind(id, hasIncoming, hasOutgoing) {
  // 1) 名字里的异常信号优先于拓扑位置——offline/error 这类状态可能只有通配边进入，
  //    拓扑上看不到入度，但语义上就是终态出口（实测 Node.offline 踩过）。
  if (FAILURE_HINT.test(id)) return 'failure';
  // 2) not_/un 前缀是"初始否定态"（如 not_installed），注意别被 SUCCESS_HINT 的
  //    'installed' 子串误中——必须放在 success 判断之前（实测踩过）。
  if (/^not_|^un/.test(id)) return 'start';
  if (!hasIncoming && hasOutgoing) return 'start';
  if (hasIncoming && !hasOutgoing) {
    if (SUCCESS_HINT.test(id)) return 'success';
    return 'neutral'; // 有入无出、名字又无成败信号（如 partial）→ 中性结果，不硬贴标签
  }
  if (!hasIncoming && !hasOutgoing) return 'active'; // 只被通配边引用的中间态
  return 'active';
}

function normalizeToSingleMachine(raw, entityName) {
  if (raw.title && Array.isArray(raw.states) && Array.isArray(raw.transitions)) {
    return raw; // 已经是单状态机格式，原样返回
  }
  if (!Array.isArray(raw.stateMachines) || raw.stateMachines.length === 0) {
    throw new Error('输入既不是单状态机格式（title/states/transitions），也不是多状态机格式（stateMachines[]）');
  }

  let target;
  if (entityName) {
    target = raw.stateMachines.find(
      (m) => m.entity === entityName || `${m.entity}.${m.field}` === entityName
    );
    if (!target) {
      const available = raw.stateMachines
        .map((m) => (m.field ? `${m.entity}.${m.field}` : m.entity))
        .join(', ');
      throw new Error(`未找到状态机 "${entityName}"。可选：${available}`);
    }
  } else {
    target = raw.stateMachines[0];
    console.error(`未指定 --entity，默认使用第一个：${target.entity}.${target.field}`);
  }

  // 拆分复合值：'a|b|c' → [a,b,c]。'*' 由调用方另行处理。
  const splitMulti = (v) => {
    if (!v || v === '*') return [];
    return String(v).split('|').map((s) => s.trim()).filter(Boolean);
  };

  // 从 declaredEnum + transitions 的 from/to 推导完整状态集合。
  // 注意必须对 '|' 复合值拆分后再收集——实测踩过：不拆分会把
  // "running|stopped|error" 整个字符串当成一个 state id，
  // 直接撞上 archify 的 ^[a-zA-Z][a-zA-Z0-9_-]*$ 命名约束（schema/pattern 错误）。
  const ids = new Set(target.declaredEnum || []);
  for (const t of target.transitions || []) {
    for (const v of splitMulti(t.from)) ids.add(v);
    for (const v of splitMulti(t.to)) ids.add(v);
  }

  const hasIncoming = new Set();
  const hasOutgoing = new Set();
  for (const t of target.transitions || []) {
    if (t.to && t.to !== '*') hasIncoming.add(t.to);
    if (t.from && t.from !== '*') hasOutgoing.add(t.from);
  }

  const states = [...ids].map((id) => ({
    id,
    label: id,
    kind: inferKind(id, hasIncoming.has(id), hasOutgoing.has(id)),
  }));

  // 展开通配与复合迁移：
  //  '*'            → 所有状态
  //  'a|b|c'        → a、b、c 三个具体状态（Phase 1 提取时常用 | 表达"落到其中之一"）
  //  '*' 若不做展开会整条迁移被丢弃，实测会让图变成 0 条边的空壳。
  const expandSide = (v) => {
    if (!v) return [];
    if (v === '*') return [...ids];
    return splitMulti(v);
  };

  // 边标签只放"事件/触发条件"这类短语，不放长篇业务解读。
  // 实测教训：把 businessMeaning（整句中文业务说明）塞进 label 会让 archify
  // 的 showcase 排版校验大面积报 label-route-clearance / label overlap，
  // 6 条边的图能炸出 20+ 条诊断。业务解读属于 R7 的"配套文字说明"，
  // 应该落在图旁边的表格里，不要压在 SVG 上。
  const LABEL_MAX = 16;
  const label = (t) => {
    const raw = String(t.shortLabel || t.trigger || t.businessMeaning || t.code || '');
    return raw.length > LABEL_MAX ? raw.slice(0, LABEL_MAX - 1) + '…' : raw;
  };
  const seen = new Set();
  const transitions = [];
  for (const t of target.transitions || []) {
    for (const from of expandSide(t.from)) {
      for (const to of expandSide(t.to)) {
        if (from === to) continue;      // 自环无信息量
        const key = `${from}->${to}|${label(t)}`;
        if (seen.has(key)) continue;    // 去重（同一对状态可能因多条赋值点重复）
        seen.add(key);
        // _wildcard 标记通配展开出的"恢复/兜底"边，布局分层时会跳过它们——
        // 否则重试边（success→pending 之类）会制造假环，把主干列次全部拉平。
        transitions.push({ from, to, label: label(t), _wildcard: t.from === '*' });
      }
    }
  }

  const skipped = (target.transitions || []).length
    ? (target.transitions || []).filter((t) => !t.from || !t.to).length
    : 0;
  if (skipped > 0) console.error(`警告：${target.entity}.${target.field} 有 ${skipped} 条迁移缺少 from/to，已跳过`);

  // 合并平行边：同一对 from->to 因多个赋值点/多条触发路径重复出现时，
  // 图上只画一条边、标签用"；"拼接（超长截断）——细节留在配套表格里（R7）。
  // 实测不合并的后果：同侧多边导致路由 anchor 错位（7px 微段）、标签互相重叠。
  const merged = new Map();
  const mergeKey = (t) => `${t.from}=>${t.to}`;
  for (const t of transitions) {
    const k = mergeKey(t);
    if (!merged.has(k)) {
      merged.set(k, { ...t });
    } else {
      const m = merged.get(k);
      m._wildcard = m._wildcard && t._wildcard !== false ? m._wildcard : t._wildcard || m._wildcard;
      if (t.label && !m.label.includes(t.label)) {
        const joined = m.label ? `${m.label}；${t.label}` : t.label;
        m.label = joined.length > LABEL_MAX ? m.label : joined; // 超长就保留先到的，不再硬塞
      }
    }
  }

  return {
    title: `${target.entity}.${target.field} 状态机`,
    subtitle: target.businessWhy || undefined,
    states,
    transitions: [...merged.values()],
  };
}

function convert(input) {
  if (!input.title || !Array.isArray(input.states) || !Array.isArray(input.transitions)) {
    throw new Error('输入缺少 title / states / transitions 字段，检查 Phase 1 提取产出的中间数据格式');
  }

  const enriched = input.states.map((s, i) => ({ ...s, _idx: i }));
  const layout = layoutMachine(enriched, input.transitions);

  const states = enriched.map((s) => {
    const type = ALLOWED_STATE_TYPES.has(s.kind) ? s.kind : 'active';
    const isMain = layout.mainIds.has(s.id);
    return {
      id: s.id,
      type,
      label: s.label,
      ...(s.sublabel ? { sublabel: s.sublabel } : {}),
      lane: layout.lane.get(s.id),
      col: layout.col.get(s.id) ?? 0,
      ...(layout.yOffset.get(s.id) ? { yOffset: layout.yOffset.get(s.id) } : {}),
      // step 序号只给主干 rail（官方规则：step 用于有序相位）；下带状态不带序号
      ...(isMain ? { step: String(layout.col.get(s.id) + 1).padStart(2, '0') } : {}),
      ...(s.tag ? { tag: s.tag } : {}),
    };
  });

  // ===== 路由与标签策略（全部来自 validate 诊断的实测教训）=====
  // 几何常量与 renderers/lifecycle/render-lifecycle.mjs 的 layout 对象一致：
  // main 列中心 x=[94,248,402,556,710]，框 y 126..188；terminal 列中心 x=[402,556,710]，y 450..508。
  // 关键事实：main 带相邻列的框间隙只有 36px，任何标签都放不进——
  // 主干边的标签必须挪到带外（上方 y≈122 或下方 y≈222），否则必然压框。
  const MAIN_CX = [94, 248, 402, 556, 710];
  const TERM_CX = [402, 556, 710];
  const cxOf = (id) => {
    const laneId = layout.lane.get(id);
    const c = layout.col.get(id) ?? 0;
    return laneId === 'terminal' ? TERM_CX[Math.min(TERM_CX.length - 1, c)] : MAIN_CX[Math.min(MAIN_CX.length - 1, c)];
  };
  const laneOfId = (id) => layout.lane.get(id);
  const colOfId = (id) => layout.col.get(id) ?? 0;

  // 同一源状态发出的多条终态出口边，channelY 逐条下移，避免垂直段共线重叠
  const termSeqBySource = new Map();
  // 通配恢复边按 (to,label) 去重标签：同一个业务事件（如"重试时重置步骤状态"）
  // 从三个状态各自连回 pending，图上只保留第一条的标签，其余不重复渲染。
  const seenWildLabel = new Set();

  const transitions = input.transitions.map((t) => {
    const fromLane = laneOfId(t.from);
    const toLane = laneOfId(t.to);
    const fromCx = cxOf(t.from);
    const toCx = cxOf(t.to);
    const dCol = colOfId(t.to) - colOfId(t.from);
    const edge = { from: t.from, to: t.to };
    if (t.label) edge.label = t.label;

    // —— 通配恢复边标签去重 ——
    if (t._wildcard && t.label) {
      const k = `${t.to}|${t.label}`;
      if (seenWildLabel.has(k)) delete edge.label;
      else seenWildLabel.add(k);
    }

    if (fromLane === 'main' && toLane === 'main') {
      if (Math.abs(dCol) === 1) {
        edge.route = 'straight';
        if (dCol > 0) {
          // 正向邻接：标签放带上方的列间隙中点
          edge.labelAt = [Math.min(fromCx, toCx) + 77, 122];
        } else {
          // 反向邻接（如 stopped→running）：标签放带下方，避免与正向边的上方标签同点
          edge.labelAt = [Math.max(fromCx, toCx) - 77, 222];
        }
      } else if (dCol > 0) {
        // 正向跳列：走下方通道绕开中间状态，标签压在通道横段上
        edge.route = 'bottom-channel';
        edge.channelY = 320;
        edge.labelAt = [(fromCx + toCx) / 2, 320];
      } else {
        // 反向跳列（恢复边，如 success→pending）：走顶部通道，标签压在顶部横段上
        edge.route = 'top-channel';
        edge.labelAt = [(fromCx + toCx) / 2, 98];
      }
    } else if (fromLane === 'main' && toLane === 'terminal') {
      // 终态出口：官方规则"尽量从源事件垂直下落"。
      // channelY 从 340 起（实测 300 会和 bottom-channel 的 y320 通道、
      // 以及标签矩形擦碰），同一源的多条出口逐条 +40 错开垂直走廊。
      edge.route = 'drop';
      const seq = termSeqBySource.get(t.from) || 0;
      termSeqBySource.set(t.from, seq + 1);
      edge.channelY = 340 + seq * 40;
    } else if (fromLane === 'terminal' && toLane === 'main') {
      if (Math.abs(fromCx - toCx) < 1) {
        edge.route = 'straight'; // 正对上方：垂直直连
      } else {
        // L 形绕行：先横到目标列正下方，再贴着目标框底进入
        // 注意：via 不是 route 枚举值（schema 只收 auto/straight/drop/*-channel），
        // 单独给 via 字段即可，route 必须删掉——实测踩过 schema/enum。
        edge.via = [[toCx, 479], [toCx, 240]];
      }
    }
    return edge;
  });

  if (layout.needsTallViewBox) {
    console.error('提示：terminal 带状态超过 3 个，默认 viewBox 高度可能不够，validate 若报纵向越界需加高 meta.viewBox[1]');
  }

  return {
    schema_version: 1,
    diagram_type: 'lifecycle',
    meta: {
      title: input.title,
      quality_profile: 'showcase',
      ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    },
    lanes: layout.lanes,
    states,
    transitions,
  };
}

/**
 * 应用布局微调 hints（Phase 3 人工微调的落盘形态）。
 *
 * 自动策略（layoutMachine + 路由/标签策略）能解决绝大多数布局问题，但个别
 * 机器的个别标签/走廊仍需按 validate 诊断微调。微调以 hints 文件落盘、可复跑：
 *   { "Entity.field": { "transitions": { "from->to": { "labelAt": [x,y], "route": "...", "channelY": n, "label": null } } } }
 * null 的字段表示删除（如去掉标签）。hints 属于 Phase 3 产物，不回写 Phase 1 数据。
 */
function applyHints(spec, hints) {
  if (!hints) return;
  const th = hints.transitions || {};
  for (const t of spec.transitions) {
    const override = th[`${t.from}->${t.to}`];
    if (!override) continue;
    for (const [k, v] of Object.entries(override)) {
      if (v === null) delete t[k];
      else t[k] = v;
    }
  }
}

function loadHints(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`警告：hints 文件读取失败（${p}）：${e.message}，忽略 hints 继续生成`);
    return {};
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') flags.all = true;
    else if (a === '--entity') flags.entity = argv[++i];
    else if (a === '--hints') flags.hints = argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [inputPath, outputPath] = positional;
  if (!inputPath || !outputPath) {
    console.error('用法: node biz-state-machine-to-archify.mjs <input.json> <output-spec.json|输出目录> [--entity <Entity.field>] [--all]');
    console.error('  --entity X  从多状态机的 state-machines.json 里挑一个（如 DeployTask.status）；省略则取第一个');
    console.error('  --all       为每个状态机各生成一个 spec（此时 output 视为目录）');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  if (flags.all) {
    if (!Array.isArray(raw.stateMachines) || raw.stateMachines.length === 0) {
      console.error('--all 需要输入是 { stateMachines: [...] } 格式');
      process.exit(1);
    }
    fs.mkdirSync(outputPath, { recursive: true });
    let n = 0;
    for (const m of raw.stateMachines) {
      const key = m.field ? `${m.entity}.${m.field}` : m.entity;
      try {
        const spec = convert(normalizeToSingleMachine(raw, key));
        // hints 按 "Entity.field" 索引；--all 模式下整份 hints 文件直接传，逐机取自己的那份
        applyHints(spec, flags.hints ? loadHints(flags.hints)[key] : undefined);
        const out = path.join(outputPath, `${key.replace(/\./g, '_')}-lifecycle.json`);
        fs.writeFileSync(out, JSON.stringify(spec, null, 2), 'utf8');
        console.log(`✓ ${out}  (${spec.states.length} 状态 / ${spec.transitions.length} 迁移)`);
        n++;
      } catch (e) {
        console.error(`✗ ${key}: ${e.message}`);
      }
    }
    console.log(`共生成 ${n} 个 lifecycle spec 到 ${outputPath}/`);
    return;
  }

  const input = normalizeToSingleMachine(raw, flags.entity);
  const spec = convert(input);
  // 单机模式：hints 文件既可以是 { "Entity.field": {...} } 索引格式，也可以直接就是该机的 { transitions: {...} }
  if (flags.hints) {
    const h = loadHints(flags.hints);
    const key = flags.entity || (raw.stateMachines ? `${raw.stateMachines[0].entity}.${raw.stateMachines[0].field}` : undefined);
    applyHints(spec, (key && h[key]) || (h.transitions ? h : undefined));
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf8');
  console.log(`已生成 archify lifecycle spec 候选：${outputPath}`);
  console.log(`  ${spec.states.length} 个状态 / ${spec.transitions.length} 条迁移 / ${spec.lanes.length} 条泳道`);
  console.log('下一步：node assets/archify/bin/archify.mjs validate lifecycle ' + outputPath + ' --quality showcase --json');
}

main();
