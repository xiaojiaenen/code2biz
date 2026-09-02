#!/usr/bin/env node
/**
 * check-content-depth.mjs
 *
 * 最终单文件 HTML 的"业务内容深度"门禁（R9 / R10 / R11）。
 *
 * 为什么需要它：check-final-html.mjs 只证明"这个 HTML 打得开"（无 iframe、无
 * 外部资源、标签闭合），它完全不关心"里面讲清楚了没有"。真实事故：Russh 实测
 * 产物 356 KB，正文只有约 6.9k 可见字符（中文约 2k 字），7 张图配的解读加起来
 * 不到 900 字符，10 处 `&amp;quot;` 双重转义在浏览器里直接显示出 `&quot;` 字样
 * ——而这份产物是通过了 check-final-html.mjs 全部门禁的。
 *
 * 所以 R5（流程五维度）/ R6（架构五问）/ R7（图注业务解读）这些写在 references
 * 里的"必须"，如果没有对应的可执行检查，就只是意愿，不是约束。这个脚本把它们
 * 变成机器能判定的门槛。
 *
 * 检查项：
 *   R11  实体转义       &amp;quot; 之类双重转义（浏览器正文会露出 &quot; 字样）
 *   R10  占位符零容忍   "同上触发，未单列"、"见数据层说明"、"待补"、TODO/TBD、
 *                       "如上图所示" 等占位文本一律 error，并点名上下文
 *   R9-5 标记约定存在   文档若含图却没有 R9 系列标记，视为"绕开约定"，直接 error
 *   R9-1 图注深度       每张图必须有 ≥200 可见字符的图注；含图章节的正文量
 *                       ≥ 图数 × 200（防止"图代文"）
 *   R9-2 架构五问(R6)   架构章节必须出现 5 个 data-r6 子块，各有内容下限；
 *                       purpose 必须回答"为什么"，assessment 必须回答"问题/瓶颈"
 *   R9-3 流程五维(R5)   每个 data-flow 必须有 5 个 data-r5 子块；exception 必须
 *                       同时写触发条件和业务后果
 *   R9-4 小业务展开     每个 recorded 入口点必须有 ≥60 可见字符的业务说明；
 *                       recorded 占已处理入口点的比例 ≤ 50%
 *   R9-6 规则可追溯     每条业务规则必须带源码位置（file:line / 文件名+行号）
 *   R9-7 状态业务化(R12) 每个 data-sm 状态机必须有状态业务定义表（每状态 ≥20 字符）
 *                       和迁移业务含义表（每条 ≥40 字符且含业务动词）；
 *                       全文无 data-sm 却出现 `unknown → running` 式裸字面量
 *                       流转时直接报错（Russh 实测事故形态）
 *   R9-8 流程分层(R13)   data-level="main|system" 的流程必须有 data-level="sub"
 *                       子流程；每个子流程必须有调用链（file:line）与 ≥30 字符职责
 *   R9-9 wiki 结构       14 章结构的核心章节是否缺席（warn 级，references/06 v2）
 *
 * 用法：
 *   node scripts/check-content-depth.mjs <final.html> [选项]
 * 选项：
 *   --coverage <path>   check-entry-coverage.mjs 产出的覆盖率报告（校验 recorded 占比）
 *   --entries <path>    scan-entry-points.mjs 产出的入口点清单（逐条核对 recorded 是否展开）
 *   --report <path>     把 JSON 报告写到文件（默认只打人类可读摘要）
 *   --json              在 stdout 额外输出完整 JSON 报告
 *   --strict            warning 也按 error 处理（交付前最后一次检查建议开）
 *
 * 退出码：
 *   0  无 error（可能有 warning）
 *   1  发现 error，不允许交付
 *   2  用法错误 / 文件读不到
 */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------- 阈值配置 ------------------------------- */

const TH = {
  figureCaptionMin: 200,      // references/11 §3.3：每张图配 200-400 字业务解读
  chapterTextPerFigure: 200,  // 含图章节的正文量下限 = 图数 × 该值
  r6Min: { topology: 120, purpose: 120, responsibility: 200, dependency: 120, assessment: 150 },
  r5Min: { main: 200, branch: 60, exception: 150, data: 100, permission: 60 },
  entryBusinessMin: 60,       // recorded 条目的业务说明下限
  recordedRatioMax: 0.5,      // recorded 占已处理入口点的比例上限
  ruleTraceMin: 0.9,          // 带源码位置的规则比例下限
};

const R6_KEYS = [
  { key: 'topology', label: '架构拓扑' },
  { key: 'purpose', label: '设计目的（为什么）' },
  { key: 'responsibility', label: '各层/各模块职责' },
  { key: 'dependency', label: '模块依赖关系' },
  { key: 'assessment', label: '优势·现存问题·业务适配性' },
];

