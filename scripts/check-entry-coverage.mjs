#!/usr/bin/env node
/**
 * check-entry-coverage.mjs
 *
 * 配合 scan-entry-points.mjs 使用。人工 review 完扫描结果、把每条的 status
 * 从 unreviewed 改成 detailed/recorded/flagged 三态之一后，用这个脚本生成一份
 * 覆盖率报告——交付前自检用，也可以直接作为文档里"入口点覆盖率"一节的原始数据。
 *
 * 输入：scan-entry-points.mjs 产出的 manifest（要求每条的 status 已经不是
 * unreviewed，还剩 unreviewed 的会被单独列出来，因为这些是"扫描到了但还没人看过"）
 *
 * 用法：
 *   node check-entry-coverage.mjs <reviewed-entry-points.json> <report.json>
 */

import fs from 'node:fs';

const VALID_STATUSES = new Set(['detailed', 'recorded', 'flagged']);

function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('用法: node check-entry-coverage.mjs <reviewed-entry-points.json> <report.json>');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const entries = manifest.entryPoints || [];

  const stillUnreviewed = entries.filter((e) => e.status === 'unreviewed');
  const detailed = entries.filter((e) => e.status === 'detailed');
  const recorded = entries.filter((e) => e.status === 'recorded');
  const flagged = entries.filter((e) => e.status === 'flagged');
  const invalidStatus = entries.filter((e) => e.status && !VALID_STATUSES.has(e.status) && e.status !== 'unreviewed');

  const total = entries.length;
  const reviewed = total - stillUnreviewed.length;
  const coverageRate = total === 0 ? 1 : reviewed / total;

  const report = {
    generatedAt: new Date().toISOString(),
    sourceManifest: inputPath,
    total,
    reviewed,
    coverageRate: Number(coverageRate.toFixed(4)),
    coveragePercent: `${(coverageRate * 100).toFixed(1)}%`,
    breakdown: {
      detailed: detailed.length,
      recorded: recorded.length,
      flagged: flagged.length,
      stillUnreviewed: stillUnreviewed.length,
    },
    // 交付前自检应该重点看这两份列表——不是"总体百分比达标就行"，
    // 而是每一条没处理的都要能点名，不能只看汇总数字。
    stillUnreviewedList: stillUnreviewed.map((e) => ({ id: e.id, file: e.file, line: e.line, detail: e.detail })),
    invalidStatusList: invalidStatus.map((e) => ({ id: e.id, status: e.status })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`覆盖率：${report.coveragePercent}（${reviewed}/${total}）`);
  console.log(`详细梳理 ${detailed.length} / 简单记录 ${recorded.length} / 标记待确认 ${flagged.length} / 未处理 ${stillUnreviewed.length}`);
  if (stillUnreviewed.length > 0) {
    console.log('⚠️ 仍有未处理的入口点，交付前必须逐条处理或明确说明原因，不能直接交付：');
    for (const e of stillUnreviewed.slice(0, 20)) {
      console.log(`   - ${e.id}  ${e.detail || ''}`);
    }
    if (stillUnreviewed.length > 20) console.log(`   ...以及另外 ${stillUnreviewed.length - 20} 条`);
  }
  if (invalidStatus.length > 0) {
    console.log(`⚠️ ${invalidStatus.length} 条的 status 值不是合法的三态之一，检查是不是手误`);
  }
}

main();
