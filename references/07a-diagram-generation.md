# Phase 3：架构图生成（codegraph 出数据 → archify 画图 → 原生内联片段）

> **数据流（单向，不可逆）**：`codegraph`（结构化事实）→ `archify`（图渲染）→ `scripts/archify-inline.mjs`（原生内联转换）→ Phase 5 拼装进单文件 HTML。每一环只做自己职责内的事，不互相替代。

## 之前 vs 现在的差异

**之前的写法**：archify 直接渲染，正文用 `<iframe srcdoc="...">` 把整份 archify 产物塞进宿主页面。

**为什么不再用 iframe**：skill 升级后 R1 强制禁止 iframe / 外部挂载 / 弹窗——双击文件在浏览器里打开要看到一份真正一体化、原生内嵌的页面，不是把几份独立文档用 iframe 拼起来。直接 `<iframe srcdoc>` 还有几个连带问题：多图时 `getElementById` 会跨 iframe 找不到（117 处）、样式彻底隔离意味着图和宿主视觉永远两张皮、工具栏/引导视图/预设切换这些 archify 自带 chrome 与"无割裂一体化"目标冲突。

**现在的写法**：

```
1) codegraph 真解析产物（强制 R2）
     ↓ 符号级 candidates / callers / callees
2) scripts/biz-*-to-archify.mjs 把结构化事实转 archify JSON-IR
     ↓ 不碰 archify 内部渲染器
3) archify validate → deliver（9 项 artifact checks 全过、0 error/warning）
     ↓ 自包含 HTML
4) scripts/archify-inline.mjs bundle  →  {css, chromeCss, runtime, diagrams[]}
     ↓ 作用域隔离 + SVG id 命名空间 + 自研轻量交互
5) Phase 5 把 bundle 四件套内联进单文件 HTML（无 iframe）
```

**关键不变量**：
- `archify-inline` 不修改 archify 任何源码/渲染器内部逻辑，只在输入层做确定性转换
- archify 内部约束（1009 条 CSS 规则 + 23 个 keyframes + 严格的不可变布局不变量）保持原样，vendored 包才能跟随上游升级
- codegraph 缺环境时回落到正则扫描器，但产物里必须如实标注"codegraph 缺失，部分边靠正则推断"（这是 R2 的诚实兑现）

## 什么时候用哪种图类型

archify 支持 5 种图，对应到本 skill 的产出：

| archify 类型 | 用在哪里 |
|---|---|
| `architecture` | 整体架构依赖图（模块/服务/数据库/外部依赖），也用于按域聚类展示（见 `references/08-domain-segmentation.md`） |
| `lifecycle` | 状态机（订单状态、部署状态、审批状态） |
| `sequence` | 跨域调用链路（"下单→支付→库存→发货"里某个具体请求的时序） |
| `workflow` | 业务流程的步骤/审批网关（也适合把 Phase 5 增量更新的"变更影响范围"画成图） |
| `dataflow` | 库存多本账联动、数据管道 |

不要把所有内容都塞进一张 `architecture`——状态机用 `lifecycle`、时序用 `sequence`，各司其职。

## 依赖图边：codegraph 符号级调用交叉校验（R2 集中实现）

架构图的节点来自 Phase 1 的领域/模块清单，但**依赖边（谁依赖谁）**有几种信号源，强度不同：

1. **注册中心 / 路由 / 共享表**（项目的 module_registry、依赖注入、路由清单、共享 DB 表——业务层的权威）
2. **Phase 1 代码分析**（import/require、调用链）
3. **codegraph 符号级调用图**（`callers`/`callees` 基于 tree-sitter 真解析，**比 file-import 边可信**）

```bash
node scripts/codegraph-extract.mjs candidates --path <repo> --kinds class,interface  # 模块清单
node scripts/codegraph-extract.mjs callees    --path <repo> <ModuleClass.method>     # 本模块依赖谁
node scripts/codegraph-extract.mjs callers    --path <repo> <ModuleClass.method>     # 谁依赖本模块
node scripts/codegraph-extract.mjs impact     --path <repo> <changed-symbol>        # 改动影响面（Phase 6 增量更新用）
```

