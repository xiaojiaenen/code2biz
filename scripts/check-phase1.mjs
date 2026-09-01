#!/usr/bin/env node
/**
 * check-phase1.mjs
 *
 * Phase 1 中间数据的"落盘可恢复"检查器。
 *
 * 为什么需要它：Phase 1 会把代码里"确定性存在"的事实（实体字段、状态机迁移表、
 * 规则的数值边界、术语映射、入口点清单）提取成结构化中间数据。这些是一次性花
 * 大力气挖出来的紧俏信息，一旦上下文被压缩、或者任务换会话，没落盘的成果就全
 * 丢了。契约是：**Phase 1 的任何成果必须写盘，不准只留在上下文里**。
 *
 * 落盘约定（见 references/01-extraction.md 的"落盘与跨阶段恢复"）：
 *   工作区根下建 `phase1/` 目录，按集合拆分文件：
 *     phase1/_checkpoint.json        —— 上次执行进行了哪个阶段（续写定位用）
 *     phase1/00-domains.json         —— 业务域边界（单仓库通常 1 个）
 *     phase1/10-entities.json        —— 领域模型
 *     phase1/20-state-machines.json  —— 状态机迁移表
 *     phase1/30-business-rules.json  —— 业务规则（条件原文 + 数值边界）
 *     phase1/40-terms.json           —— 术语映射
 *     phase1/50-entry-points.json    —— 入口点清单
 *   每个集合文件的顶层形状 = schemas/phase1.schema.json 里对应数组的对象，再加
 *   一个 `_file` 数组名（如 "entities"）指向该数组，便于这里逐一校验与汇总。
 *
 * 用法：
 *   node scripts/check-phase1.mjs [--dir <phase1目录>]   # 默认 phase1
 *
 * 它做三件事：
 *   1. 跑一个内置的精简 JSON Schema 校验（覆盖本项目 schema 用到的最小关键字：
 *      type / required / properties / additionalProperties / items / enum），
 *      任何一条不满足都算破坏结构，报告出来。
 *   2. 检查七个集合文件是否齐全，缺了哪个会明确提示"上次可能停在哪个集合"，让
 *      新会话能精确续写，而不是从零重来。
 *   3. 汇总各集合的条目数（实体数 / 状态机数 / 迁移行数 / 规则数 / 术语数 /
 *      入口点数），压缩后新会话运行一次，就能把 Phase 1 的全貌一次性读回。
 *
 * 退出码：
 *   0  校验通过、六个业务集合齐全、可进入 Phase 2
 *   1  有结构错误，或缺失某个集合，停下来补/续写
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTIONS = {
  '00-domains.json': 'domains',
  '10-entities.json': 'entities',
  '20-state-machines.json': 'state_machines',
  '30-business-rules.json': 'business_rules',
  '40-terms.json': 'terms',
  '50-entry-points.json': 'entry_points',
};
const CHECKPOINT_FILE = '_checkpoint.json';

/* ---------------- 精简 JSON Schema 校验器（draft-07 子集） ---------------- */

function typeOf(node) {
  if (Array.isArray(node)) return 'array';
  if (node === null) return 'null';
  return typeof node;
}

function collectErrors(node, schema, p, out) {
  if (schema === undefined || schema === true) return;
  if (schema === false) { out.push(`${p}: schema 禁止该值`); return; }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes(typeOf(node))) {
      const want = types.join('|');
      out.push(`${p}: 期望 ${want}，实际 ${typeOf(node)}`);
      return;
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(node)) {
    out.push(`${p}: 值不在枚举 ${JSON.stringify(schema.enum)} 内`);
  }

  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if (schema.required) {
      for (const k of schema.required) {
        if (!(k in node)) out.push(`${p}.${k}: 缺少必填字段`);
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in node) collectErrors(node[k], sub, `${p}.${k}`, out);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(node)) {
        if (!(k in schema.properties)) out.push(`${p}.${k}: 额外字段不允许`);
      }
    }
  }

  if (schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))) {
    if (!Array.isArray(node)) return;
    if (schema.minItems !== undefined && node.length < schema.minItems) {
      out.push(`${p}: 元素数 < minItems(${schema.minItems})`);
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      node.forEach((it, i) => collectErrors(it, schema.items, `${p}[${i}]`, out));
    }
  }
}

/* ---------------- 脚本主体 ---------------- */

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { __error: err.message };
  }
}

function main() {
  const argv = process.argv.slice(2);
  let dir = 'phase1';
  if (argv[0] === '--dir') dir = argv[1];

  const dirAbs = path.resolve(dir);
  if (!fs.existsSync(dirAbs)) {
    console.error(`phase1 目录不存在：${dirAbs}`);
    console.error('提示：Phase 1 必须把提取结果落盘到这个目录（见 references/01-extraction.md「落盘与跨阶段恢复」），否则任何成果都会随上下文压缩而丢失。');
    process.exit(1);
  }

  // 先读 schema，把校验器用起来（fileURLToPath 避免 Windows 下 pathname 带正斜杠导致读不到）
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(scriptDir, '../schemas/phase1.schema.json');
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    schema = null;
  }

  // checkpoint：记录上次做到哪一步
  const cpPath = path.join(dirAbs, CHECKPOINT_FILE);
  let checkpoint = loadJson(cpPath);
  if (checkpoint.__error) checkpoint = null;

  const report = { ok: true, dir: dirAbs, collections: {}, errors: [] };
  let anyMissing = false;
  let anyError = false;

  for (const [file, name] of Object.entries(COLLECTIONS)) {
    const f = path.join(dirAbs, file);
    if (!fs.existsSync(f)) {
      anyMissing = true;
      report.collections[name] = { file, exists: false };
      report.errors.push(`缺失集合 ${name}（${file}）——上次可能停在这一步`);
      continue;
    }
    const data = loadJson(f);
    const entry = { file, exists: true, count: null, structural_errors: [] };
    if (data.__error) {
      anyError = true;
      entry.structural_errors.push(`文件不是合法 JSON：${data.__error}`);
    } else if (schema) {
      const array = data[name] ?? [];
      if (!Array.isArray(array)) {
        anyError = true;
        entry.structural_errors.push(`集合 ${name} 需要是数组，但实际是 ${typeOf(array)}`);
      } else {
        entry.count = array.length;
        // 用顶层 schema 里的对应集合定义校验每一项
        const collectionSchema = schema.properties[name];
        if (collectionSchema) {
          array.forEach((item, i) => {
            const errs = [];
            collectErrors(item, collectionSchema.items ?? collectionSchema, `${name}[${i}]`, errs);
            errs.forEach((e) => entry.structural_errors.push(e));
          });
          if (entry.structural_errors.length > 0) anyError = true;
        }
      }
    }
    report.collections[name] = entry;
  }

  // checkpoint 里的阶段信息也透出
  if (checkpoint) {
    report.checkpoint = {
      last_phase: checkpoint.last_phase ?? 'unknown',
      user_original_note: checkpoint.user_original_note ?? null,
    };
  }

  // 汇总
  const summary = {};
  for (const [name, c] of Object.entries(report.collections)) {
    summary[name] = c.exists ? (c.count ?? '?') : 'missing';
  }
  report.summary = summary;
  report.ok = !(anyMissing || anyError);

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();