#!/usr/bin/env node
/**
 * scan-entry-points.mjs
 *
 * 二次开发：把 references/01-extraction.md "完整性保证"一节里的方法论
 * 变成一个真的能跑的扫描工具，而不是只靠模型"自觉去找入口点"。
 *
 * 扫描一个代码库目录，按常见框架的路由/调度/消息注解做正则匹配，
 * 产出一份结构化的"入口点清单"（每条带 file:line，可追溯、可核对）。
 *
 * 覆盖范围（按需扩展，命中就是命中，没命中不代表该类型的入口不存在——
 * 正则扫描是"召回优先"的粗筛，不是精确解析，最终清单建议人工过一遍再定稿）：
 *
 *   HTTP 接口     Spring (@RequestMapping/@GetMapping/@PostMapping/...)
 *                Express/Koa (app.get/post/put/delete/all, router.xxx)
 *                Flask/FastAPI (@app.route, @app.get, @router.post)
 *                NestJS (@Get/@Post/@Put/@Delete)
 *                Go gin/echo (router.GET/POST, e.GET/POST)
 *   定时任务      @Scheduled (Java), node-cron / node-schedule (schedule(...))，
 *                Python APScheduler (@scheduler.scheduled_job)，crontab 配置行
 *   消息消费者     @KafkaListener/@RabbitListener (Java)，kafka-node/kafkajs 的
 *                consumer.on('message')/eachMessage，Python 常见 @app.task (Celery)
 *   CLI 入口      Python argparse/click 的命令函数，Node commander/yargs 的 .command(
 *   事件监听      EventEmitter.on(...) / @EventListener (Java)
 *
 * 用法：
 *   node scan-entry-points.mjs <repo-root> <output.json> [--ext .java,.js,.ts,.py,.go]
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EXTS = ['.java', '.kt', '.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.dart'];
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '__pycache__', '.venv', 'venv']);

// 每条规则：{ type, framework, pattern(正则,带 g 标记), labelFrom(从匹配组里取标签的索引) }
const RULES = [
  // ---- HTTP: Spring ----
  { type: 'http', framework: 'spring', pattern: /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(([^)]*)\)/g },
  // ---- HTTP: Express/Koa ----
  { type: 'http', framework: 'express', pattern: /(?:app|router)\.(get|post|put|delete|all|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g },
  // ---- HTTP: Flask/FastAPI ----
  { type: 'http', framework: 'flask-fastapi', pattern: /@(?:app|router)\.(route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g },
  // ---- HTTP: NestJS ----
  { type: 'http', framework: 'nestjs', pattern: /@(Get|Post|Put|Delete|Patch)\s*\(([^)]*)\)/g },
  // ---- HTTP: Go gin/echo ----
  { type: 'http', framework: 'go-gin-echo', pattern: /(?:router|e|r)\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/g },
  // ---- WebSocket（SKILL R2 闭环：之前缺这一类会让"零漏报"承诺在含 WS 的项目上静默失真） ----
  { type: 'websocket', framework: 'fastapi-ws', pattern: /@(?:app|router)\.websocket\s*\(\s*['"]([^'"]+)['"]/g },
  { type: 'websocket', framework: 'flask-socketio', pattern: /@socketio\.on\s*\(\s*['"]([^'"]+)['"]/g },
  { type: 'websocket', framework: 'spring-websocket', pattern: /@MessageMapping\s*\(\s*['"]?([^'")]+)['"]?\s*\)/g },
  { type: 'websocket', framework: 'socketio', pattern: /io\.on\s*\(\s*['"]([^'"]+)['"]/g },
  // ---- 定时任务 ----
  { type: 'schedule', framework: 'spring-scheduled', pattern: /@Scheduled\s*\(([^)]*)\)/g },
  { type: 'schedule', framework: 'node-cron', pattern: /(?:cron\.schedule|schedule\.scheduleJob)\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { type: 'schedule', framework: 'python-apscheduler', pattern: /@scheduler\.scheduled_job\s*\(([^)]*)\)/g },
  // ---- 消息消费者 ----
  { type: 'mq-consumer', framework: 'spring-kafka-rabbit', pattern: /@(KafkaListener|RabbitListener)\s*\(([^)]*)\)/g },
  { type: 'mq-consumer', framework: 'kafkajs', pattern: /(consumer\.run|eachMessage)\s*\(/g },
  { type: 'mq-consumer', framework: 'celery', pattern: /@app\.task\b/g },
  // ---- CLI ----
  { type: 'cli', framework: 'commander', pattern: /\.command\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { type: 'cli', framework: 'click', pattern: /@click\.command\s*\(([^)]*)\)/g },
  // ---- 事件监听 ----
  { type: 'event-listener', framework: 'eventemitter', pattern: /\.on\s*\(\s*['"`]([^'"`]+)['"`]\s*,/g },
  { type: 'event-listener', framework: 'spring-event', pattern: /@EventListener\b/g },
  // ---- Dart/Flutter：客户端项目的"入口点"和服务端反过来——
  //      真正的业务流程触发点是"调用后端 API 的那一行"，不是接收请求的地方。
  //      GoRoute 是 UI 导航入口，module 注册是本 skill 遇到的"插件式模块"架构里的业务能力入口，
  //      两者都值得单独追踪，但含义和 http/schedule 这些服务端类型不一样，用独立的 type 区分。
  // ---- Dart/Flutter：客户端项目的"入口点"和服务端反过来——
  //      真正的业务流程触发点是"调用后端 API 的那一行"，不是接收请求的地方。
  //      不依赖变量名里是否带"client"字样（不同项目命名不一样，比如 _api/_http/_dio 都可能），
  //      判断依据是"第一个参数是以 / 开头的字符串字面量"——这个特征更稳定，
  //      也能顺带排除掉底层薄封装（比如 ApiClient 内部转调 _dio.get(path,...) 时
  //      传的是变量不是字符串字面量，天然不会被误判成一次业务调用）。
  { type: 'api-call', framework: 'dart-http-client', pattern: /\b\w+\.(get|post|put|delete|patch)\s*\(\s*['"](\/[^'"]+)['"]/g },
  { type: 'route', framework: 'go-router', pattern: /GoRoute\s*\(\s*path:\s*['"]([^'"]+)['"]/g },
  { type: 'module-entry', framework: 'flutter-module-pattern', pattern: /class\s+(\w+)\s+implements\s+\w*Module\b/g },
];

function walk(dir, exts, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, out);
    } else if (exts.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function scanFile(filePath, repoRoot, results) {
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(content)) !== null) {
      const raw = match[0];
      const detail = (match[2] || match[1] || '').trim();
      results.push({
        id: `${rule.type}:${path.relative(repoRoot, filePath)}:${lineNumberAt(content, match.index)}`,
        type: rule.type,
        framework: rule.framework,
        file: filePath,
        line: lineNumberAt(content, match.index),
        matched: raw.slice(0, 160),
        detail: detail.slice(0, 160),
        status: 'unreviewed', // 三态：unreviewed / detailed / recorded / flagged，人工 review 时改
      });
    }
  }
}

function dedupe(results) {
  // 不同框架的正则规则之间会有交叉误报——比如 Express 的 app.get(...) 规则
  // 和 FastAPI 的 @app.get(...) 规则字面上长得几乎一样，同一行会被两条规则
  // 都命中，产出两条几乎一样的记录。按 file+line 去重，同一行只保留第一条命中，
  // 但把其余规则命中的 framework 名字追加进 alsoMatchedBy，方便人工核对时
  // 判断"这一行到底是哪个框架的语法，扫描器猜的框架名对不对"。
  const seen = new Map();
  for (const r of results) {
    const key = `${r.file}:${r.line}`;
    if (!seen.has(key)) {
      seen.set(key, { ...r, alsoMatchedBy: [] });
    } else {
      seen.get(key).alsoMatchedBy.push(r.framework);
    }
  }
  return Array.from(seen.values());
}

function main() {
  const args = process.argv.slice(2);
  const repoRoot = args[0];
  const outputPath = args[1];
  const extArg = args.find((a) => a.startsWith('--ext'));
  const exts = extArg ? extArg.split('=')[1].split(',') : DEFAULT_EXTS;

  if (!repoRoot || !outputPath) {
    console.error('用法: node scan-entry-points.mjs <repo-root> <output.json> [--ext=.java,.js]');
    process.exit(1);
  }

  const files = [];
  walk(repoRoot, exts, files);

  const rawResults = [];
  for (const f of files) {
    scanFile(f, repoRoot, rawResults);
  }
  const results = dedupe(rawResults);

  const byType = results.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});

  const manifest = {
    scannedAt: new Date().toISOString(),
    repoRoot,
    filesScanned: files.length,
    entryPointsFound: results.length,
    countsByType: byType,
    entryPoints: results,
  };

  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`扫描完成：${files.length} 个文件，找到 ${results.length} 个候选入口点`);
  console.log('按类型统计：', JSON.stringify(byType));
  console.log(`产出：${outputPath}`);
  console.log('下一步：人工过一遍这份清单，剔除误报（正则扫描是召回优先的粗筛），');
  console.log('然后把每条的 status 从 unreviewed 改成 detailed/recorded/flagged 三态之一，');
  console.log('再用 check-entry-coverage.mjs 反向核对最终文档是否覆盖了每一条。');
}

main();