**判定原则**：以注册中心 + codegraph 符号级调用为准，file-import 边只作旁证。三种来源不一致的边不要凭直觉定，标成"依赖方向待确认"交给人工（进入 `pending.json`）。

实测过的边界要记住（SKILL 也写了）：codegraph **不提供开箱即用的入口点穷举**（入口点完整性仍靠 `scan-entry-points.mjs`）；**文件级 import 依赖边在部分语言（实测 Dart）不可靠**（依赖图用符号级 `callers`/`callees` 交叉校验，不押在 file-import 上）；`context` 语义检索不吃中文任务，要吃英文/代码关键词。

## 标准工作流（validate → deliver，不要跳过校验）

1. **选类型**：按上表选 `architecture`/`workflow`/`sequence`/`dataflow`/`lifecycle`
2. **读 schema 和一个示例**：`assets/archify/schemas/<type>.schema.json`、`schemas/common.schema.json`，以及 `assets/archify/examples/*.<type>.json` 对应类型一个示例——只读结构参考字段形状，事实内容必须来自 codegraph + Phase 1 真实数据，不要照抄示例里的业务内容
3. **写 JSON spec**：基于 codegraph 产出的依赖图 / 状态迁移表组装成 archify 的 JSON 输入。域标签（`domain` 字段）直接映射成 archify 的 `boundaries`（域边界框），域拆分结果不用另外发明一套可视化
4. **校验**：
   ```bash
   node assets/archify/bin/archify.mjs validate <type> <candidate.json> --quality showcase --json
   ```
   必须拿到 9 项 artifact checks 全过、0 error、0 warning 才算数，只有 4 项基础检查不算通过
5. **交付**：
   ```bash
   node assets/archify/bin/archify.mjs deliver <type> <candidate.json> <out.html> --quality showcase --json
   ```
   `deliver` 会把最终 spec 冻结、渲染、二次校验、原子提交，返回 spec 和产物的 SHA-256。**通过 deliver 校验之后不要再手改这个候选 JSON**——archify 自己的约束就是这样，凡是要改，改完重新走一遍 validate → deliver
6. **出诊断时**：看 diagnostics 里的 `subject`/`evidence`/`supportedFixes`，照着修，不要瞎调坐标——archify 有自己的排查规则

## 转原生内联片段（R1 集中实现，Phase 5 拼装的输入）

`deliver` 出来的整页 HTML **不要直接拼进宿主页面**。用 `scripts/archify-inline.mjs` 转成 bundle：

```bash
node scripts/archify-inline.mjs bundle test-instance/extraction/archify-bundle.json <out1.html> [<out2.html> ...]
```

bundle 里四件套：

| 字段 | 用途 | Phase 5 拼装位置 |
|---|---|---|
| `css` | archify 全部 CSS，作用域前缀 `.arch-slot`，keyframes 加 `arch-` 前缀；**所有图共用一份** | `<style>` 内（与 `chromeCss` 一起） |
| `chromeCss` | 自带的图外壳（toolbar / viewport / focus 高亮），用宿主 token | `<style>` 内 |
| `runtime` | 自研缩放/平移/适应/复位/节点聚焦/键盘快捷键，~3KB，挂 `window.ArchifyInline` | `<script>` 内 |
| `diagrams[].html` | 单图完整片段（图外壳 + 主图 SVG） | 各章节容器内 |

**`archify-inline` 必过的内置自检**（任一失败都拒绝输出）：

- 类名集合回归护栏：作用域化前后所有 `.classname` 必须完全一致——曾因 keyframes 全局重命名误伤 `.pulse-dot`（11 条规则失效），已加护栏防回归
- SVG id 命名空间隔离：图内 `url(#X)` / `href="#X"` / `aria-labelledby` 必须与重写后的 id 完全对应，0 断链
- 全局选择器隔离：处理后不应残留顶层 `body{` / `html{` / `:root{` / `html[` 选择器
- 无外部依赖：处理后 `<script src=http...>`、`<link href=http...>` 都为 0

**绝对不要**自己写抽取 + 拼装脚本去重做这套逻辑。id 撞车、样式污染、SVG 断链这一类问题构造时完全看不出来，渲染时却表现为"图存在但内容错位/空白"，CI 抓不到。

