#!/usr/bin/env node
/**
 * archify-inline.mjs —— 把 archify 产物转成可原生内联的片段（替代 iframe srcdoc）
 *
 * 为什么需要这个脚本
 * ------------------
 * archify 每次 deliver 出来的是一份**完整独立 HTML**（实测 ~700KB / 张）：自带
 * <html>/<head>/<body>、185KB 的 <style>、4 段内联 <script>、3 个外部字体 <link>。
 *
 * 本 skill 的集成规则是「禁止 iframe / 外部挂载，必须原生嵌入且无割裂」，所以不能
 * 再把整份文档塞进 iframe srcdoc。但也**不能**把多份 archify 文档原样拼进宿主页面：
 *
 *   - 每张图都用同一套 id（btn-theme / guided-views / archify-i18n-data …），
 *     多图内联必然 id 撞车（实测单份产物里 getElementById 有 117 处）
 *   - CSS 里有 body / h1 / :root 这类全局选择器，会污染宿主
 *   - 模板脚本会写 document.documentElement（data-theme / data-embed），影响宿主
 *   - 图面 SVG 依赖外部 style 块（实测 SVG 内部 style=0 个、fill= 仅 1 个、class=79 个）
 *
 * 所以拆三件事做：
 *   1. CSS  —— 抽出来，给每条选择器加 .arch-slot 作用域前缀；**所有图共用一份**，只注入一次
 *   2. SVG  —— 只抽主图图面（实测约 17KB，占原文 2.4%），内部 id 加槽位前缀，
 *              避免多图 <defs> 里的 marker / 渐变 id 互相覆盖
 *   3. 运行时 —— 自研缩放/平移/复位/适应/节点聚焦，用宿主设计系统的 token，
 *              零外部依赖、离线可用（取代 archify 自带工具栏）
 *
 * 体积对比（Russh 两张图实测）
 *   iframe srcdoc（旧）: 695KB × 2 ≈ 1.40MB
 *   本方案（新）       : 185KB(一次) + 17KB × 2 ≈ 0.22MB
 *
 * 用法
 * ----
 *   node scripts/archify-inline.mjs css      <archify.html...> [-o out.css]
 *   node scripts/archify-inline.mjs chrome   [-o out.css]
 *   node scripts/archify-inline.mjs runtime  [-o out.js]
 *   node scripts/archify-inline.mjs svg      <archify.html> [--slot id] [--theme dark|light] [-o out.html]
 *   node scripts/archify-inline.mjs bundle   <out.json> <archify.html...> [--theme dark|light]
 *
 * Phase 5 一般用 bundle：拿到 css / chromeCss / runtime / diagrams 四件套直接拼进单文件 HTML。
 */

import fs from 'node:fs';
import path from 'node:path';

const SLOT = 'arch-slot';
const KF_PREFIX = 'arch-';

const read = (p) => fs.readFileSync(p, 'utf8');
const writeOut = (p, s) => {
  if (p) fs.writeFileSync(p, s, 'utf8');
  return s;
};
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
// 剔除开关及其取值（--theme dark / -o out.css 这类成对参数）。
// 实测踩坑：只按 '-' 前缀过滤时，--theme 的值 "dark" 会被当成文件名，
// buildScopedCss 直接 ENOENT 崩掉。
const FLAG_WITH_VALUE = new Set(['-o', '--slot', '--theme']);
const filesAfter = (n) => {
  const out = [];
  const args = process.argv.slice(n);
  for (let i = 0; i < args.length; i++) {
    if (FLAG_WITH_VALUE.has(args[i])) { i += 1; continue; }
    if (args[i].startsWith('-')) continue;
    out.push(args[i]);
  }
  return out;
};

/* ------------------------------------------------------------------ *
 * 1. 抽取
 * ------------------------------------------------------------------ */

function extractStyle(html) {
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  if (!m) throw new Error('未找到 <style> 块 —— 这不是 archify 产物？');
  return m[1];
}

/** 找到主图 SVG：带 archify-diagram-title 的那个（模板里还有若干图标 svg，要排除） */
function findMainSvg(html) {
  const starts = [...html.matchAll(/<svg\b/g)].map((m) => m.index);
  let best = null;
  for (const s of starts) {
    let depth = 0;
    let cursor = s;
    let end = -1;
    while (cursor < html.length) {
      const nextOpen = html.indexOf('<svg', cursor + 1);
      const nextClose = html.indexOf('</svg>', cursor + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen;
      } else if (depth === 0) {
        end = nextClose + 6;
        break;
      } else {
        depth -= 1;
        cursor = nextClose;
      }
    }
    if (end === -1) continue;
    const text = html.slice(s, end);
    if (text.includes('archify-diagram-title') && (!best || text.length > best.length)) best = text;
  }
  if (!best) throw new Error('未找到主图 SVG（缺少 archify-diagram-title）—— 产物结构可能变了');
  return best;
}

