#!/usr/bin/env node
/**
 * expand-recorded.mjs
 *
 * 把入口点清单里"被一句话带过"的条目，摊成一张**可以逐条补写**的表格骨架。
 *
 * 为什么需要它：recorded 原本的定义是"业务逻辑单薄，一行归类说明即可"。
 * 这个定义被实测证明是有害的——Russh 项目 38 个入口点里 29 个被标成 recorded，
 * 文档对它们的全部交代是架构章节的一句"其余业务 API 见数据层说明"。
 * 漏业务的地方从来不是主流程，正是这些"看起来不重要"的角落。
 *
 * 光把 recorded 的定义改严还不够——面对 29 条待展开的条目，没有骨架就还是会
 * 偷懒。这个脚本把每条摊成一行，把能从代码里确定性得到的部分（源码位置、
 * 入口点形状、所属模块）预先填好，只留真正需要人来写的四要素空着，
 * 并给出按资源分组的建议，让"逐条补"变成可执行的动作。
 *
 * 输入：scan-entry-points.mjs 产出的入口点清单（status 已定稿）
 * 输出：Markdown 表格骨架
 *
 * 用法：
 *   node scripts/expand-recorded.mjs <entry-points.json> [输出路径]
 *   node scripts/expand-recorded.mjs <entry-points.json> --status recorded,flagged
 * 退出码：
 *   0  正常
 *   1  recorded 占比超过 50%（R9-4 上限），表格照样生成，但提醒你要重新分类
 *   2  用法错误 / 文件读不到
 */

import fs from 'node:fs';
import path from 'node:path';

const RECORDED_RATIO_MAX = 0.5;

function parseArgs(argv) {
  const opts = { status: ['recorded'], out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--status') opts.status = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '-h' || a === '--help') opts.help = true;
    else positional.push(a);
  }
  opts.input = positional[0];
  opts.out = positional[1] || null;
  return opts;
}

/** 从文件路径里提取"模块"——用于按资源分组建议。 */
function moduleOf(file) {
  if (!file) return '(未知)';
  const parts = file.replace(/\\/g, '/').split('/');
  if (parts.length <= 1) return '(根目录)';
  // 取倒数第二层目录，比文件名稳定（api/nodes.py → api）
  return parts[parts.length - 2] || parts[0];
}