## 图谱节点标准化标注（R7）

每张 archify 图的每个节点、每条边都必须附**业务化标注**，不是只贴一个代号。这是把"画一张图"升级成"业务解读"的关键。标注规范：

| 维度 | 含义 | 来源 |
|---|---|---|
| **代码位置** | 节点对应的模块/类/函数 + 文件:行 | codegraph `candidates` |
| **业务含义** | 这个节点在业务里是什么角色、解决什么问题 | Phase 1 + Phase 2 |
| **上下游依赖** | 被哪些节点依赖、依赖哪些节点 | codegraph `callers`/`callees` |
| **触发条件** | 什么事件/什么条件会让这个节点执行 | Phase 1 入口点 + 状态迁移 |
| **输出结果** | 执行成功/失败后产出什么、状态怎么变 | Phase 1 状态迁移 + 异常路径 |
| **对应异常场景** | 哪些业务异常/补偿/降级会经过这里 | Phase 1 异常路径 + 待确认清单 |

标注的实现方式：

- **archify spec 层面**：节点的 `metadata` 字段里塞结构化标注（`sublabel` / `context` / `tag`），渲染时会作为 native `<title>` 展示，hover 即可见——这是"代码真实结构 → 可视化图谱 → 业务解读"闭环的最短路径
- **配套文字层面**：每张图下方必须有"业务解读"小节，把图里每个域/模块用一段话讲清楚业务定位、典型场景、异常处理。**不能只输出图谱不做文字解读**——只出图谱是退化为"图代替文档"，与 R3 业务优先冲突

**反例**（图谱 + 业务解读脱节）：输出一张干净的依赖图，节点用模块名标注，下方只写一句"如图所示为本系统架构"——这与"画一张图然后让读者自己悟"无异。
**正例**：同样一张图，节点 hover 出"部署执行器（core/deploy_executor.py:start_deploy）· 触发：POST /api/deploy · 失败处理：no hosts matched 视为失败 · 状态迁移：pending→running→success/partial/failed"，下方配套 200-400 字的"部署执行器业务解读"段落。

## 复杂度控制

architecture 图默认 `meta.quality_profile` 用 `showcase`（archify 自己的建议默认值），主路径清晰、最多 12 个主节点起步——如果模块数量大，按 Phase 0 的域拆分（`references/08-domain-segmentation.md`）先出一张"域级别"顶层架构图，再对每个域单独出细节图，读者点击域切换器时联动显示，而不是打开一张挤满几百节点的图。

**自动布局的几何局限**（用真实数据测过）：`scripts/biz-*-to-archify.mjs` 做基础的多泳道/域分列自动布局，能避免"节点完全重叠"这类基础问题；复杂一点的分支/跨域连线，validate 大概率还会报 `edge-through-node`（连线穿过无关节点）、`label-route-clearance`（标签太挤）这类诊断——**不是脚本 bug，是自动布局算法的天然局限**，按 archify 诊断信息（`fromSide`/`toSide`/`via`/`channelX`/`channelY`）手动修 1-3 轮能收敛到 showcase 级别。如果 2 轮修完错误数没有下降，如实告诉用户还有哪些诊断没解决，不要包装成"已完成"。

## 二次开发：自动把结构化事实转 archify spec

`scripts/biz-deps-to-archify.mjs` 和 `scripts/biz-state-machine-to-archify.mjs`（在 skill 根目录的 `scripts/` 下，不在 `assets/archify/` 里）是本 skill 在 archify 之上做的适配层——把 codegraph + Phase 1 提取的结构化数据直接转成 archify JSON spec，减少手写 JSON 的工作量。**这两个脚本不修改 archify 任何源码/渲染器内部逻辑**，只在输入层做转换，产出的 spec 仍要走 archify 自己的 `validate → deliver` 流程——不碰 archify 内部是有意为之：它的渲染器有非常严格的几何校验不变量，硬改容易破坏这些不变量，也会让 vendored 代码没法跟上游同步更新。

### 用法