/* ------------------------------------------------------------------ *
 * 2. CSS 作用域化
 * ------------------------------------------------------------------ */

/**
 * keyframes 名统一加前缀，避免和宿主页面的动画名撞车。
 *
 * 只改两处，绝不全局替换名字：
 *   1. @keyframes NAME 的定义
 *   2. animation / animation-name 的取值
 * 原因（踩过的坑）：archify 有名为 `pulse` 的 keyframes，同时也有 `.pulse-dot`
 * 这个类名。全局按词边界替换会把 `.pulse-dot` 一起改成 `.arch-pulse-dot`，
 * 于是这 11 条规则再也匹配不上标记里的 class="pulse-dot"，图直接少一层视觉。
 */
function renameKeyframes(css) {
  const names = new Set();
  for (const m of css.matchAll(/@keyframes\s+([A-Za-z_-][\w-]*)/g)) names.add(m[1]);
  if (!names.size) return css;

  let out = css.replace(/@keyframes\s+([A-Za-z_-][\w-]*)/g, (m, n) => `@keyframes ${KF_PREFIX}${n}`);

  // animation: name 2s ease-in-out infinite  /  animation-name: name
  out = out.replace(/(\banimation(?:-name)?\s*:\s*)([^;}]+)/g, (m, prop, val) => {
    const newVal = val.replace(/[A-Za-z_-][\w-]*/g, (tok) => (names.has(tok) ? KF_PREFIX + tok : tok));
    return prop + newVal;
  });
  return out;
}

/**
 * 给单条选择器加 .arch-slot 作用域。
 *   :root                                   -> .arch-slot
 *   [data-theme="dark"]                     -> .arch-slot[data-theme="dark"]
 *   html[data-embed="true"] .container      -> .arch-slot[data-embed="true"] .container
 *   html[data-embed="true"] body            -> .arch-slot[data-embed="true"]
 *   body                                    -> .arch-slot
 *   h1 / .toolbar                           -> .arch-slot h1 / .arch-slot .toolbar
 */
function prefixSelector(sel, slot) {
  let s = sel.trim();
  if (!s) return s;
  if (s.startsWith('@')) return s;
  if (s === ':root') return `.${slot}`;
  if (s.startsWith('[')) return `.${slot}${s}`;

  s = s.replace(/\bhtml\b/g, `.${slot}`);
  s = s.replace(/\b:root\b/g, `.${slot}`);
  // html[data-x] body —— body 就是槽位本身，不能留成后代
  s = s.replace(/\s+body\b/g, '');
  s = s.replace(/^body\b/, `.${slot}`);

  if (!s.includes(`.${slot}`)) s = `.${slot} ${s}`;
  return s;
}

