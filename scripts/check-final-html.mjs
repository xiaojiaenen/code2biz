#!/usr/bin/env node
/**
 * check-final-html.mjs
 *
 * 最终单文件 HTML 的离线 / CORS 自检脚本（R1 版：禁 iframe，原生内联）。
 *
 * 背景：Phase 5 的交付物是一个"双击就能打开的单个 .html"，它能不能在 file://
 * 协议下直接打开、会不会因为引入外部资源而白屏或报 CORS 错，是整个 skill 的
 * 硬性交付门槛（见 references/07-single-html-packaging.md 的"离线与 CORS 自检"）。
 * 这个脚本把这些规则变成一条条确定性的机器检查，生成完跑一遍再交付。
 *
 * 检查项（对应 R1 禁 iframe + 单文件硬约束）：
 *   1. 无任何 <iframe>（R1：所有图一律经 archify-inline bundle 原生内联，
 *      不允许 iframe src / srcdoc 任何形态——srcdoc 转义是历史事故高发区，直接禁掉）
 *   2. 无外部/本地文件的 <script src=...>（含 <script type="module" src=...>）
 *   3. <link href=...> 只允许 Google Fonts 这类纯字体兜底；其余一律报错
 *   4. 无运行时 fetch() / XMLHttpRequest / WebSocket 发起的外部请求
 *   5. <script>/</script>、<style>/</style> 标签成对闭合，无悬空标签
 *   6. 若文档含图表章节（含 "arch-chart"/"arch-slot" 槽位），必须至少有一段内联 <svg>
 *
 * 用法：
 *   node scripts/check-final-html.mjs <final.html>
 * 退出码：
 *   0  无 error（可能有 warning）
 *   1  发现 error（外部资源 / 违反硬约束）
 *   2  用法错误 / 文件读不到
 */

import fs from 'node:fs';
import path from 'node:path';

function makeCheck(name) {
  return { name, ok: true, details: [] };
}

function fail(check, detail) {
  check.ok = false;
  check.details.push(detail);
}

/** 只在目标文本上跑正则，返回命中列表。 */
function countHits(text, reGlobals) {
  const hits = [];
  for (const re of reGlobals) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push(m[0]);
    }
  }
  return hits;
}

export function run(htmlPath) {
  const checks = {
    fileReadable: makeCheck('file_readable'),
    noIframe: makeCheck('no_iframe_r1'),
    noExternalScriptSrc: makeCheck('no_external_script_src'),
    noExternalLinkHref: makeCheck('no_external_link_href'),
    noRuntimeHttp: makeCheck('no_runtime_http'),
    tagsBalanced: makeCheck('tags_balanced'),
    chartsInlined: makeCheck('charts_inlined'),
  };

  let html;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (err) {
    fail(checks.fileReadable, err.message);
    return { ok: false, has_error: true, file: htmlPath, checks };
  }

  // 1) R1：禁止任何形态的 iframe（src / srcdoc 一律违规）
  const iframeHits = countHits(html, [/<iframe\b/gi]);
  if (iframeHits.length > 0) {
    fail(checks.noIframe, `发现 ${iframeHits.length} 处 <iframe> —— R1 要求所有图原生内联（archify-inline bundle），禁止任何 iframe 形态（含 srcdoc）`);
  }

  // 2) 外部 / 本地文件脚本：<script src=...>
  const scriptOpenRe = /<script\b([^>]*)>/gi;
  let m;
  while ((m = scriptOpenRe.exec(html)) !== null) {
    const attrs = m[1];
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!srcMatch) continue;
    const src = (srcMatch[1] ?? srcMatch[2]).trim();
    const isInlineAllowed = /^(?:data:)/.test(src);
    if (isInlineAllowed) continue;
    // 任何其它 src（http/https/file://、/绝对路径、./相对路径）都是违规
    fail(checks.noExternalScriptSrc, `发现 <script src="${src}"> —— 单文件里不允许外部或本地文件脚本`);
    const isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
    if (isModule) {
      fail(checks.noExternalScriptSrc, `<script type="module" src="${src}">：file:// 协议下的外部模块加载会被跨域拦截，必须把内容内联`);
    }
  }

  // 3) 外部 <link href=...>：只允许 Google Fonts 这类纯字体兜底
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0]);
    if (!hrefMatch) continue;
    const href = (hrefMatch[1] ?? hrefMatch[2]).trim();
    if (/^https?:\/\//i.test(href)) {
      if (/fonts\.(googleapis|gstatic)\.com/i.test(href)) continue; // 允许的字体兜底
      fail(checks.noExternalLinkHref, `发现外部 <link href="${href}"> —— 只允许 Google Fonts 兜底`);
    } else if (/^(file:|\/|\w:\\)/i.test(href) || /^\.\.?\//.test(href)) {
      fail(checks.noExternalLinkHref, `发现本地文件 <link href="${href}"> —— 单文件应内联 CSS`);
    }
  }

  // 4) 运行时 HTTP 请求：fetch / XMLHttpRequest / WebSocket
  const runtimeHits = countHits(html, [
    /\bfetch\s*\(\s*["'`]/g,
    /\bXMLHttpRequest\b/g,
    /\bnew\s+WebSocket\s*\(/g,
  ]);
  if (runtimeHits.length > 0) {
    const labels = [...new Set(runtimeHits.map((h) => {
      if (h.startsWith('new WebSocket')) return 'new WebSocket';
      if (h.startsWith('XMLHttpRequest')) return 'XMLHttpRequest';
      return 'fetch';
    }))];
    fail(checks.noRuntimeHttp, `发现运行时请求标识 ${labels.join(', ')}（共 ${runtimeHits.length} 处）—— 单文件不应在运行时获取外部数据`);
  }

  // 5) script / style 标签成对闭合
  for (const tag of ['script', 'style']) {
    const open = (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
    const close = (html.match(new RegExp(`<\\/${tag}>`, 'gi')) || []).length;
    if (open !== close) {
      fail(checks.tagsBalanced, `<${tag}> 开 ${open} / 闭 ${close} 数量不匹配——有未闭合或多余闭合标签`);
    }
  }

  // 6) 图表内联完整性：文档声明了图表槽位时，必须有内联 SVG
  const hasChartSlots = /arch-slot|arch-chart/i.test(html);
  const inlineSvgCount = (html.match(/<svg\b/gi) || []).length;
  if (hasChartSlots && inlineSvgCount === 0) {
    fail(checks.chartsInlined, '文档含图表槽位（arch-slot/arch-chart）但没有任何内联 <svg> —— 图没有被 bundle 内联进来');
  }

  const hasError = Object.values(checks).some((c) => !c.ok);

  return {
    ok: !hasError,
    file: htmlPath,
    has_error: hasError,
    checks,
    summary: { inline_svg_count: inlineSvgCount },
  };
}

function main() {
  const input = process.argv[2];
  if (!input || input === '-h' || input === '--help') {
    console.error('Usage: node scripts/check-final-html.mjs <final.html>');
    process.exit(input ? 0 : 2);
  }
  const htmlPath = path.resolve(input);
  const result = run(htmlPath);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.has_error ? 1 : 0);
}

main();
