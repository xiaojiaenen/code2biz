#!/usr/bin/env node
/**
 * codegraph-extract.mjs
 *
 * 二次开发：把 codegraph（@colbymchenry/codegraph，tree-sitter 真解析的代码知识图）
 * 封装成本 skill Phase 1 的可选增强数据源。
 *
 * 定位与边界（实测验证过，不是想当然）：
 *  - 强项：跨语言（20+ 语言）的符号检索（query/explore）、调用方/被调方查找
 *          （callers/callees）、按语言/类型统计文件。这能替代"grep + 读一遍猜"
 *          的部分工作，让状态机迁移的调用方、业务规则的变更影响面有精确依据。
 *  - 弱项（真实复现过）：
 *      1. 文件级 import 依赖边在部分语言（实测 Dart）上不可靠，会漏报或方向错乱，
 *         所以**不要把依赖图/入口点完整性完全押在 codegraph 上**——依赖图仍要
 *         交叉核对项目的注册中心/手动确认，入口点完整性仍靠 scan-entry-points.mjs
 *         的人为穷举 + check-entry-coverage.mjs 的覆盖率核对。
 *      2. codegraph **不提供开箱即用的"入口点穷举"**（query 需要关键词，explore 是
 *         语义检索），它给出的是符号级视图，不是"哪些是业务入口"的结论。
 *
 * 使用前提：环境里已安装 codegraph（npm i -g @colbymchenry/codegraph）。
 * 未安装时本脚本会明确报告并给出安装命令，调用方应回落到 scan-entry-points.mjs——
 * 本 skill 的设计原则是"可选增强，缺失时优雅降级"，不是硬依赖。
 *
 * 用法：
 *   node codegraph-extract.mjs probe    [--path <repo>]                 # 检测安装+是否已建索引
 *   node codegraph-extract.mjs init     [--path <repo>] [--force]       # 建索引（写 .codegraph/）
 *   node codegraph-extract.mjs status   [--path <repo>]                 # 索引统计（JSON）
 *   node codegraph-extract.mjs files    [--path <repo>]                 # 文件清单+语言+符号数
 *   node codegraph-extract.mjs symbols  [--path <repo>] [--query <kw>] [--kind <k>] [--limit <n>]
 *   node codegraph-extract.mjs scan-symbols [--path <repo>] [--filter <dir>] [--kind <k>]  # 穷举符号（中小项目）
 *   node codegraph-extract.mjs candidates [--path <repo>] [--kinds a,b,c] [--filter <dir>]
 *                                              # Phase 1 候选清单底座：导出全部符号并按 kind 分组，可直接喂领域模型/状态机/规则提取
 *   node codegraph-extract.mjs callers  [--path <repo>] <symbol>        # 谁调用了它
 *   node codegraph-extract.mjs callees  [--path <repo>] <symbol>        # 它调用了谁
 *   node codegraph-extract.mjs impact   [--path <repo>] [--depth <n>] <symbol...>  # 改动它影响谁（增量定位）
 *   node codegraph-extract.mjs context  [--path <repo>] --query <task> [--max-nodes <n>]  # 为任务聚合相关符号+关系（语义整合辅助）
 *
 * 除 probe 外，二进制不可用时 exit code 非 0 并在 stderr 给出安装提示。
 * 所有输出都是 JSON，便于后续阶段（Phase 2 整合 / Phase 3 图）直接消费。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const HOME = os.homedir();
// codegraph 的全局 bin 常出现在这几个目录（npm -g 前缀不同）
const CANDIDATE_BINS = [
  'codegraph',                       // 依赖 PATH
  path.join(HOME, '.local', 'bin', 'codegraph'),   // npm --prefix ~/.local
  path.join(HOME, '.npm-global', 'bin', 'codegraph'),
  path.join(HOME, 'bin', 'codegraph'),
];

function findCodegraph() {
  // 先看 PATH 里有没有
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const full = path.join(dir, 'codegraph');
    if (isExecutable(full)) return full;
  }
  for (const full of CANDIDATE_BINS) {
    if (full === 'codegraph') continue; // 已在 PATH 分支查过
    if (isExecutable(full)) return full;
  }
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const NO_INSTALL_HINT =
  '未检测到 codegraph。可先安装：npm i -g @colbymchenry/codegraph\n' +
  '（这是本 skill 的“可选增强”，不装也能用 scan-entry-points.mjs 完成入口点穷举；' +
  '装了之后可在需要精确的调用关系/跨语言符号解析时启用它）';

function fail(msg, hint = '') {
  const out = { ok: false, error: msg };
  if (hint) out.hint = hint;
  console.error(msg);
  if (hint) console.error(hint);
  process.exit(1);
}

function runCodegraph(bin, args, { capture = true } = {}) {
  // capture=true 返回 {stdout, stderr}；false 直接继承父进程输出（如 init 的进度条）
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return res;
}

function parseArgs(argv) {
  const pos = [];
  const opts = { path: undefined, force: false, query: undefined, kind: undefined, limit: undefined, filter: undefined, depth: undefined, kinds: undefined, maxNodes: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (a === '--path') opts.path = next();
    else if (a === '--force') opts.force = true;
    else if (a === '--query') opts.query = next();
    else if (a === '--kind') opts.kind = next();
    else if (a === '--limit') opts.limit = next();
    else if (a === '--filter') opts.filter = next();
    else if (a === '--depth') opts.depth = next();
    else if (a === '--kinds') opts.kinds = next();
    else if (a === '--max-nodes') opts.maxNodes = next();
    else pos.push(a);
  }
  return { pos, opts };
}

function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (!cmd) {
    console.error(
      '用法见脚本头部注释。示例：\n' +
      '  node codegraph-extract.mjs probe --path .\n' +
      '  node codegraph-extract.mjs symbols --path . --query "Consumer"\n' +
      '  node codegraph-extract.mjs callers --path . "SomeClass.method"'
    );
    process.exit(1);
  }

  // 统一转绝对路径，避免相对/绝对不一致导致索引匹配失败
  const repo = path.resolve(opts.path || process.cwd());
  const bin = findCodegraph();

  // ---- probe：唯一在“没装”时也正常 exit 0 的命令 ----
  if (cmd === 'probe') {
    if (!bin) {
      console.log(JSON.stringify({ ok: false, installed: false, hint: NO_INSTALL_HINT }, null, 2));
      return;
    }
    // status 用位置参数而不是 -p（codegraph 各命令参数不统一，见 parseArgs 附注）
    const st = runCodegraph(bin, ['status', '-j', repo]);
    let status = null;
    let reason = 'not-indexed';
    if (st.status === 0 && st.stdout.trim()) {
      try { status = JSON.parse(st.stdout); reason = 'indexed'; } catch { reason = 'cannot-parse'; }
    }
    console.log(JSON.stringify({ ok: true, installed: true, binary: bin, path: repo, indexed: !!status, reason, status }, null, 2));
    return;
  }

  // ---- 其余命令：没装则失败 ----
  if (!bin) fail('codegraph 未安装，无法执行 ' + cmd, NO_INSTALL_HINT);

  switch (cmd) {
    case 'init': {
      const args = ['init'];
      if (opts.force) args.push('--force');
      args.push('--yes');       // 非交互，跳过所有提示
      const res = runCodegraph(bin, args.concat([repo]).filter(Boolean), { capture: false });
      if (res.status !== 0) process.exit(res.status || 1);
      // init 完成后回读 status
      const st = runCodegraph(bin, ['status', '-j', repo]);
      if (st.status === 0 && st.stdout.trim()) {
        console.log(JSON.stringify({ ok: true, status: JSON.parse(st.stdout) }, null, 2));
      } else {
        console.log(JSON.stringify({ ok: true, status: null }));
      }
      break;
    }
    case 'status': {
      // 注意：codegraph 的 status 用位置参数 path，不是 -p
      const st = runCodegraph(bin, ['status', '-j', repo]);
      if (st.status !== 0) fail('codegraph status 失败：' + st.stderr.trim(), '是否先执行过 init？');
      console.log(st.stdout);
      break;
    }
    case 'files': {
      const st = runCodegraph(bin, ['files', '-j', '-p', repo]);
      if (st.status !== 0) fail('codegraph files 失败：' + st.stderr.trim(), '是否先执行过 init？');
      let files;
      try { files = JSON.parse(st.stdout); } catch { fail('codegraph files 输出不是 JSON：' + st.stdout.slice(0, 200)); }
      const byLang = {};
      for (const f of files || []) byLang[f.language] = (byLang[f.language] || 0) + 1;
      console.log(JSON.stringify({ ok: true, totalFiles: (files || []).length, byLanguage: byLang, files }, null, 2));
      break;
    }
    case 'symbols': {
      const kw = opts.query;
      if (!kw) fail('symbols 需要 --query <关键词>', '示例：node codegraph-extract.mjs symbols --path . --query "Consumer"');
      const args = ['query', kw, '-j', '-p', repo];
      if (opts.kind) args.push('--kind', opts.kind);
      args.push('--limit', opts.limit || '20');
      const st = runCodegraph(bin, args);
      if (st.status !== 0) fail('codegraph query 失败：' + st.stderr.trim());
      let nodes;
      try {
        nodes = JSON.parse(st.stdout).map((x) => x.node);
      } catch { fail('codegraph query 输出不是 JSON：' + st.stdout.slice(0, 200)); }
      console.log(JSON.stringify({ ok: true, query: kw, count: nodes.length, symbols: nodes }, null, 2));
      break;
    }
    case 'scan-symbols': {
      // 穷举符号：files 拿全部文件 → 逐文件 node --symbols-only 解析符号。
      // 设计用于中小项目或 --filter 限定目录；大项目逐文件解析会慢，属预期（文档有说明）。
      const filesRes = runCodegraph(bin, ['files', '-j', '-p', repo]);
      if (filesRes.status !== 0) fail('codegraph files 失败：' + filesRes.stderr.trim(), '是否先执行过 init？');
      let files;
      try { files = JSON.parse(filesRes.stdout); } catch { fail('codegraph files 输出不是 JSON'); }
      const allSymbols = [];
      let scannedFiles = 0;
      for (const f of files || []) {
        if (opts.filter && !f.path.startsWith(opts.filter)) continue;
        const np = runCodegraph(bin, ['node', '-p', repo, '--file', f.path, '--symbols-only']);
        if (np.status !== 0) continue;
        const symbols = parseNodeSymbols(np.stdout, f.path);
        scannedFiles += 1;
        for (const s of symbols) {
          if (opts.kind && s.kind !== opts.kind) continue;
          allSymbols.push(s);
        }
      }
      console.log(JSON.stringify({ ok: true, scannedFiles, filter: opts.filter || null, totalSymbols: allSymbols.length, symbols: allSymbols }, null, 2));
      break;
    }
    case 'callers':
    case 'callees': {
      const symbol = pos[1];
      if (!symbol) fail(`${cmd} 需要一个符号名参数`);
      const args = [cmd, '-j', '-p', repo, '--limit', opts.limit || '30', symbol];
      const st = runCodegraph(bin, args);
      if (st.status !== 0) fail(`codegraph ${cmd} 失败：` + st.stderr.trim(), '请确认符号名是否存在于索引中（可先用 symbols/candidates 检索）');
      let parsed;
      try { parsed = JSON.parse(st.stdout); } catch { fail(`${cmd} 输出不是 JSON：` + st.stdout.slice(0, 200)); }
      console.log(JSON.stringify({ ok: true, command: cmd, symbol, results: parsed }, null, 2));
      break;
    }
    case 'impact': {
      const symbols = pos.slice(1);
      if (!symbols.length) fail('impact 需要一个或多个符号');
      // 增量定位：给定被改动的符号，找出受其影响的符号/文件
      const args = ['impact', '-j', '-p', repo, '--depth', opts.depth || '2', ...symbols];
      const st = runCodegraph(bin, args);
      if (st.status !== 0) fail(`codegraph impact 失败：` + st.stderr.trim(), '请确认符号存在于索引中');
      let parsed;
      try { parsed = JSON.parse(st.stdout); } catch { fail('impact 输出不是 JSON：' + st.stdout.slice(0, 200)); }
      // 归一化：把 codegraph 返回的影响集合统一成 [{symbol, file, kind, depth}] 便于增量文档定位消费
      const normalized = normalizeImpact(parsed, symbols);
      console.log(JSON.stringify({ ok: true, command: 'impact', seeds: symbols, depth: opts.depth || '2', raw: parsed, affected: normalized }, null, 2));
      break;
    }
    case 'context': {
      const task = opts.query || pos.slice(1).join(' ');
      if (!task) fail('context 需要一个任务描述（--query <task> 或位置参数）');
      const args = ['context', '-p', repo, '-f', 'json', '-n', opts.maxNodes || '30', task];
      const st = runCodegraph(bin, args);
      if (st.status !== 0) fail(`codegraph context 失败：` + st.stderr.trim());
      let parsed;
      try { parsed = JSON.parse(st.stdout); } catch { fail('context 输出不是 JSON：' + st.stdout.slice(0, 200)); }
      console.log(JSON.stringify({ ok: true, command: 'context', task, results: parsed }, null, 2));
      break;
    }
    case 'candidates': {
      // Phase 1 候选清单底座：穷举全部符号并按 kind 分组，供领域模型/状态机/规则提取直接消费
      const kindsFilter = opts.kinds ? opts.kinds.split(',') : null;
      const filesRes = runCodegraph(bin, ['files', '-j', '-p', repo]);
      if (filesRes.status !== 0) fail('codegraph files 失败：' + filesRes.stderr.trim(), '是否先执行过 init？');
      let files;
      try { files = JSON.parse(filesRes.stdout); } catch { fail('codegraph files 输出不是 JSON'); }
      const seen = new Set();
      const byKind = {};
      const candidates = [];
      const kindPriority = ['class', 'enum', 'interface', 'record', 'struct', 'entity', 'function', 'method', 'field', 'variable', 'constant', 'typealias', 'abstract'];
      let scannedFiles = 0;
      for (const f of files || []) {
        if (opts.filter && !f.path.startsWith(opts.filter)) continue;
        const np = runCodegraph(bin, ['node', '-p', repo, '--file', f.path, '--symbols-only']);
        if (np.status !== 0) continue;
        scannedFiles += 1;
        for (const s of parseNodeSymbols(np.stdout, f.path)) {
          if (kindsFilter && !kindsFilter.includes(s.kind)) continue;
          const key = `${s.file}:${s.name}:${s.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          (byKind[s.kind] = byKind[s.kind] || []).push(s);
          candidates.push(s);
        }
      }
      // 排序：按"业务相关度高"的 kind 优先
      candidates.sort((a, b) => (kindPriority.indexOf(a.kind) === -1 ? 99 : kindPriority.indexOf(a.kind)) - (kindPriority.indexOf(b.kind) === -1 ? 99 : kindPriority.indexOf(b.kind)));
      const totalsByKind = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length]));
      console.log(JSON.stringify({ ok: true, command: 'candidates', repo, scannedFiles,
        kindsFilter: opts.kinds || null, totalSymbols: candidates.length, totalsByKind, candidates }, null, 2));
      break;
    }
    default:
      fail(`未知命令：${cmd}`);
  }
}

// 解析 `codegraph node --file <f> --symbols-only` 的文本输出，格式如：
//   - `RepackageInboundModule` (class) — :7
//   - `scanTask` (method) Future (String taskNo) — :12
const SYMBOL_LINE = /^-\s+`([^`]+)`\s+\((\w+)(?:\s+.*?)?\)(.*)/;
const LINE_TAIL = /—\s*:\s*(\d+)\s*$/;

// 把 codegraph impact 的返回归一化成 [{symbol, file, kind, depth}]。
// codegraph 的返回字段因语言而异（主流是 filePath/name，可能有 symbol/file/path/startLine），
// 这里统一提取，保证输出里每个受影响条目都带可定位的 file + 可读标识，方便增量文档直接消费。
function toImpactEntry(it) {
  if (!it || typeof it !== 'object') {
    return { symbol: typeof it === 'string' ? it : '(unknown symbol)', file: null, kind: 'symbol', depth: 1 };
  }
  return {
    symbol: it.symbol || it.name || it.id || '(unknown symbol)',
    file: it.file || it.path || it.filename || it.filePath || null,
    kind: it.kind || 'symbol',
    depth: Number(it.depth) || 1,
    line: it.startLine || it.line || undefined,
  };
}

function normalizeImpact(parsed, seeds) {
  const out = [];
  const handle = (it) => {
    const e = toImpactEntry(it);
    if (e.file || e.symbol) out.push(e);
  };
  if (Array.isArray(parsed)) {
    for (const it of parsed) {
      if (it && typeof it === 'object') handle(it);
      else handle(it);
    }
  } else if (parsed && typeof parsed === 'object') {
    const candidates = parsed.affected || parsed.results || parsed.symbols || parsed.nodes;
    if (Array.isArray(candidates)) {
      candidates.forEach(handle);
    } else {
      // 兜底：遍历对象里所有带文件/符号键位的节点
      const walk = (obj) => {
        if (Array.isArray(obj)) { obj.forEach(walk); return; }
        if (obj && typeof obj === 'object') {
          if (obj.file || obj.filePath || obj.symbol || obj.name || obj.id) handle(obj);
          for (const k of Object.keys(obj)) {
            if (!['file', 'path', 'symbol', 'name', 'id', 'filePath'].includes(k)) walk(obj[k]);
          }
        }
      };
      walk(parsed);
    }
  }
  // 去重 + 排除种子本身
  const seen = new Set();
  return out.filter((it) => {
    if (seeds.includes(it.symbol) && it.depth <= 1) return false;
    const key = `${it.file}|${it.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function parseNodeSymbols(output, filePath, repoRoot) {
  const symbols = [];
  const inSymbols = output.includes('**Symbols**');
  if (!inSymbols) return symbols;
  const lines = output.split('\n');
  // 从 **Symbols** 之后开始解析
  let started = false;
  for (const ln of lines) {
    if (!started && ln.includes('**Symbols**')) { started = true; continue; }
    if (!started) continue;
    if (ln.trim() === '' && symbols.length > 0) break; // 符号表结束
    const m = ln.match(SYMBOL_LINE);
    if (!m) continue;
    const tailM = ln.match(LINE_TAIL);
    symbols.push({
      name: m[1],
      kind: m[2],
      file: filePath,
      line: tailM ? Number(tailM[1]) : undefined,
    });
  }
  return symbols;
}

main();