/** 递归给 CSS 加作用域；@media/@supports 往里递归，@keyframes/@font-face 原样保留 */
function scopeBlock(css, slot) {
  let out = '';
  let i = 0;
  const n = css.length;

  while (i < n) {
    if (css.startsWith('/*', i)) {
      const e = css.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (/\s/.test(css[i])) {
      out += css[i];
      i += 1;
      continue;
    }

    let j = i;
    let buf = '';
    while (j < n && css[j] !== '{' && css[j] !== ';') {
      buf += css[j];
      j += 1;
    }
    if (j >= n) {
      out += css.slice(i);
      break;
    }
    if (css[j] === ';') {
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    const selector = buf.trim();
    let depth = 1;
    let k = j + 1;
    while (k < n && depth > 0) {
      if (css[k] === '{') depth += 1;
      else if (css[k] === '}') depth -= 1;
      if (depth === 0) break;
      k += 1;
    }
    const body = css.slice(j + 1, k);

    if (/^@(keyframes|font-face)/.test(selector)) {
      out += `${selector}{${body}}`;
    } else if (/^@(media|supports|container)/.test(selector)) {
      out += `${selector}{${scopeBlock(body, slot)}}`;
    } else {
      const scoped = selector.split(',').map((s) => prefixSelector(s, slot)).join(',\n');
      out += `${scoped}{${body}}`;
    }
    i = k + 1;
  }
  return out;
}

function buildScopedCss(htmlFiles) {
  // 多个产物共用同一份模板，CSS 是一样的；只处理第一份，其余仅做一致性校验
  const first = extractStyle(read(htmlFiles[0]));
  for (const f of htmlFiles.slice(1)) {
    const other = extractStyle(read(f));
    if (other !== first) {
      console.error(`警告：${path.basename(f)} 的 CSS 与第一份不一致，将单独再注入一份（id 前缀已隔离，不会冲突）`);
    }
  }
  const scoped = scopeBlock(renameKeyframes(first), SLOT);
  verifyClassNamesPreserved(first, scoped);
  return `/* archify 图表样式（.arch-slot 作用域化，全部图共用一份，只注入一次） */\n${scoped}`;
}

/**
 * 回归护栏：作用域化只能「加前缀」，绝不能改动或吞掉已有的类名。
 * 历史故障：keyframes 全局改名曾把 `.pulse-dot` 一起改成 `.arch-pulse-dot`，
 * 导致 11 条规则匹配不上标记而失效，且构建过程完全不报错。这里在每次生成时自检。
 */
function verifyClassNamesPreserved(before, after) {
  const collect = (css) => {
    const set = new Set();
    for (const m of css.matchAll(/\.([A-Za-z_-][\w-]*)/g)) set.add(m[1]);
    return set;
  };
  const a = collect(before);
  const b = collect(after);
  b.delete(SLOT);

  const missing = [...a].filter((c) => !b.has(c));
  if (missing.length) {
    throw new Error(
      `CSS 作用域化损坏了 ${missing.length} 个类名：${missing.slice(0, 10).join(', ')}\n` +
        `这说明选择器改写逻辑误伤了原有类名，图会渲染异常 —— 先修 scripts/archify-inline.mjs 再继续。`
    );
  }
}

/* ------------------------------------------------------------------ *
 * 3. SVG id 命名空间隔离
 * ------------------------------------------------------------------ */

function namespaceSvg(svg, slotId) {
  const ids = new Set();
  for (const m of svg.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  const map = new Map([...ids].sort((a, b) => b.length - a.length).map((id) => [id, `${id}-${slotId}`]));

  let out = svg;
  // aria-labelledby 是空格分隔的 id 列表，必须整体重写，不能走逐 id 替换
  out = out.replace(/aria-labelledby="([^"]*)"/g, (_m, v) =>
    `aria-labelledby="${v.split(/\s+/).map((t) => map.get(t) || t).join(' ')}"`);
  for (const [oldId, newId] of map) {
    out = out.split(`id="${oldId}"`).join(`id="${newId}"`);
    out = out.split(`url(#${oldId})`).join(`url(#${newId})`);
    out = out.split(`href="#${oldId}"`).join(`href="#${newId}"`);
    out = out.split(`xlink:href="#${oldId}"`).join(`xlink:href="#${newId}"`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. 片段组装 + 运行时
 * ------------------------------------------------------------------ */

const CHROME_CSS = `/* archify 图表外壳 —— 用宿主设计系统 token，不引入新配色 */
.arch-figure{margin:20px 0;border:1px solid var(--border);border-radius:16px;
  background:var(--mask);overflow:hidden}
.arch-figure-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;
  border-bottom:1px solid var(--border);background:rgba(2,6,23,.35)}
.arch-figure-title{font-size:12px;font-weight:700;letter-spacing:.06em;
  color:var(--frontend);margin-right:auto}
.arch-figure-bar button{background:var(--canvas);color:var(--muted);
  border:1px solid var(--border);border-radius:8px;padding:4px 9px;
  font-family:var(--mono);font-size:12px;cursor:pointer;line-height:1.4}
.arch-figure-bar button:hover{color:var(--ink);border-color:var(--frontend)}
.arch-figure-bar button:focus-visible{outline:2px solid var(--frontend);outline-offset:1px}
.arch-slot{position:relative;background:var(--canvas)}
.arch-diagram-viewport{overflow:hidden;background:var(--canvas);
  height:min(70vh,620px);cursor:grab}
.arch-diagram-viewport.is-panning{cursor:grabbing}
.arch-diagram-viewport svg{display:block;width:100%;height:100%;
  transform-origin:0 0;touch-action:none}
.arch-diagram-viewport svg [data-node-id]{cursor:pointer}
.arch-diagram-viewport svg [data-node-id].is-focused{filter:brightness(1.35)}
.arch-diagram-hint{color:var(--dim);font-size:12px;padding:6px 12px;
  border-top:1px solid var(--border)}
`;

const RUNTIME = `(function (global) {
  var MIN = 0.4, MAX = 4, STEP = 1.2;

  function vpOf(root) { return root.querySelector('.arch-diagram-viewport'); }
  function svgOf(root) { return root.querySelector('svg'); }
  function st(root) {
    if (!root.__archState) root.__archState = { k: 1, x: 0, y: 0 };
    return root.__archState;
  }
  function apply(root) {
    var s = svgOf(root), v = st(root);
    if (!s) return;
    s.style.transformOrigin = '0 0';
    s.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.k + ')';
  }
  function setView(root, k, x, y) {
    var v = st(root);
    v.k = Math.max(MIN, Math.min(MAX, k)); v.x = x; v.y = y;
    apply(root);
  }
  function zoomAt(root, factor, cx, cy) {
    var v = st(root);
    var nk = Math.max(MIN, Math.min(MAX, v.k * factor));
    var nx = cx - (cx - v.x) * (nk / v.k);
    var ny = cy - (cy - v.y) * (nk / v.k);
    setView(root, nk, nx, ny);
  }
  function zoomCenter(root, factor) {
    var vp = vpOf(root); if (!vp) return;
    var r = vp.getBoundingClientRect();
    zoomAt(root, factor, r.width / 2, r.height / 2);
  }
  function reset(root) { setView(root, 1, 0, 0); }
  function fit(root) {
    var vp = vpOf(root), s = svgOf(root);
    if (!vp || !s) return reset(root);
    var vb = (s.getAttribute('viewBox') || '').split(/\\s+/).map(Number);
    if (vb.length !== 4 || !vb[2] || !vb[3]) return reset(root);
    var k = Math.min(vp.clientWidth / vb[2], vp.clientHeight / vb[3]);
    setView(root, k, 0, 0);
  }

  function focusNode(root, node) {
    var prev = root.querySelector('[data-node-id].is-focused');
    if (prev) prev.classList.remove('is-focused');
    if (!node) return;
    node.classList.add('is-focused');
    root.dispatchEvent(new CustomEvent('archify:nodefocus', {
      bubbles: true, detail: { nodeId: node.getAttribute('data-node-id'), label: node.getAttribute('data-node-label') || '' }
    }));
  }

  function mount(root) {
    if (!root || root.__archMounted) return;
    root.__archMounted = true;
    var vp = vpOf(root);
    if (!vp) return;

    root.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        if (act === 'zoom-in') zoomCenter(root, STEP);
        else if (act === 'zoom-out') zoomCenter(root, 1 / STEP);
        else if (act === 'reset') reset(root);
        else if (act === 'fit') fit(root);
      });
    });

    vp.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 2) return;
      e.preventDefault();
      var r = vp.getBoundingClientRect();
      zoomAt(root, e.deltaY < 0 ? STEP : 1 / STEP, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    var dragging = false, lastX = 0, lastY = 0;
    vp.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      vp.classList.add('is-panning');
      vp.setPointerCapture(e.pointerId);
    });
    vp.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var v = st(root);
      setView(root, v.k, v.x + (e.clientX - lastX), v.y + (e.clientY - lastY));
      lastX = e.clientX; lastY = e.clientY;
    });
    function endDrag() { dragging = false; vp.classList.remove('is-panning'); }
    vp.addEventListener('pointerup', endDrag);
    vp.addEventListener('pointercancel', endDrag);

    vp.addEventListener('click', function (e) {
      var node = e.target.closest ? e.target.closest('[data-node-id]') : null;
      focusNode(root, node);
    });

    vp.addEventListener('keydown', function (e) {
      if (e.key === '+' || e.key === '=') zoomCenter(root, STEP);
      else if (e.key === '-' || e.key === '_') zoomCenter(root, 1 / STEP);
      else if (e.key === '0') reset(root);
      else if (e.key === 'f' || e.key === 'F') fit(root);
    });
    vp.setAttribute('tabindex', '0');

    // 宿主用 display:none 切换章节时，隐藏槽位 clientWidth=0，
    // 立刻 fit 会算出 0 倍（被钳到 0.4）并残留。改为可见后再适配。
    if (vp.clientWidth > 0) {
      fit(root);
    } else if (typeof global.IntersectionObserver === 'function') {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting && vp.clientWidth > 0) {
            fit(root);
            io.disconnect();
            break;
          }
        }
      });
      io.observe(vp);
    }
  }

  function mountAll(scope) {
    (scope || document).querySelectorAll('.arch-slot').forEach(mount);
  }

  global.ArchifyInline = {
    mount: mount, mountAll: mountAll, fit: fit, reset: reset,
    zoomIn: function (r) { zoomCenter(r, STEP); },
    zoomOut: function (r) { zoomCenter(r, 1 / STEP); }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mountAll(); });
  } else {
    mountAll();
  }
})(window);
`;

function slotIdFor(file, explicit) {
  if (explicit) return explicit;
  const base = path.basename(file, path.extname(file));
  return base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'diagram';
}

function buildFragment(html, slotId, theme = 'dark') {
  const svgRaw = findMainSvg(html);
  const svg = namespaceSvg(svgRaw, slotId);
  const titleM = svg.match(/<title id="archify-diagram-title[^"]*">([\s\S]*?)<\/title>/);
  const descM = svg.match(/<desc id="archify-diagram-description[^"]*">([\s\S]*?)<\/desc>/);
  const title = titleM ? titleM[1].trim() : '';
  const desc = descM ? descM[1].trim() : '';

  return {
    slotId,
    title,
    description: desc,
    svgBytes: Buffer.byteLength(svg),
    html: `<figure class="arch-figure">
  <div class="arch-figure-bar">
    <span class="arch-figure-title">${escapeHtml(title)}</span>
    <button type="button" data-act="zoom-out" aria-label="缩小">−</button>
    <button type="button" data-act="zoom-in" aria-label="放大">+</button>
    <button type="button" data-act="fit" aria-label="适应画布">适应</button>
    <button type="button" data-act="reset" aria-label="复位">复位</button>
  </div>
  <div class="arch-slot" data-archify-slot="${escapeAttr(slotId)}" data-theme="${escapeAttr(theme)}" data-embed="true">
    <div class="arch-diagram-viewport">
      ${svg}
    </div>
  </div>
  ${desc ? `<figcaption class="arch-diagram-hint">${escapeHtml(desc)}</figcaption>` : ''}
</figure>`,
  };
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

/* ------------------------------------------------------------------ *
 * 5. CLI
 * ------------------------------------------------------------------ */

function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error('用法: node scripts/archify-inline.mjs <css|chrome|runtime|svg|bundle> ...');
    process.exit(1);
  }

  if (cmd === 'css') {
    const files = filesAfter(3);
    if (!files.length) throw new Error('至少给一个 archify HTML');
    const css = buildScopedCss(files);
    console.error(`已作用域化 CSS：${(Buffer.byteLength(css) / 1024).toFixed(0)} KB（${files.length} 份产物，共用一份）`);
    writeOut(arg('-o'), css);
    if (!arg('-o')) process.stdout.write(css);
    return;
  }

  if (cmd === 'chrome') {
    writeOut(arg('-o'), CHROME_CSS);
    if (!arg('-o')) process.stdout.write(CHROME_CSS);
    return;
  }

  if (cmd === 'runtime') {
    writeOut(arg('-o'), RUNTIME);
    if (!arg('-o')) process.stdout.write(RUNTIME);
    return;
  }

  if (cmd === 'svg') {
    const files = filesAfter(3);
    if (!files.length) throw new Error('需要一个 archify HTML');
    const frag = buildFragment(read(files[0]), slotIdFor(files[0], arg('--slot')), arg('--theme', 'dark'));
    console.error(`已抽取主图：${frag.title} · ${(frag.svgBytes / 1024).toFixed(0)} KB`);
    writeOut(arg('-o'), frag.html);
    if (!arg('-o')) process.stdout.write(frag.html);
    return;
  }

  if (cmd === 'bundle') {
    const positional = filesAfter(3); // 已剔除 --theme 及其取值
    const outPath = positional[0];
    const files = positional.slice(1);
    if (!outPath || !files.length) throw new Error('用法: bundle <out.json> <archify.html...>');
    const theme = arg('--theme', 'dark');
    const bundle = {
      generatedBy: 'scripts/archify-inline.mjs',
      slotClass: SLOT,
      theme,
      css: buildScopedCss(files),
      chromeCss: CHROME_CSS,
      runtime: RUNTIME,
      diagrams: files.map((f) => buildFragment(read(f), slotIdFor(f), theme)),
    };
    fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2), 'utf8');
    const kb = (n) => (n / 1024).toFixed(0) + ' KB';
    console.error(`bundle → ${outPath}`);
    console.error(`  图表 ${bundle.diagrams.length} 张，合计 ${kb(bundle.diagrams.reduce((s, d) => s + d.svgBytes, 0))}`);
    console.error(`  共用 CSS ${kb(Buffer.byteLength(bundle.css))}（只注入一次）`);
    return;
  }

  console.error(`未知命令: ${cmd}`);
  process.exit(1);
}

main();