const R5_KEYS = [
  { key: 'main', label: '主流程' },
  { key: 'branch', label: '分支流程' },
  { key: 'exception', label: '异常流程' },
  { key: 'data', label: '数据流转' },
  { key: 'permission', label: '权限/风控' },
];

const R6_PURPOSE_MUST = ['为什么', '目的', '为了', '因为', '诉求', '当初', '背景', 'why'];
const R6_ASSESSMENT_MUST = ['问题', '瓶颈', '风险', '优势', '适配', '吃力', '隐患', '不足', '局限'];
const R5_EXC_TRIGGER = ['触发', '条件', '当', '如果', '失败', '超时', '异常', '冲突', '不足', '中断', '越权'];
const R5_EXC_RESULT = ['后果', '回退', '回滚', '降级', '通知', '重试', '补偿', '告警', '终态', '变为', '标记为', '拦截', '拒绝'];

/**
 * R12 业务动作词表（references/13-business-deep-reading.md §1.3）。
 * 迁移业务含义行必须至少命中一个——纯状态字面量罗列不会命中任何动词。
 */
const SM_BIZ_VERBS = [
  '任务创建', '创建', '资源占用', '占用', '资源释放', '释放', '执行下发', '下发',
  '执行中断', '中断', '完成回执', '回执', '失败登记', '登记', '补偿回退', '回退',
  '人工介入', '介入', '审核通过', '审核驳回', '审核', '锁定', '解锁', '扣减', '回补',
  '通知触发', '通知', '调度', '认领', '排产', '冻结', '冲销', '回滚', '提交', '确认',
  '分配', '合并', '拆分', '拣选', '上架', '入库', '出库', '盘点', '发货', '收货',
  '启动', '停止', '取消', '触发', '推送给', '写入', '拉起', '指派',
];

/** 源码位置：file:line / 文件名+行号 / L123 */
const SRC_REF_RE = /[\w-]+\.(?:py|java|go|ts|tsx|js|jsx|rs|rb|php|cs|kt|dart|scala|sql)\s*:?\s*\d+|:\s*\d{1,5}\b|第\s*\d+\s*行|L\d{1,5}\b/;

/**
 * R9-9 wiki 结构核心章节（references/06 v2 的 14 章里的必查子集）。
 * keys 是可接受的 data-section / section id 命名（新命名在前，兼容旧命名）。
 */
const WIKI_SECTIONS = [
  { keys: ['business-background', 'background'], label: '业务背景概述' },
  { keys: ['glossary', 'terms'], label: '核心概念与术语表' },
  { keys: ['architecture'], label: '整体架构（R6 五问）' },
  { keys: ['data-model', 'domain-model', 'entities'], label: '数据模型与单据流转' },
  { keys: ['flow-hierarchy', 'flows', 'core-flows'], label: '流程分层清单（含状态业务化）' },
  { keys: ['entry-callchain', 'entry-coverage', 'entries', 'entry-points'], label: '关键代码入口与调用链' },
  { keys: ['pending', 'pending-list', 'conclusion'], label: '结论与待确认清单' },
];

/**
 * R10 占位符黑名单。命中即 error —— "未单列"、"待补" 这类文本出现在交付物里，
 * 说明这一条业务根本没讲；比不写更有害，因为它让读者以为文档已经覆盖了。
 */
const PLACEHOLDERS = [
  // 注意：字符类只用 [^<>]{0,n} 做间隔，不要排除中文标点——
  // "同上触发，未单列" 中间就有一个中文逗号，排除它会导致整类占位符漏检。
  { pat: /同上[^<>]{0,12}?未单列/g, label: '未单列（生成器没解析出触发条件就占位）' },
  { pat: /见(?:数据层|上文|下述|其他|相关)[^<>]{0,10}?说明/g, label: '归堆式占位（"其余见某某说明"）' },
  { pat: /待补(?:充)?(?!齐|全)/g, label: '待补' },
  { pat: /\b(?:TODO|TBD|FIXME)\b/g, label: 'TODO/TBD/FIXME' },
  { pat: /如上图(?:所示)?|如下图所示|见附图/g, label: '伪引用（"如上图所示"没给出任何信息）' },
  { pat: /具体可参考源码|详见(?:接口|设计|需求|其他)?文档/g, label: '伪引用（不给行号就不算写了）' },
  { pat: /略(?:见|述)?(?:上文|下述)/g, label: '略（归堆占位）' },
  { pat: /其余(?:业务)?(?:接口|流程|逻辑)[^<>]{0,12}?(?:类似|同理|同上)/g, label: '"其余同理"（等于没写）' },
];

/* ------------------------------- 工具函数 ------------------------------- */

function makeCheck(id, level = 'error') {
  return { id, level, ok: true, skipped: false, details: [], stats: {} };
}