```bash
# 状态机 → archify lifecycle spec
node scripts/biz-state-machine-to-archify.mjs test-instance/extraction/state-machines.json spec/lifecycle.json
node assets/archify/bin/archify.mjs validate lifecycle spec/lifecycle.json --quality showcase --json
# 有诊断就按提示修，改完重新 validate，收敛后再 deliver

# 依赖图（含域标签）→ archify architecture spec
node scripts/biz-deps-to-archify.mjs test-instance/extraction/dependency-graph.json spec/architecture.json
node assets/archify/bin/archify.mjs validate architecture spec/architecture.json --quality showcase --json
```

两个脚本的输入格式（字段名、示例）写在各自文件顶部注释里，Phase 1 提取阶段产出数据时最好直接对齐，省得再转一次。域标签（`domain` 字段）直接映射成 archify 的 `boundaries`（域边界框）。

`sequence`（跨域时序）和 `dataflow`（数据流）暂时没有对应的自动转换脚本——出现频率较低（"多本账联动"、"具体一次请求的跨域调用链"），需要时按 `assets/archify/schemas/` 和 `assets/archify/examples/` 里的示例手写 JSON，走标准 `validate → deliver` 流程即可。

## 设计规范处理

archify 自带完整设计系统（`assets/archify/DESIGN.md`，Evidence Console：深色 midnight canvas + JetBrains Mono 等宽字体 + 固定语义色 frontend/backend/database/cloud/security/messagebus）。**这套设计规范直接作为本 skill 整个单文件 HTML 的视觉基调**（R9），细节和原因见 `references/10-build-approach.md`。archify 图表内的视觉 token 与宿主页面 token 一致——不会出现"图是青色系，宿主是暖色系"这种割裂。

## 布局微调 hints（Phase 3 实测沉淀）

自动布局 + 1-3 轮按诊断修正后，个别机器/图仍会剩几条标签或走廊诊断。这类微调**不要直接改生成的 spec**（下次重跑转换就丢了），而是写进 hints 文件落盘、转换时通过 `--hints` 复跑注入：

```bash
# hints 文件格式：{ "Entity.field": { "transitions": { "from->to": { "labelAt": [x,y], "label": null } } } }
# null 表示删除该字段（如去掉重复标签）
node scripts/biz-state-machine-to-archify.mjs test-instance/extraction/state-machines.json test-instance/specs2 --all --hints test-instance/specs2/layout-hints.json
```

hints 属于 Phase 3 产物（与 spec 同目录落盘），不回写 Phase 1 数据。真实样例见 `test-instance/specs2/layout-hints.json`（6 台状态机全部收敛到 showcase PASS 用的就是它）。

### 写 hints 前必知的渲染器几何事实（读 `assets/archify/renderers/shared/geometry.mjs` 得出，实测印证）

- **端口摊开只在"全自动边"上生效**：带 `route`（非 auto）、`via`、`channelX/Y`、`labelAt` 任一字段的边**不参与**同侧端口摊开，直接用边侧中点 anchor。想让某条边回到确定的中点 anchor，给它显式 route/channel 即可。
- **默认边侧**：`defaultFromSide` 按目标相对位置——目标在右 → `right`，在下 → `bottom`；`drop` 的起点侧决定了下落走廊的 x。
- **crossing 校验豁免共享端点的边对**：两条边共享 from 或 to 时，即使几何相交也不报 `proper-crossing`（branch/merge 语义）。清理诊断时优先找**无共享端点**的相交对。
- **共线重叠不报错**：同 y 的两段水平走廊重叠（如多条 bottom-channel 共用 channelY）不会被校验拦截，但视觉难看——给每条边错开 channelY（间隔 40px 实测安全）。
- **所有段必须正交**：`via` 末点要与目标 anchor 同 x 或同 y，否则 `artifact/orthogonal-arrows` 报斜线。terminal→main 的恢复边推荐 `toSide: "bottom"`（垂直进入目标框底边）。
- **空标签 `""` 不产生标签矩形**（falsy 被跳过），去重标签时直接置 `label: null` 最干净。
- lifecycle 布局预算：main 列中心 x=[94,248,402,556,710]、框 y 126..188；相邻框间隙仅 36px，主干边标签必须放 y≈122（带上）或 y≈222（带下）；drop 走廊从 y=340 起，同一源多条出口每条 +40。
