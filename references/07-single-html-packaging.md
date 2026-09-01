# Phase 5：打包成单文件 HTML（**无 iframe 原生嵌入**，R1）

最终交付物是一个 `.html` 文件，用户双击就能在浏览器里打开——不是一堆 Markdown 文件，也不是散落在对话里的多个 artifact 链接。**所有图表、状态机、流程图必须原生嵌入到这份 HTML 的页面里，禁止用 `<iframe srcdoc>`、`<iframe src>`、外部跳转、弹窗独立展示（SKILL R1）**。

## 结构

单页应用式布局，不需要真正的路由，用 JS 做 tab/锚点切换即可：

```
┌─────────────┬──────────────────────────────────┐
│ 左侧导航      │  右侧内容区（随导航切换）              │
│ - 业务地图    │                                    │
│ - 整体架构    │  当前选中章节的内容：                 │
│ - 领域模型    │  - 文字说明（语义化 HTML 块）          │
│ - 核心流程    │  - 原生内嵌的可交互组件                │
│ - 架构图      │    （状态机/规则计算器/依赖图）       │
│ - 规则手册    │                                    │
│ - 词汇表      │                                    │
│ - 待确认清单  │                                    │
│ - 覆盖率      │                                    │
└─────────────┴──────────────────────────────────┘
```

## archify 图表的嵌入：原生内联片段（替代 iframe srcdoc）

archify 每次 `deliver` 出来的是一份**完整独立的 HTML 文档**（~700KB，自带 `<html>/<head>/<body>`、185KB CSS、4 段内联脚本、3 个外部字体 `<link>`）。直接拼进宿主页面会撞 id（单份产物里 `getElementById` 117 处）、污染全局样式（`body`/`h1`/`:root`）、写宿主 `<html>` 属性。所以用 `scripts/archify-inline.mjs` 把它转成三件原生片段，**只在宿主页面的 `<style>` / `<script>` / 章节容器里出现一次，不再有第二层文档**。

### 三件套

| 产物 | 来源 | 用法 | 注入次数 |
|---|---|---|---|
| `bundle.css` | archify 的 `<style>` 全部规则 + 每条选择器加 `.arch-slot` 作用域前缀 + keyframes 加 `arch-` 前缀 | `<style>` 里写一次 | **1 次（全部图共用）** |
| `bundle.chromeCss` | 自带的图外壳（toolbar / viewport / focus 高亮 / 提示），用宿主 token | `<style>` 里写一次 | **1 次** |
| `bundle.runtime` | 自研的缩放/平移/适应/复位/节点聚焦交互（~3KB），挂到宿主 window.ArchifyInline | `<script>` 里写一次 | **1 次** |
| `bundle.diagrams[].html` | 抽出的主图 `<svg>`（内部 id 加槽位前缀） + 宿主风格外壳 | 每张图一段，插到对应章节容器 | **N 次（每图一段）** |

### 体积对比（Russh 两张图实测）

| 方案 | 体积 | 隔离性 | 交互 |
|---|---|---|---|
| iframe srcdoc（旧，禁止） | 695KB × 2 ≈ **1.40MB** | iframe 天然隔离 | archify 自带工具栏 |
| **原生内联（当前标准，R1）** | 185KB(共用) + 17KB × 2 ≈ **0.22MB** | CSS 作用域 + SVG id 前缀 | 宿主风格工具栏 + 自研交互 |
| 多文件静态站（备选） | 单图 695KB，但多页共享 CSS/JS | 无 id 冲突（各自页面） | archify 自带 |

### 组装伪代码