function failCheck(check, detail) {
  check.ok = false;
  check.details.push(detail);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把 HTML 片段转成可见文本。
 * 顺序很重要：先剥掉 script/style/注释，再剥标签，最后才解实体——
 * 反过来会把 `&lt;` 解出来的 `<` 当成标签误删（条件表达式里很常见）。
 */
function toVisibleText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  // 解两层：`&amp;quot;` → `&quot;` → `"`
  s = s.replace(/&amp;/g, '&');
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  return s.replace(/\s+/g, ' ').trim();
}

/** 只剥标签、保留实体原样，专门用来查转义 bug。 */
function toRawText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const cjkCount = (s) => (s.match(/[\u4e00-\u9fa5]/g) || []).length;

const attr = (attrs, name) => {
  const m = new RegExp(`\\b${escapeRe(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs || '');
  return m ? (m[1] ?? m[2]) : null;
};
const hasAttr = (attrs, name) => new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(attrs || '');

/**
 * 提取元素块。tagRe 是标签名正则（如 'section' 或匹配任意标签的通配模式）。
 * attrFilter 用于在开标签处就筛掉不关心的元素——省掉后续找配对闭标签的扫描，
 * 这是性能关键（356KB 的文档里有几千个元素）。
 */
function extractBlocks(html, tagRe, attrFilter) {
  const blocks = [];
  const openRe = new RegExp(`<(?:/)?${tagRe}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = openRe.exec(html)) !== null) {
    if (m[0].startsWith('</')) continue;
    const attrs = m[1] || '';
    if (attrFilter && !attrFilter(attrs)) continue;
    if (/\/\s*>$/.test(m[0])) continue; // 自闭合
    const tagName = (m[0].match(/^<\s*([a-zA-Z][\w-]*)/) || [, 'div'])[1];
    let depth = 1;
    let end = html.length;
    const scanRe = new RegExp(`<${escapeRe(tagName)}\\b[^>]*>|</${escapeRe(tagName)}\\s*>`, 'gi');
    scanRe.lastIndex = m.index + m[0].length;
    let sm;
    while ((sm = scanRe.exec(html)) !== null) {
      if (sm[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) { end = sm.index; break; }
      } else if (!/\/\s*>$/.test(sm[0])) {
        depth += 1;
      }
    }
    blocks.push({ attrs, start: m.index, end, html: html.slice(m.index, end) });
  }
  return blocks;
}

const ANY_TAG = '(?![/!])[a-zA-Z][\\w-]*';

function contextsOf(text, globalRe, limit = 3) {
  const out = [];
  const re = new RegExp(globalRe.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null && out.length < limit) {
    const from = Math.max(0, m.index - 40);
    out.push(`…${text.slice(from, m.index + m[0].length + 40)}…`);
  }
  return out;
}

/* ------------------------------ 各项检查 ------------------------------ */