/** 从 detail 里猜 HTTP 方法与路径，猜不到就原样返回。 */
function shapeOf(entry) {
  const d = entry.detail || '';
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i.exec(d);
  if (m) return { method: m[1].toUpperCase(), path: m[2] };
  const t = entry.type || '';
  if (t === 'cron' || /schedul|cron/i.test(d)) return { method: '定时', path: d };
  if (t === 'websocket') return { method: 'WS', path: d };
  return { method: (t || '—').toUpperCase(), path: d };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    console.error('用法: node scripts/expand-recorded.mjs <entry-points.json> [输出路径] [--status recorded,flagged]');
    process.exit(opts.help ? 0 : 2);
  }

  const manifest = JSON.parse(fs.readFileSync(path.resolve(opts.input), 'utf8'));
  const entries = manifest.entryPoints || [];
  const total = entries.length;
  const byStatus = {};
  for (const e of entries) byStatus[e.status || 'unreviewed'] = (byStatus[e.status || 'unreviewed'] || 0) + 1;

  const recorded = entries.filter((e) => e.status === 'recorded');
  const reviewed = entries.filter((e) => e.status && e.status !== 'unreviewed').length;
  const denom = reviewed || total || 1;
  const ratio = recorded.length / denom;

  const targets = entries.filter((e) => opts.status.includes(e.status));

  // 按模块分组，给"按资源分组展开"的建议
  const groups = new Map();
  for (const e of targets) {
    const m = moduleOf(e.file);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(e);
  }

  const L = [];
  L.push('# 待展开业务清单（recorded / flagged 补写骨架）');
  L.push('');
  L.push(`> 由 \`scripts/expand-recorded.mjs\` 从 \`${path.basename(opts.input)}\` 生成。`);
  L.push('> 这些条目在文档里原本是被一句话带过的。四要素填完之前，这份文档没有覆盖到它们。');
  L.push('');
  L.push('## 现状');
  L.push('');
  L.push(`- 入口点总数 **${total}**，已定稿 **${reviewed}**`);
  L.push(`- detailed ${byStatus.detailed || 0} / recorded ${byStatus.recorded || 0} / flagged ${byStatus.flagged || 0} / 未处理 ${byStatus.unreviewed || 0}`);
  L.push(`- **recorded 占比 ${(ratio * 100).toFixed(1)}%**（上限 ${RECORDED_RATIO_MAX * 100}%${ratio > RECORDED_RATIO_MAX ? '，**已超标**' : ''}）`);
  L.push('');
  if (ratio > RECORDED_RATIO_MAX) {
    L.push(`> ⚠️ recorded 占比超过 ${RECORDED_RATIO_MAX * 100}%，\`check-content-depth.mjs\`（R9-4）会直接判不合格。`);
    L.push('> 这通常不是因为业务真的都这么简单，而是**分类粒度太粗**：把几个本该 `detailed` 的流程合并成了 `recorded`，');
    L.push('> 或者根本没看进去就标了。两条出路：把确实复杂的改成 `detailed` 走完整五维度；或者按下面的分组**整组展开**。');
    L.push('');
  }
  L.push('## 补写要求（每条 recorded 都要达到）');
  L.push('');
  L.push('- **业务目的**：谁在什么场景下用它、用来达成什么');
  L.push('- **输入 / 输出**：关键入参与返回内容');
  L.push('- **失败边界**：最容易踩的坑、失败时是什么表现、有没有静默失败');
  L.push('- 每条 **≥60 可见字符**，落进最终 HTML 时带 `data-entry-id` 与 `data-entry-status="recorded"`');
  L.push('- 模板与示例见 `references/12-content-depth-gate.md` §3.2，骨架见 `examples/content-depth-pass-sample.html`');
  L.push('');

  // 分组建议
  if (groups.size > 1) {
    L.push('## 分组建议（CRUD 密集的可以整组展开，不用逐条硬写）');
    L.push('');
    for (const [mod, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      L.push(`- **${mod}**（${list.length} 条）：${list.slice(0, 5).map((e) => shapeOf(e).path).join('、')}${list.length > 5 ? ' 等' : ''}`);
    }
    L.push('');
    L.push('> 整组展开的写法："这一组接口共同完成 X 的维护，其中 A 是软删、B 带分页、C 失败时返回空列表而非报错…"');
    L.push('> ——这仍然是逐条交代，不是"其余同理"。');
    L.push('');
  }

  L.push('## 逐条骨架');
  L.push('');
  L.push('| # | ID | 方法 | 路径 / 说明 | 源码位置 | 业务目的（待填） | 输入（待填） | 输出（待填） | 失败边界（待填） |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  targets.forEach((e, i) => {
    const s = shapeOf(e);
    const src = e.file ? `\`${e.file}:${e.line ?? '?'}\`` : '—';
    L.push(`| ${i + 1} | ${e.id || '(无 id)'} | ${s.method} | ${s.path || '—'} | ${src} |  |  |  |  |`);
  });
  L.push('');
  L.push('> 填完四要素后，把这张表落进最终 HTML 的第 07 章，`check-content-depth.mjs` 会逐条核对');
  L.push('> `data-entry-id` 是否齐全、业务说明是否达标。占位符（"未单列"、"其余见某某说明"、"待补"）会被 R10 拦下。');
  L.push('');

  const md = L.join('\n');
  if (opts.out) {
    fs.writeFileSync(path.resolve(opts.out), md, 'utf8');
    console.log(`已生成 ${opts.out}`);
  } else {
    console.log(md);
  }

  console.log(`\n统计：total ${total} / reviewed ${reviewed} / recorded ${recorded.length}（${(ratio * 100).toFixed(1)}%）/ 本次摊开 ${targets.length} 条`);
  if (ratio > RECORDED_RATIO_MAX) {
    console.log(`⚠️ recorded 占比超过 ${RECORDED_RATIO_MAX * 100}%，需要重新分类或按组展开，否则 R9-4 会判不合格`);
    process.exit(1);
  }
}

main();