```js
const bundle = JSON.parse(fs.readFileSync('archify-bundle.json', 'utf8'));
const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <title>...</title>
  <style>${hostCss} /* 导航/章节/术语 tooltip 等 */
${bundle.chromeCss}
${bundle.css}</style>
</head>
<body>
  <nav>...</nav>
  <main>
    <section id="sec-arch">
      <h2>整体架构</h2>
      ${bundle.diagrams.map(d => d.html).join('\n')}
    </section>
    <!-- ... -->
  </main>
  <script>${hostJs} /* 导航切换、tooltip */
${bundle.runtime}</script>
</body>
</html>`;
```

### 为什么 `scripts/archify-inline.mjs` 可信

该脚本已经过实测（Russh 双图），并内置了**回归护栏**：

- 自动校验作用域化前后类名集合一致——若 keyframes 全局改名误伤了 `.pulse-dot` 这类非动画类（实测早期版本踩过这个坑），构造过程直接抛错而不是把破损产物交给用户
- 自动校验 SVG 内所有 `url(#...)` / `href="#..."` / `aria-labelledby` 引用与重命名后的 id 一致（实测 0 断链）
- 脚本内自带一个**最小 viewport 交互**（缩放/平移/适应/复位/节点聚焦/键盘快捷键），全部用宿主 token 而不是 archify 自带 chrome——这正是 R1 "无割裂" 的关键

**不要绕过这个脚本**自己写抽取 + 拼装逻辑。一旦内联逻辑出错（id 撞车、CSS 选择器被破坏、SVG 断链），图就会静默渲染成"看起来对、仔细看是空壳"的状态，CI 完全抓不到。

## 组装原则

1. **一个文件，全部内联**：CSS 写在 `<style>` 里，JS 写在 `<script>` 里，**不引用相对路径的外部文件**（用户拿到的是单个文件，外部引用会失效）。archify 的字体 `<link>` 由 archify-inline 处理时已经丢弃，宿主必须用系统等宽字体兜底。
2. **Markdown 内容怎么处理**：Phase 2 产出的文字内容（领域模型说明、规则描述等）不需要引入 Markdown 渲染库现拼——直接生成阶段把结构化数据转成语义化 HTML（`<h2>`、`<table>`、`<dl>` 等），比引入 Markdown parser 更简单可靠，也避免外部依赖。
3. **交互组件内联**：状态机/规则计算器用 IIFE 挂到宿主 window，archify 图的交互由 `bundle.runtime` 提供，**作用域隔离**（`bundle.css` 的选择器都带 `.arch-slot` 前缀）。
4. **锚点导航**：左侧导航项对应右侧内容区 `id`，点击用 JS 控制 `display` 切换或 `scrollIntoView`，不引入前端框架。

## 离线兜底原则（R1 强化版）

内网/离线环境是明确存在的风险（很多企业代码库本身就在内网环境分析）。所以：

- **核心交互必须纯内联 JS**：架构图渲染、状态机交互、规则计算器、术语 tooltip——不依赖必须联网的外部 CDN。
- 想要更精美的力导向布局 → 用 archify（已 vendored，离线可跑），不要去引第三方 CDN。
- 生成完成后**实际起一个无头浏览器加载一次**（`chrome --headless --screenshot=... file://...`），确认 HTML 语法完整、`<script>` 标签闭合、archify 片段渲染正常——不要只看生成过程没报错就当作交付质量达标。

## 离线与 CORS 自检（双击打开必须过这一关）

R1 自检清单——任何一条没过都不允许交付：

- [ ] `grep -c '<iframe' <doc>.html` 应为 0（**R1：禁止 iframe 任何形式**）
- [ ] `grep -E '<script[^>]+src=' <doc>.html` 应为 0（没有外部 script）
- [ ] `grep -E '<link[^>]+href="http' <doc>.html` 应为 0（没有外部样式）
- [ ] `grep -E '<script[^>]+type="module"[^>]+src=' <doc>.html` 应为 0
- [ ] `grep -E 'fetch\(|XMLHttpRequest' <doc>.html` 应为 0（无运行时远程/本地文件请求）
- [ ] 实际用 headless Chrome 截图一次，肉眼确认：两张图都渲染、工具栏按钮可见、缩放/适应交互可用、术语 tooltip 弹出正确
- [ ] archify-inline 自检：作用域 CSS 不残留 `body{` / `html[` / `:root{`（脚本内置类名集合回归护栏，若挂会抛错）

## 体积控制（大项目要算这笔账，不是含糊估计）

用真实数字算：单张 archify 图经 archify-inline 后的 SVG 约 **17KB**，**共用 CSS 约 191KB**（只注入一次）：

- 一个中等规模微服务项目按域拆出 8 个域，每域 1 张架构图 + 2-3 个核心状态机 = `8 张架构图 + 20 张状态机 = 28 张`
- 体积 = 191KB（一次 CSS）+ 3KB 运行时（一次） + 28 × 17KB SVG ≈ **670KB**
- 对比 iframe srcdoc 旧方案 28 × 700KB ≈ 19.6MB —— **新方案大约是旧的 3%**

**触发拆分的判断标准**：预计图总量 × 17KB + 191KB 超过 **10MB** 之前，新方案下不太可能触发；超过则在 Phase 3 出图前考虑：

- 按域拆分成多个单文件 HTML（`交易域业务文档.html` 等），域间在"业务地图"总览页里互链
- 每个域内部的图数量也要有预算——只有 Phase 1 判断为"核心/复杂"的状态机才出图；二态/三态用文字表格带出来

拆分与否在 Phase 3 出图前就该跟用户确认一次预算。

## 多文件方案：真正的静态小型网站

如果按上面算法预计要拆，且用户接受多文件：

- 一个 `index.html` 总览页 + 每个域一个页面 + 一份共享的 CSS/JS
- 页面间用 `<a href="domain-b.html">` 互相跳转——浏览器正常整页导航，不受同源策略限制，离线文档站标准做法
- 共享 `<link rel="stylesheet" href="shared/styles.css">` / `<script src="shared/app.js">`（**不能带 `type="module"`**）
- 域内 archify 图依然走 `scripts/archify-inline.mjs` 原生内联，不要把图拆成独立文件再用 `iframe src` 接（那条路在 `file://` 下不稳定）

**什么时候选多文件 vs 域拆单文件**：项目预计要拆 5 个以上域/页面时优先多文件站点（共享 CSS/JS 收益大）；2-3 个域时差别不大，选简单的（每个域一个自包含单文件）。

## 大代码库生成过程的可恢复性

代码库特别大时，Phase 1-2 不可能在一次对话/一个上下文窗口里做完：

- `scan-entry-points.mjs` 在几千文件代码库上跑出几百到上千条入口点。每条人工过一遍不现实——**先自动预分类，再人工只审核预分类不确定的部分**（简单 CRUD 自动标 `recorded`，条件分支多 / 涉及状态变更 / 命中 `references/05-human-verification.md` 信号词的才人工定为 `detailed`）
- 生成过程做成**可恢复的分批流程**：先出"业务地图 + 骨架"（各章节先占位标"待补充"），按域/按优先级分批填细节，每批是检查点
- 真实大项目大概率需要跨多次对话/多个 session 提前跟用户说清楚

## 交付方式

生成完成后用 `present_files` 把这个单文件 HTML 呈现给用户，文件名要能体现内容（比如 `订单域业务文档.html`，不要用 `output.html` 这种无信息量的名字）。