function checkEntityEscaping(html, checks) {
  const c = makeCheck('R11_entity_escaping');
  const text = toRawText(html);
  const doubleEsc = text.match(/&amp;(?:quot|lt|gt|nbsp|amp|#\d+);/g) || [];
  const bare = text.match(/&(?:quot|lt|gt|nbsp|amp);/g) || [];
  c.stats = { double_escaped: doubleEsc.length, bare_entity: bare.length };
  if (doubleEsc.length > 0) {
    failCheck(c, `发现 ${doubleEsc.length} 处双重转义（如 &amp;quot;），浏览器正文会直接显示 &quot; 字样 —— 这是可见的排版事故，不是小瑕疵`);
    for (const ctx of contextsOf(text, /&amp;(?:quot|lt|gt|nbsp|amp|#\d+);/g, 3)) c.details.push(`  上下文：${ctx}`);
  }
  checks.push(c);
}

function checkPlaceholders(html, checks) {
  const c = makeCheck('R10_placeholder_zero');
  const text = toRawText(html);
  let total = 0;
  for (const p of PLACEHOLDERS) {
    const hits = text.match(new RegExp(p.pat.source, 'g')) || [];
    if (hits.length === 0) continue;
    total += hits.length;
    failCheck(c, `占位文本【${p.label}】出现 ${hits.length} 次 —— 占位不是"简要带过"，是这条业务压根没讲`);
    for (const ctx of contextsOf(text, p.pat, 3)) c.details.push(`  上下文：${ctx}`);
  }
  c.stats = { placeholder_hits: total };
  checks.push(c);
}

function checkMarkersPresent(html, checks) {
  const c = makeCheck('R9_5_markers_present');
  const hasR5 = /\bdata-r5\b/i.test(html);
  const hasR6 = /\bdata-r6\b/i.test(html);
  const hasFig = /<figure\b/i.test(html) || /arch-caption/i.test(html);
  const hasEntry = /\bdata-entry-(?:id|status)\b/i.test(html);
  const svgCount = (html.match(/<svg\b/gi) || []).length;
  c.stats = { data_r5: hasR5, data_r6: hasR6, figure_or_caption: hasFig, entry_markers: hasEntry, inline_svg: svgCount };
  if (svgCount > 0 && !hasFig && !hasR5 && !hasR6 && !hasEntry) {
    failCheck(c, `文档有 ${svgCount} 段内联 SVG，却完全没有 data-r5 / data-r6 / figure / data-entry-* 任何一种内容深度标记 —— 无法验证"业务讲清楚了没有"，按绕开约定处理，不允许交付。标记约定见 references/12-content-depth-gate.md`);
  }
  checks.push(c);
}

function checkFigureCaptions(html, checks) {
  const c = makeCheck('R9_1_figure_captions');
  const figures = extractBlocks(html, 'figure');
  const slots = (html.match(/arch-slot|arch-chart|arch-figure/gi) || []).length;
  const svgCount = (html.match(/<svg\b/gi) || []).length;
  const captioned = figures.filter((f) => /<figcaption\b|arch-caption/i.test(f.html));

  c.stats = {
    figure_blocks: figures.length, chart_slots: slots, inline_svg: svgCount, with_caption: captioned.length,
  };

  if (svgCount > 0 && figures.length === 0) {
    failCheck(c, `文档有 ${svgCount} 段内联 SVG，但没有一个 <figure> 容器 —— 图没被包进可配图注的结构里，R7 图注无处可查`);
  }

  for (const f of figures) {
    const id = attr(f.attrs, 'data-fig') || attr(f.attrs, 'id') || '(未命名)';
    if (!captioned.includes(f)) {
      failCheck(c, `图「${id}」下方没有图注 —— references/11 §3.3 要求每张图配 200-400 字业务解读`);
      continue;
    }
    const capMatch = f.html.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)
      || f.html.match(/class\s*=\s*["'][^"']*arch-caption[^"']*["'][^>]*>([\s\S]*?)<\//i);
    const text = toVisibleText(capMatch ? capMatch[1] : '');
    if (text.length < TH.figureCaptionMin) {
      failCheck(c, `图「${id}」的图注只有 ${text.length} 可见字符（中文 ${cjkCount(text)} 字），不足 ${TH.figureCaptionMin} —— 图本身不是解读，图注才是`);
    }
  }

  // 章节级"图代文"检测
  for (const s of extractBlocks(html, 'section')) {
    const n = (s.html.match(/<svg\b/gi) || []).length;
    if (n === 0) continue;
    const id = attr(s.attrs, 'id') || attr(s.attrs, 'data-section') || '(未命名)';
    const text = toVisibleText(s.html);
    const need = n * TH.chapterTextPerFigure;
    if (text.length < need) {
      failCheck(c, `章节「${id}」有 ${n} 张图，整个章节可见正文却只有 ${text.length} 字符（中文 ${cjkCount(text)} 字），低于 ${need} —— 图占了体积没占内容，典型"图代文"`);
    }
  }
  checks.push(c);
}

function checkArchitecture(html, checks) {
  const c = makeCheck('R9_2_r6_architecture');
  const blocks = extractBlocks(html, ANY_TAG, (a) => hasAttr(a, 'data-r6'));
  const byKey = new Map();
  for (const b of blocks) {
    const k = (attr(b.attrs, 'data-r6') || '').trim();
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
  }
  c.stats = { found: [...byKey.keys()], counts: Object.fromEntries([...byKey].map(([k, v]) => [k, v.length])) };

  if (blocks.length === 0) {
    failCheck(c, '架构章节没有任何 data-r6 标记子块 —— 无法验证 R6 五问是否回答。按 references/12 的约定给架构章节五个小节各加 data-r6="topology|purpose|responsibility|dependency|assessment"');
    checks.push(c);
    return;
  }

  for (const { key, label } of R6_KEYS) {
    const list = byKey.get(key);
    if (!list || list.length === 0) {
      failCheck(c, `R6 缺「${label}」一问 —— 五问必须全部答出，缺一问就是给新人留个认知空洞`);
      continue;
    }
    const text = toVisibleText(list.map((b) => b.html).join(' '));
    const min = TH.r6Min[key] ?? 100;
    if (text.length < min) {
      failCheck(c, `R6「${label}」只有 ${text.length} 可见字符（中文 ${cjkCount(text)} 字），低于 ${min} —— 这一问等于没答`);
      continue;
    }
    if (key === 'purpose' && !R6_PURPOSE_MUST.some((w) => text.includes(w))) {
      failCheck(c, `R6「${label}」通篇没出现「${R6_PURPOSE_MUST.join('/')}」任何一个词 —— 只写"是什么"不写"为什么"，等于没回答设计目的`);
    }
    if (key === 'assessment' && !R6_ASSESSMENT_MUST.some((w) => text.includes(w))) {
      failCheck(c, `R6「${label}」通篇没出现「${R6_ASSESSMENT_MUST.join('/')}」任何一个词 —— 只夸优势不写现存问题/瓶颈，新人判断不了这个系统还能扛多久`);
    }
  }
  checks.push(c);
}

function checkFlows(html, checks) {
  const c = makeCheck('R9_3_r5_flows');
  const flows = extractBlocks(html, ANY_TAG, (a) => hasAttr(a, 'data-flow'));
  c.stats = { flows: flows.map((f) => attr(f.attrs, 'data-flow') || '(未命名)') };

  if (flows.length === 0) {
    failCheck(c, '文档没有任何 data-flow 标记的流程块 —— 无法验证 R5 五维度。按 references/12 的约定给每条核心流程加 data-flow="<流程名>"，内部五个维度各加 data-r5="main|branch|exception|data|permission"');
    checks.push(c);
    return;
  }

  for (const flow of flows) {
    const name = attr(flow.attrs, 'data-flow') || '(未命名)';
    const byKey = new Map();
    for (const d of extractBlocks(flow.html, ANY_TAG, (a) => hasAttr(a, 'data-r5'))) {
      const k = (attr(d.attrs, 'data-r5') || '').trim();
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(d);
    }
    for (const { key, label } of R5_KEYS) {
      const list = byKey.get(key);
      if (!list || list.length === 0) {
        failCheck(c, `流程「${name}」缺 R5 维度「${label}」 —— 五维度缺一不可，漏异常和权限是最常见的空洞`);
        continue;
      }
      const text = toVisibleText(list.map((b) => b.html).join(' '));
      const min = TH.r5Min[key] ?? 60;
      if (text.length < min) {
        failCheck(c, `流程「${name}」的「${label}」只有 ${text.length} 可见字符（中文 ${cjkCount(text)} 字），低于 ${min}`);
        continue;
      }
      if (key === 'exception') {
        if (!R5_EXC_TRIGGER.some((w) => text.includes(w))) {
          failCheck(c, `流程「${name}」的异常维度没写触发条件（缺「${R5_EXC_TRIGGER.join('/')}」任一表述）`);
        }
        if (!R5_EXC_RESULT.some((w) => text.includes(w))) {
          failCheck(c, `流程「${name}」的异常维度没写业务后果（缺「${R5_EXC_RESULT.join('/')}」任一表述）—— "失败则报错"不算写了后果`);
        }
      }
    }
  }
  checks.push(c);
}

function checkRecorded(html, checks, opts) {
  const c = makeCheck('R9_4_recorded_expansion');
  const entryEls = extractBlocks(html, ANY_TAG, (a) => hasAttr(a, 'data-entry-status') || hasAttr(a, 'data-entry-id'));
  const recordedEls = entryEls.filter((b) => (attr(b.attrs, 'data-entry-status') || '').trim() === 'recorded');
  c.stats = { entry_elements: entryEls.length, recorded_elements: recordedEls.length };

  const weak = [];
  for (const el of recordedEls) {
    const id = attr(el.attrs, 'data-entry-id') || '(未命名)';
    const biz = el.html.match(/class\s*=\s*["'][^"']*entry-business[^"']*["'][^>]*>([\s\S]*?)<\//i);
    const text = toVisibleText(biz ? biz[1] : el.html);
    if (text.length < TH.entryBusinessMin) weak.push(`${id}（${text.length} 字符）`);
  }
  if (weak.length > 0) {
    failCheck(c, `${weak.length} 条 recorded 入口点的业务说明不足 ${TH.entryBusinessMin} 可见字符：${weak.slice(0, 10).join('、')}${weak.length > 10 ? ` …以及另外 ${weak.length - 10} 条` : ''} —— "小业务一句话带过"正是漏讲业务的主因`);
  }

  if (opts.coverage) {
    const total = opts.coverage.total ?? 0;
    const recorded = opts.coverage.breakdown?.recorded ?? 0;
    const denom = opts.coverage.reviewed || total || 1;
    const ratio = recorded / denom;
    c.stats.recorded_ratio = Number(ratio.toFixed(4));
    if (ratio > TH.recordedRatioMax) {
      failCheck(c, `recorded 占已处理入口点的 ${(ratio * 100).toFixed(1)}%（${recorded}/${denom}），超过 ${TH.recordedRatioMax * 100}% 上限 —— 一半以上业务被"简单记录"带过，等于没讲清楚；CRUD 类至少展开成"输入 / 输出 / 业务目的 / 失败边界"四列`);
    }
  }

  if (opts.entries) {
    const list = opts.entries.entryPoints || [];
    const recordedList = list.filter((e) => e.status === 'recorded');
    const docIds = new Set(entryEls.map((b) => attr(b.attrs, 'data-entry-id')).filter(Boolean));
    const missing = recordedList.filter((e) => e.id && !docIds.has(e.id));
    c.stats.recorded_in_manifest = recordedList.length;
    c.stats.recorded_missing_in_doc = missing.length;
    if (recordedList.length > 0 && entryEls.length === 0) {
      failCheck(c, '入口点清单里有 recorded 条目，但文档里没有任何 data-entry-id / data-entry-status 标记 —— 无法验证小业务是否展开');
    } else if (missing.length > 0) {
      failCheck(c, `清单里有 ${missing.length} 条 recorded 入口点在文档里找不到对应条目：${missing.slice(0, 8).map((e) => e.id).join('、')}`);
    }
  }
  checks.push(c);
}

function checkRuleTraceability(html, checks) {
  const c = makeCheck('R9_6_rule_traceability', 'warn');
  const rules = extractBlocks(html, ANY_TAG, (a) => hasAttr(a, 'data-rule'));
  c.stats = { rules: rules.length };
  if (rules.length === 0) {
    // 跳过 ≠ 通过。标记不存在时不给绿勾，否则"没按约定写"会看起来像"检查通过"。
    c.skipped = true;
    c.details.push('未发现 data-rule 标记，跳过规则可追溯性检查 —— 按 references/12 给每条规则加 data-rule="<规则名>" 才能真正验证 R2');
    checks.push(c);
    return;
  }
  const untraced = [];
  for (const r of rules) {
    if (!SRC_REF_RE.test(toVisibleText(r.html))) untraced.push(attr(r.attrs, 'data-rule') || '(未命名)');
  }
  c.stats.traced = rules.length - untraced.length;
  const rate = (rules.length - untraced.length) / rules.length;
  if (rate < TH.ruleTraceMin) {
    failCheck(c, `${untraced.length}/${rules.length} 条业务规则没有源码位置（file:line 或文件名+行号），低于 ${TH.ruleTraceMin * 100}% 门槛：${untraced.slice(0, 10).join('、')}`);
  }
  checks.push(c);
}

/**
 * R9-7 状态业务化（R12）。
 * 两级防线：
 *  1) 有 data-sm 标记 → 逐台检查状态业务定义（每状态 ≥20 字符）与
 *     迁移业务含义（每条 ≥40 字符且含业务动词）。
 *  2) 全文没有 data-sm → 扫描可见正文里的裸字面量流转（`unknown → running`，
 *     排除 <code>/<pre> 内的代码），命中即报错——这正是 Russh 实测事故的形态，
 *     不允许"没有标记"看起来像"没有状态机"。
 */
function checkStateMachines(html, checks) {
  const c = makeCheck('R9_7_sm_business');
  // 注意：必须用 attr 精确匹配 data-sm，hasAttr 的 \bdata-sm\b 会把
  // data-sm-state / data-sm-tx 也误当成状态机容器。
  const sms = extractBlocks(html, ANY_TAG, (a) => attr(a, 'data-sm') !== null);
  c.stats = { state_machines: sms.length };

  if (sms.length === 0) {
    const raw = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(?:code|pre)[\s\S]*?<\/(?:code|pre)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ');
    const bareRe = /(?:^|[|\s(>])([a-z][a-z0-9_]{1,24})\s*(?:→|->)\s*([a-z][a-z0-9_]{1,24})/g;
    const bare = raw.match(bareRe) || [];

    // 形态 2（Russh 实测事故的真实形态）：archify 状态图把迁移编码成
    // data-edge-from="pending" / data-edge-to="running" 属性，可见文本里没有箭头。
    // 用状态词表过滤，避免把架构图里的模块连线（节点名不是状态词）误伤。
    const STATE_LIKE = /^(unknown|pending|running|created|init|initial|waiting|queued|active|success|succeeded|failed|failure|partial|canceled|cancelled|complete|completed|done|error|timeout|expired|locked|unlocked|closed|open|resolved|rejected|approved|draft|stopped|paused|aborted|rollback(ed)?|retrying|dispatched)$/i;
    const smEdges = [];
    const tagRe = /<[^>]*>/g;
    let tm;
    while ((tm = tagRe.exec(html)) !== null) {
      const f = attr(tm[0], 'data-edge-from');
      const t = attr(tm[0], 'data-edge-to');
      if (f && t && STATE_LIKE.test(f) && STATE_LIKE.test(t)) smEdges.push(`${f} → ${t}`);
    }

    c.stats.bare_literal_transitions = bare.length;
    c.stats.sm_edge_literal_pairs = smEdges.length;
    if (bare.length > 0 || smEdges.length > 0) {
      const sample = [...bare.map((s) => s.trim()), ...smEdges].slice(0, 3).join('、');
      failCheck(c, `文档没有任何 data-sm 状态机标记，却存在 ${bare.length + smEdges.length} 处裸字面量流转（如 ${sample}）—— 状态字面量照抄不是业务讲解，"unknown 是什么、谁触发的、流转完业务世界什么变了"一个都没回答（R12，references/13 §1.2）。修法：给状态机章节加 data-sm，补状态业务定义表与迁移业务含义表`);
    }
    checks.push(c);
    return;
  }

  for (const sm of sms) {
    const name = attr(sm.attrs, 'data-sm') || '(未命名)';
    const states = extractBlocks(sm.html, ANY_TAG, (a) => hasAttr(a, 'data-sm-state'));
    const txs = extractBlocks(sm.html, ANY_TAG, (a) => hasAttr(a, 'data-sm-tx'));
    c.stats[`${name}:states`] = states.length;
    c.stats[`${name}:transitions`] = txs.length;

    if (states.length === 0) {
      failCheck(c, `状态机「${name}」没有状态业务定义表 —— R12 要求每个状态先回答"此刻业务世界里什么是真的"，迁移表放在定义表之后（references/13 §1.2）`);
    }
    for (const s of states) {
      const sid = attr(s.attrs, 'data-sm-state') || '(未命名)';
      const text = toVisibleText(s.html);
      if (text.length < 20) {
        failCheck(c, `状态机「${name}」的状态「${sid}」业务定义只有 ${text.length} 字符（要求 ≥20）—— "running 就是运行中"这类复述不算定义`);
      }
    }
    if (txs.length === 0) {
      failCheck(c, `状态机「${name}」没有迁移业务含义行（data-sm-tx）—— 只有图和状态定义没有迁移讲解，等于把翻译工作留给了读者`);
      continue;
    }
    for (const t of txs) {
      const tid = attr(t.attrs, 'data-sm-tx') || '(未命名)';
      const text = toVisibleText(t.html);
      if (text.length < 40) {
        failCheck(c, `状态机「${name}」的迁移「${tid}」业务含义只有 ${text.length} 字符（要求 ≥40）—— 需要触发者 + 业务动作 + 业务意义三要素`);
        continue;
      }
      if (!SM_BIZ_VERBS.some((v) => text.includes(v))) {
        failCheck(c, `状态机「${name}」的迁移「${tid}」通篇没有业务动词（${SM_BIZ_VERBS.slice(0, 8).join('/')}…任一）—— 疑似只罗列了状态字面量和方法名`);
      }
      if (!SRC_REF_RE.test(text)) {
        c.level = 'warn';
        failCheck(c, `状态机「${name}」的迁移「${tid}」没有代码位置（file:line）—— R12 迁移表第七列缺失，读者无法回源码验证`);
      }
    }
  }
  checks.push(c);
}

/**
 * R9-8 流程分层（R13）：main/system 层的流程必须有 sub 子流程，
 * 子流程必须有调用链（file:line）与 ≥30 字符的职责说明。
 */
function checkFlowLevels(html, checks) {
  const c = makeCheck('R9_8_flow_levels');
  const flows = extractBlocks(html, ANY_TAG, (a) => hasAttr(a, 'data-flow'));
  const withLevel = flows.filter((f) => hasAttr(f.attrs, 'data-level'));
  c.stats = { flows: flows.length, with_level: withLevel.length };

  if (flows.length > 0 && withLevel.length === 0) {
    c.level = 'warn';
    failCheck(c, `${flows.length} 个 data-flow 流程块都没有 data-level 层级标记 —— R13 四层拆解（系统级→主流程→子流程→关键方法）无从验证；给主流程加 data-level="main"、子流程加 data-level="sub"（references/13 §2）`);
  }

  for (const f of withLevel) {
    const name = attr(f.attrs, 'data-flow') || '(未命名)';
    const lvl = (attr(f.attrs, 'data-level') || '').trim();
    if (lvl !== 'main' && lvl !== 'system') continue;
    const subs = extractBlocks(f.html, ANY_TAG, (a) => (attr(a, 'data-level') || '').trim() === 'sub');
    if (subs.length === 0) {
      failCheck(c, `流程「${name}」标注为 ${lvl} 层，但没有任何 data-level="sub" 子流程 —— 主流程只有概述没有环节拆解，等于只有目录没有内容（R13）`);
      continue;
    }
    for (const s of subs) {
      const sub = attr(s.attrs, 'data-subflow') || '(未命名)';
      const text = toVisibleText(s.html);
      if (text.length < 30) {
        failCheck(c, `流程「${name}」的子流程「${sub}」只有 ${text.length} 字符（要求 ≥30）—— 缺"抽掉它整体业务断在哪"的职责说明`);
      }
      if (!SRC_REF_RE.test(text)) {
        failCheck(c, `流程「${name}」的子流程「${sub}」没有调用链（file:line）—— R13 要求子流程能回到代码，调用链底座用 codegraph callers/callees，不许凭目录结构猜`);
      }
    }
  }
  checks.push(c);
}

/**
 * R9-9 wiki 结构完整性（references/06 v2 的 14 章结构）。
 * warn 级：小型项目可有意识省略，但要在第 00 章写明省略原因。
 */
function checkWikiStructure(html, checks) {
  const c = makeCheck('R9_9_wiki_structure', 'warn');
  const found = new Set();
  for (const s of extractBlocks(html, 'section')) {
    const v = attr(s.attrs, 'data-section') || attr(s.attrs, 'id');
    if (v) found.add(String(v).toLowerCase());
  }
  c.stats = { sections_found: [...found] };
  const missing = WIKI_SECTIONS.filter((w) => ![...found].some((f) => w.keys.some((k) => f === k || f.includes(k) || k.includes(f))));
  c.stats.missing = missing.map((w) => w.label);
  if (missing.length > 0) {
    failCheck(c, `wiki 结构缺少 ${missing.length} 个核心章节：${missing.map((w) => w.label).join('、')}。小型项目可有意识省略，但要在第 00 章文档信息里写明省略原因（references/06 v2 的 14 章结构）`);
  }
  checks.push(c);
}

/* --------------------------------- 主流程 --------------------------------- */

export function run(htmlPath, opts = {}) {
  const checks = [];
  let html;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (err) {
    const c = makeCheck('file_readable');
    failCheck(c, err.message);
    checks.push(c);
    return {
      ok: false,
      has_error: true,
      file: htmlPath,
      strict: !!opts.strict,
      counts: { error: 1, warning: 0, passed: 0 },
      summary: { visible_chars: 0, cjk_chars: 0, inline_svg: 0 },
      checks,
    };
  }

  checkEntityEscaping(html, checks);
  checkPlaceholders(html, checks);
  checkMarkersPresent(html, checks);
  checkFigureCaptions(html, checks);
  checkArchitecture(html, checks);
  checkFlows(html, checks);
  checkStateMachines(html, checks);
  checkFlowLevels(html, checks);
  checkRecorded(html, checks, opts);
  checkRuleTraceability(html, checks);
  checkWikiStructure(html, checks);

  const errors = checks.filter((c) => !c.ok && c.level === 'error');
  const warns = checks.filter((c) => !c.ok && c.level === 'warn');
  const strict = !!opts.strict;
  const hasError = errors.length > 0 || (strict && warns.length > 0);
  const visible = toVisibleText(html);

  return {
    ok: !hasError,
    file: htmlPath,
    has_error: hasError,
    strict,
    counts: {
      error: errors.length,
      warning: warns.length,
      passed: checks.filter((c) => c.ok && !c.skipped).length,
      skipped: checks.filter((c) => c.skipped).length,
    },
    summary: {
      visible_chars: visible.length,
      cjk_chars: cjkCount(visible),
      inline_svg: (html.match(/<svg\b/gi) || []).length,
    },
    checks,
  };
}

function parseArgs(argv) {
  const opts = { coverage: null, entries: null, report: null, strict: false, json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--strict') opts.strict = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--coverage') opts.coverage = argv[++i];
    else if (a === '--entries') opts.entries = argv[++i];
    else if (a === '--report') opts.report = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else positional.push(a);
  }
  opts.input = positional[0];
  return opts;
}

function readJson(p, label) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`⚠️ 无法读取${label} ${p}：${err.message}（相关检查会跳过）`);
    return null;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    console.error('用法: node scripts/check-content-depth.mjs <final.html> [--coverage report.json] [--entries entry-points.json] [--report out.json] [--strict] [--json]');
    process.exit(opts.help ? 0 : 2);
  }
  const htmlPath = path.resolve(opts.input);
  const coverage = opts.coverage ? readJson(path.resolve(opts.coverage), '覆盖率报告') : null;
  const entries = opts.entries ? readJson(path.resolve(opts.entries), '入口点清单') : null;

  const result = run(htmlPath, { coverage, entries, strict: opts.strict });

  if (opts.report) fs.writeFileSync(path.resolve(opts.report), JSON.stringify(result, null, 2), 'utf8');

  const tag = (c) => (c.skipped ? '○' : (c.ok ? '✓' : (c.level === 'warn' ? '⚠' : '✗')));
  const state = (c) => (c.skipped ? '跳过' : (c.ok ? '通过' : `${c.level === 'warn' ? '警告' : '不合格'}（${c.details.length} 条）`));
  console.log(`内容深度门禁：${result.file}`);
  console.log(`  正文可见字符 ${result.summary.visible_chars}（中文 ${result.summary.cjk_chars}）· 内联图 ${result.summary.inline_svg} 张`);
  console.log('');
  for (const c of result.checks) {
    console.log(`  ${tag(c)} [${c.id}] ${state(c)}`);
    for (const d of c.details) console.log(`      ${d}`);
  }
  console.log('');
  console.log(`结果：${result.counts.passed} 通过 / ${result.counts.error} 不合格 / ${result.counts.warning} 警告 / ${result.counts.skipped} 跳过`);
  console.log(result.has_error
    ? '⛔ 有 error 项，不允许交付 —— "能打开"不等于"讲清楚了"'
    : '✅ 内容深度达标');

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  process.exit(result.has_error ? 1 : 0);
}

main();
