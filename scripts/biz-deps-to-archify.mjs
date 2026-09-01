#!/usr/bin/env node
/**
 * biz-deps-to-archify.mjs
 *
 * 二次开发适配层：把本 skill Phase 1 提取出的模块依赖图（结构化 JSON，
 * 见 references/01-extraction.md）自动转换成 archify 的 architecture diagram spec。
 * 域标签（Phase 0，见 references/08-domain-segmentation.md）直接映射成 archify 的
 * boundaries（域边界框），不用额外发明一套域可视化方案。
 *
 * 输入格式：
 * {
 *   "title": "订单服务架构",
 *   "nodes": [
 *     { "id": "order-api", "label": "订单接口", "kind": "backend", "domain": "交易域" },
 *     { "id": "order-db", "label": "订单库",   "kind": "database", "domain": "交易域" },
 *     { "id": "inventory-svc", "label": "库存服务", "kind": "backend", "domain": "库存域" }
 *   ],
 *   "edges": [
 *     { "from": "order-api", "to": "order-db", "label": "读写" },
 *     { "from": "order-api", "to": "inventory-svc", "label": "扣减库存(HTTP)" }
 *   ]
 * }
 *
 * kind 取值映射到 archify 的 component.type：
 *   frontend / backend / database / cloud / security / messagebus / external
 *   （不在这个集合里的 kind 一律降级为 backend，并不代表这个映射一定准确——
 *    Phase 1 提取阶段最好直接产出这几个语义类型之一，不要留给转换脚本瞎猜）
 *
 * 布局策略：按 domain 分列（同域节点同一列），列内按依赖深度分行——
 * 这是一个能过 schema、大概率能避免同域节点重叠的默认网格布局，不是最终审美意义上的
 * 最优排布。真实代码库的依赖关系通常比这复杂，validate 报出具体的 crossing/spacing
 * 诊断后，照 archify 的 SKILL.md 建议加 fromSide/toSide/via 手动精修，
 * 尤其是跨域连线（连线数量多、跨列距离远时最容易被诊断标记）。
 *
 * 用法：
 *   node biz-deps-to-archify.mjs <input.json> <output-spec.json>
 */

import fs from 'node:fs';

const ALLOWED_TYPES = new Set(['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external']);

const COL_WIDTH = 220;
const ROW_HEIGHT = 130;
const MARGIN_X = 60;
const MARGIN_Y = 60;
const NODE_SIZE = [160, 70];

function convert(input) {
  if (!input.title || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new Error('输入缺少 title / nodes / edges 字段，检查 Phase 1 提取产出的中间数据格式');
  }

  // 按 domain 分组决定列号；没有 domain 的节点归到一个默认的"未分类"列。
  const domains = [];
  const domainIndex = new Map();
  for (const n of input.nodes) {
    const d = n.domain || '未分类';
    if (!domainIndex.has(d)) {
      domainIndex.set(d, domains.length);
      domains.push(d);
    }
  }

  // 列内按当前已放置的节点数决定行号，简单从上到下堆叠。
  const rowCounter = new Map(domains.map((d) => [d, 0]));

  const components = input.nodes.map((n) => {
    const domain = n.domain || '未分类';
    const col = domainIndex.get(domain);
    const row = rowCounter.get(domain);
    rowCounter.set(domain, row + 1);

    const type = ALLOWED_TYPES.has(n.kind) ? n.kind : 'backend';

    return {
      id: n.id,
      type,
      label: n.label,
      ...(n.sublabel ? { sublabel: n.sublabel } : {}),
      pos: [MARGIN_X + col * COL_WIDTH, MARGIN_Y + row * ROW_HEIGHT],
      size: NODE_SIZE,
    };
  });

  const connections = input.edges.map((e, i) => ({
    id: e.id || `${e.from}-to-${e.to}-${i}`,
    from: e.from,
    to: e.to,
    ...(e.label ? { label: e.label } : {}),
    // 不预设 fromSide/toSide/via——让 archify 走自动路由，
    // 只有 validate 报出具体诊断时才按需要加覆盖字段（见模块顶部说明）。
  }));

  // 每个 domain 一个 boundary，直接对应 Phase 0 的业务域划分——
  // 域边界在图上就是一个可视化的框，域内节点用 `wraps` 列出。
  const boundaries = domains
    .map((d) => ({
      kind: 'region',
      label: d,
      wraps: input.nodes.filter((n) => (n.domain || '未分类') === d).map((n) => n.id),
    }))
    .filter((b) => b.wraps.length > 1); // 只有一个节点的域没必要画框，留白即可

  const spec = {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: input.title,
      quality_profile: 'showcase',
      ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    },
    components,
    connections,
  };
  if (boundaries.length) spec.boundaries = boundaries;

  return spec;
}

function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('用法: node biz-deps-to-archify.mjs <input.json> <output-spec.json>');
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const spec = convert(input);
  fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf8');
  console.log(`已生成 archify architecture spec 候选：${outputPath}`);
  console.log('下一步：node assets/archify/bin/archify.mjs validate architecture ' + outputPath + ' --quality showcase --json');
}

main();
