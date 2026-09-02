---
name: biz-doc-generator
description: Analyzes a codebase (single repo or multi-service) and produces a single self-contained interactive HTML file (double-click to open in a browser, no server needed) covering business-facing documentation for new-hire onboarding — an interactive architecture/dependency diagram, domain model, clickable state machines, a rule-threshold calculator, business rule handbook, glossary, and a business map/learning path. Use this whenever the user asks to "document the business logic," "help new hires understand this system," "generate business documentation from the code," "draw/visualize the architecture," "explain what this codebase does at a business level," or references pain points like docs being out of sync with code, terminology being inconsistent across teams, or business rules only living in senior engineers' heads. Also use for incremental doc updates after a code change, and for flagging undocumented/tacit business rules for human review. Trigger even if the user just says "help me understand this legacy system," "onboard me to this codebase," or "draw me a diagram of this repo."
---

# 业务文档生成器（biz-doc-generator）

## 这个 skill 解决什么问题

企业级系统的业务知识散落在代码、数据库、老员工脑子里，新人靠读代码猜业务，AI生成的文档又容易"像提纲不像文档"——只有定义没有例子，只写正常流程不写异常分支，写完就和代码脱节。

这个 skill 不是"让 LLM 读一遍代码然后自由发挥写文档"。核心原则是：**能从代码/schema/配置里确定性提取的事实，一定要先提取再组织，不要让模型凭印象生成；无法从代码里推断的（隐性规则、设计动机），必须明确标注"需要人工确认"，绝不编造。** 这是文档可信度的生命线——一份"看起来很详细但有一半是编的"的文档，比没有文档更危险。

同样不允许自由发挥的还有两件事：业务流程的覆盖范围（不能凭感觉挑"看起来重要"的写，见 Phase 1 末尾的完整性核对）、以及视觉设计（固定用 `assets/archify/DESIGN.md` 的设计系统，不即兴创作，见 `references/10-build-approach.md`）。

## 落盘优先（贯穿所有阶段，不只是 Phase 1）

**分析出来的结构化事实必须在分析出来的当下就写进磁盘文件，不能只停留在对话上下文里。** 大代码库分析到中途，上下文可能被压缩，压缩会丢失还没落盘的细节。不要按"整个阶段做完再统一写文件"的节奏工作，按处理单元（一个入口点/一个实体分析完）就立刻落盘，同时维护一份进度清单——压缩发生后，恢复工作的第一步是读磁盘上已有的文件和进度清单，不是凭对压缩摘要的模糊印象判断"做到哪了"。真的丢了某段分析，如实告诉用户需要重新分析，不要基于模糊印象编一份看起来完整实则臆测的内容。细节见 `references/01-extraction.md` 开头"落盘优先"一节。

## 依赖的内置工具

`assets/archify/` 是 vendored 进本 skill 的 archify（MIT 协议，已验证可离线零安装运行，`node assets/archify/bin/archify.mjs doctor` 能自检）——Phase 3 架构图/状态图/时序图/流程图统一用它生成，不要手写 SVG。用户不需要单独安装这个工具，它已经是本 skill 的一部分。

`scripts/biz-deps-to-archify.mjs` 和 `scripts/biz-state-machine-to-archify.mjs` 是在 archify 之上做的二次开发适配层——把 Phase 1 提取的依赖图/状态迁移表自动转成 archify spec，减少手写 JSON 的工作量。已用真实的多分支状态机和多域依赖图测过：schema 层面能一次通过，几何布局（连线穿越、标签间距）复杂场景下大概率还需要按 archify 诊断手动修 1-3 轮——这是真实验证过的结论，不是想当然。细节见 `references/07a-diagram-generation.md`。

`scripts/scan-entry-points.mjs` 和 `scripts/check-entry-coverage.mjs` 是 Phase 1 完整性保证的可执行工具——前者多语言/多框架正则扫描穷举入口点（已用混合 Java/Express/FastAPI/Click 的样例测过，零漏报），后者反向核对文档覆盖率、点名哪些入口点还没处理。细节见 `references/01-extraction.md`。

`scripts/codegraph-extract.mjs` 是把 codegraph（`@colbymchenry/codegraph`，tree-sitter 真解析，20+ 语言）封装成**贯穿多个阶段的代码知识图数据源**的可选增强：

- **Phase 1**：`candidates` 按 kind 分组导出全项目符号（接口/类/枚举/函数/方法…）作为提取的**候选清单底座**；`callers`/`callees` 补全状态机触发链、规则影响面；`scan-symbols` 交叉核验正则候选是否真的接入运行时（把模板/脚手架标 `flagged`）。

- **Phase 3**：`callers`/`callees`（符号级调用图，比 file-import 边可信）交叉校验架构依赖图的方向。

- **Phase 6 增量**：`impact` 把"改了哪些符号"映射成"文档哪一段该更新"，精确改受影响段落，是解决"文档与代码脱节"痛点的最强工具。

**它是可选依赖，环境没装就回落到正则扫描器，不影响主流程**；env 里需要先 `npm i -g @colbymchenry/codegraph`。有几个实测复现过的边界要记住：它**不提供开箱即用的入口点穷举**（入口点完整性仍靠 scan-entry-points.mjs）；**文件级 import 依赖边在部分语言（实测 Dart）不可靠**（依赖图用符号级 callers/callees 交叉校验，不押在 file-import 上）；`context` 语义检索不吃中文任务、要吃英文/代码关键词。细节见 `references/01-extraction.md` 的"可选增强：codegraph"、`references/04-incremental-update.md`、`references/07a-diagram-generation.md`。

## 何时使用

- 用户要求"生成业务文档"、"帮新人理解这个系统"、"整理业务逻辑"、"这个系统是做什么的"

- 用户提到文档和代码脱节、术语不统一、业务规则没人讲得清

- 代码有变更后，用户想增量更新已有的业务文档（而不是全量重跑）

## 整体流程（六阶段流水线）

**不要跳过阶段直接生成文档。** 每个阶段的产出是下一阶段的输入，跳过 Phase 1 直接让模型"读代码写文档"就会退化成普通的、空洞的 AI 生成文档——这正是要解决的痛点之一。

```
Phase 0  业务域边界确认   微服务/多仓库 → 域边界（仓库/服务边界优先，代码信号兜底，不确定就问）
Phase 1  结构化提取     代码/schema/配置 → 确定性事实（实体、状态迁移、规则条件、命名映射、全部入口点清单）
Phase 2  语义整合       结构化事实 → 领域模型/核心流程/规则手册/词汇表（LLM 组织，但基于事实，不自由发挥）
Phase 3  架构图生成     用 archify（assets/archify/）生成架构/状态机/时序/流程/数据流图，validate → deliver
Phase 4  交互化呈现     状态机/规则阈值/术语 → 可交互组件（不是静态图表，术语自动关联词汇表）
Phase 5  打包成单文件   所有章节 + 全部交互组件 + archify 图表(原生内联) → 一个双击即可打开的 .html 文件
Phase 6  增量同步 / 人工确认层   git diff 增量更新（按需触发）；隐性规则清单（贯穿全程）
```

**最终交付物是一个单文件 HTML**，不是一堆 Markdown 文件 + 分散的 artifact 链接。用户应该能双击这一个文件、在浏览器里打开，看到左侧导航（业务地图/领域模型/架构图/核心流程/规则手册/词汇表/待确认清单），右侧内容区里的状态机、规则计算器、架构依赖图全部是内嵌的可交互组件，不需要额外打开别的页面或工具。打包方式见 `references/07-single-html-packaging.md`。

先读完这份 SKILL.md 再进入各阶段的参考文档 —— 不要一上来就直接读全部 references/，按需读：

- 首次生成文档（一个新代码库）→ 依次执行 Phase 1 → 2 → 3 → 4 → 5，参考 `references/01-extraction.md`、`references/02-synthesis-checklist.md`、`references/12-content-depth-gate.md`、`references/07a-diagram-generation.md`、`references/03-interactive-artifacts.md`、`references/09-glossary-tooltips.md`、`references/10-build-approach.md`、`references/07-single-html-packaging.md`；同时贯穿 `references/05-human-verification.md`

- 交付前跑内容深度门禁，或想知道"业务讲清楚了没有"的机器判定标准 → 读 `references/12-content-depth-gate.md`，配套样例 `examples/content-depth-pass-sample.html`

- 状态机要写成 `unknown → running` 这种裸流转？主流程嵌套子流程不知道怎么分层？分析 WMS/ERP 这类术语密集的企业系统？→ 读 `references/13-business-deep-reading.md`（R12 状态业务化 / R13 流程四层拆解 / 企业级业务解读与术语四段式）

- 微服务/多仓库、涉及多个业务域 → 先读 `references/08-domain-segmentation.md`，域边界要在 Phase 1 之前定下来

- 代码有变更，更新已有文档 → 只读 `references/04-incremental-update.md`

- 决定最终文档的目录结构/学习路径怎么组织 → 读 `references/06-output-structure-and-map.md`

- 多仓库/跨部门业务链路的处理方式 → 在 `references/01-extraction.md` 末尾的"跨域场景"小节，以及 `references/08-domain-segmentation.md`

- 生成架构依赖图 → 读 `references/07a-diagram-generation.md`

- 决定用 React 工程编译还是手写原生 JS 交付 → 读 `references/10-build-approach.md`

- 术语/黑话怎么让读者随读随懂 → 读 `references/09-glossary-tooltips.md`

- 最终单文件 HTML 怎么组装 → 读 `references/07-single-html-packaging.md`

## Phase 0 · 业务域边界确认（微服务/多仓库场景，细节见 references/08-domain-segmentation.md）

在做任何提取之前，如果目标是微服务/多仓库项目，先确定业务域边界——优先用仓库/服务边界和用户已有的说法，代码信号（依赖强度、共享数据库）只作兜底。**域边界不确定就直接问用户，不要自己拍脑袋分**，因为后面所有章节的分类、导航、图的聚类都依赖这一步。单体应用或域边界本身很清晰的项目可以跳过这一步。

## Phase 1 · 结构化提取（细节见 references/01-extraction.md）

在写任何一句业务文档之前，先用工具（grep/AST 分析/schema 读取，能用脚本做的不要让模型"读一遍猜"）提取：

1. **领域模型**：ORM 实体定义 / DDL / 表结构注释 → 实体、字段、关系
2. **状态机**：枚举定义 + 所有对该字段赋值的代码路径 → 状态迁移表（要基于控制流事实，不是猜的）。**迁移必须业务化（R12）**：每条迁移带触发者、业务动作、业务意义，每个状态带业务定义——交付单位是"任务创建/资源占用/执行下发/完成回执"这类业务动作，不是 `unknown → running` 式的字面量流转；`unknown` 这类字面量状态必须解释成因，解释不了标待确认。细节见 `references/13-business-deep-reading.md`
3. **业务规则**：if-else 条件分支、配置阈值、灰度开关 → 条件表达式 + 数值边界原文
4. **术语映射**：跨模块/跨仓库的类名、字段名、注释 → 同义词聚类

如果 Phase 0 划分了业务域，这一步提取的每一条数据都要带上 `domain` 标签（细节见 `references/08-domain-segmentation.md`），不要等 Phase 2 再回头补。

这一步的产出应该是**结构化的中间数据**（比如 JSON/表格），不是文字段落，且结构对齐 `schemas/phase1.schema.json` 的契约（每条事实尽量带 source\_ref）。**离开 Phase 1 前必须跑** **`node scripts/check-phase1.mjs`**：它校验落盘数据的结构、核对集合文件是否齐全、汇总条目数——新会话靠它一次读回 Phase 1 全貌，不跑就等于落盘没有兜底。Phase 2 再把通过校验的数据组织成文档。

**完整性是硬性要求，不是尽力而为**：先用 `scripts/scan-entry-points.mjs` 穷举代码库里所有入口点（接口/消息消费者/定时任务/CLI/事件监听，多语言/多框架正则扫描，已实测能在混合 Java/Express/FastAPI/Click 代码里做到零漏报），产出一份结构化入口点清单，每条都要有明确处理结论（`detailed`/`recorded`/`flagged` 三态之一）。交付前用 `scripts/check-entry-coverage.mjs` 反向核对文档覆盖率，产出可点名的"还有哪几条没处理"清单，不是笼统的百分比。不要凭"看起来重要"筛选流程，判断标准是入口点是否存在，不是主观的重要程度。细节见 `references/01-extraction.md` 末尾"完整性保证"一节。

## Phase 2 · 语义整合（细节见 references/02-synthesis-checklist.md）

把 Phase 1 的结构化事实组织成文档时，每一段落必须通过一个"反空洞检查清单"（在 references 里）——例如：每个核心概念是否有具体例子、每个流程是否写了异常分支、每条规则是否带了原始数值。这是解决"AI生成文档像提纲"这个痛点的关键机制，不能靠 prompt 里说一句"请详细一点"就指望模型自觉。

**内容写完后、打包之前，先跑一次** `node scripts/check-content-depth.mjs`。不要等 Phase 5 打包完再跑：此刻报"图注不足 200 字"改的是段落，打包后报同样的问题改的是 HTML，后者成本高一个数量级。这份脚本要检查的标记约定（图的 `figure`/`figcaption`、架构五问的 `data-r6`、流程五维度的 `data-flow`/`data-r5`、入口点的 `data-entry-*`）见 `references/12-content-depth-gate.md`，骨架可直接照抄 `examples/content-depth-pass-sample.html`。

## Phase 3 · 架构图生成（细节见 references/07a-diagram-generation.md）

不手写 SVG——用 vendored 在 `assets/archify/` 的 archify 生成架构图/状态机图/时序图/数据流图/流程图，走它的 `validate → deliver` 标准流程，产物是独立的自包含 HTML，再经 `scripts/archify-inline.mjs bundle` 原生内联进 Phase 5 的最终单文件——R1 禁止任何形态的 iframe（含 srcdoc），避免转义断裂与 CORS 问题。图的类型对应关系、如何按域分层出图，见参考文档。

## Phase 4 · 交互化呈现（细节见 references/03-interactive-artifacts.md、references/09-glossary-tooltips.md）

状态机、规则阈值这类内容，用可交互组件呈现（可输入数值验证命中哪条规则、点击状态节点看迁移条件），而不是静态表格/流程图截图。正文里出现的术语/黑话要自动关联词汇表（hover 出解释、点击跳转全文），不要让读者读到一个不认识的词就卡住——细节见 `references/09-glossary-tooltips.md`。

## Phase 5 · 打包成单文件 HTML（细节见 references/07-single-html-packaging.md、references/10-build-approach.md）

把 Phase 2 的文字内容、Phase 3 的架构图、Phase 4 的交互组件，全部组装进一个自包含的 `.html` 文件——CSS/JS 内联、无外部依赖（或仅用可离线兜底的 CDN），左侧导航 + 右侧内容区，双击即可在浏览器打开，不需要起服务、不需要额外工具。

组装方式上有两条路：手写原生 JS/CSS 直接内联（默认、零构建、离线保真），或者用 React 工程配合 `vite-plugin-singlefile` 编译成单文件（组件多、想要更高视觉完成度、且确认环境能跑 npm 时更划算）。**先读** **`references/10-build-approach.md`** **按里面的探测步骤决定走哪条路，不要默认一条路走到黑**，尤其是这个代码库以前经常在内网/离线环境工作，构建能不能跑起来需要提前确认。无论走哪条路，视觉设计都固定用同一套 token，不是每次重新设计——见下方"视觉设计"一节。

**交付前硬性门禁**：打包完成后必须跑 `node scripts/check-final-html.mjs <final.html>`，它机器化检查 R1（无任何 iframe，含 srcdoc）、无外部/本地 script src、无外部 link（Google Fonts 字体兜底除外）、无运行时 fetch/XHR/WebSocket、标签成对闭合、图表槽位确有内联 SVG、正文无双重转义（R11）。有 error 一律不交付。

**但它只保证"打得开"，不保证"讲得清楚"。** 交付前必须再跑 `node scripts/check-content-depth.mjs <final.html> --coverage <coverage-report.json> --entries <entry-points.json>`，它检查 R9（R5 流程五维度 / R6 架构五问 / R7 图注 / R8 小业务展开是否都有机器可定位的落点）、R10（占位符零容忍）、R11（转义）。有 error 一律不交付。

这两个脚本的分工是踩过坑之后定下来的：Russh 实测产物 356 KB、正文只有约 2.6k 中文、7 张图图注全是 20-70 字符、29/38 个入口点一句话带过、15 处"（同上触发，未单列）"、10 处 `&amp;quot;` 双重转义——**而它通过了当时 check-final-html.mjs 的全部检查**。原因很简单：R5/R6/R7 在 references 里写着"必须全部答出，不能跳过"，但当时没有任何脚本检查这句话。**一条规则没有对应的可执行检查，它的实际效力等于零。** 这就是 R9/R10/R11 存在的原因，细节见 `references/12-content-depth-gate.md`。

## 视觉设计：固定用 archify 的设计系统，不即兴发挥

整份单文件 HTML（不只是图表）统一用 `assets/archify/DESIGN.md` 定义的 token——深色 midnight console 配色 + JetBrains Mono 等宽字体 + 固定语义色（frontend 青/backend 绿/database 紫/cloud 琥珀/security 玫瑰/messagebus 橙），只允许 Dark/Light 两个开关，没有第三种风格。这些 token 直接抄成 CSS 变量写死在最终 HTML 里，不是"参考一下这个设计系统再自由发挥"。不需要用户额外安装 `frontend-design` 或其他视觉相关 skill。细节和"为什么固定"的原因见 `references/10-build-approach.md`。

## Phase 6 · 增量同步 / 人工确认层

**增量同步**（细节见 references/04-incremental-update.md）：只在用户明确说"代码改了，更新文档"时使用。基于 git diff 定位受影响的实体/接口/规则/架构图节点，只重新生成对应章节，不要全量重跑 Phase 1-5。

**人工确认层**（细节见 references/05-human-verification.md）：贯穿 Phase 1-4 全程维护一份独立的"待确认清单"——记录代码里检测到但无法从代码本身确定业务动机的地方（异常复杂的条件分支、命名带 special/vip/exception 等字样的配置项、大段无注释的魔法数字）。这份清单作为单文件 HTML 里的独立一节交付，交给老员工过一遍，而不是让模型编一个听起来合理的解释填进正式文档。

## 输出结构与学习路径（细节见 references/06-output-structure-and-map.md）

最终文档不是简单堆砌，而是"业务地图 → 领域模型 → 核心流程 → 规则细节 → 异常边界"的递进结构，并标注哪些是核心主线、哪些是支撑/边缘模块。

## 关于跨部门/跨仓库场景

如果任务涉及多个仓库或多个业务域（比如"下单→支付→库存→发货"这种跨域链路），先向用户确认涉及哪些仓库/服务的路径，不要假设能从单个 repo 里推断出完整链路。跨域异常补偿路径（比如"支付成功但库存扣减失败"）尤其容易被遗漏，要显式检查每个域的补偿/回滚代码路径，而不只是正常路径。

## 交付前自检

在把文档交给用户之前确认：

- 每个业务规则是否都能追溯到具体代码位置（文件+行号或函数名），可以作为文档脚注/引用

- 是否所有"待确认"项都单独列出，没有混入正式文档正文

- 术语表是否覆盖了本次分析中发现的所有跨模块同义词

- 是否给出了推荐的阅读顺序，而不是让读者不知道从哪开始

- **入口点覆盖率**：跑一次 `node scripts/check-entry-coverage.mjs`，`stillUnreviewedList` 是否为空——不为空就必须逐条处理或明确说明原因，不能直接交付。这份覆盖率报告本身也要交付给用户（可以放进 Phase 5 单文件 HTML 的独立一节）

- **小业务有没有被一句话带过**（R9）：跑 `node scripts/check-content-depth.mjs` 时带上 `--coverage` 和 `--entries`。`recorded` 占比超过 50%、或某条 recorded 的业务说明不足 60 字符，都是"漏讲业务"的信号——漏业务的地方从来不是主流程，是这些"看起来不重要"的角落

- **内容深度门禁**：`node scripts/check-content-depth.mjs <final.html>` 的 error 项是否已清零。规则总表（R1-R13）见 `references/12-content-depth-gate.md` 末尾

- **状态机是不是裸流转**（R12）：每台状态机有 `data-sm` 标记、状态业务定义表（`data-sm-state`）、迁移业务含义行（`data-sm-tx`，含触发者+业务动作+业务意义+代码位置）。出现 `unknown → running` 这种只有字面量的迁移就是不合格——读者要的是"这个流转在业务世界里发生了什么"

- **主流程有没有拆到子流程**（R13）：`data-level="main"` 的流程至少有一个 `data-level="sub"` 子流程，子流程带调用链（file:line）和"抽掉它整体业务断在哪"的职责说明。多主流程嵌套的微服务系统按 系统级→主流程→子流程→关键方法 四层交付，见 `references/13-business-deep-reading.md` §2

- **输出结构是不是 wiki 级**：对照 `references/06-output-structure-and-map.md` v2 的 14 章结构，核心章节（背景/术语/架构/数据模型/流程分层/入口调用链/待确认）缺席会被 R9-9 点名；小型项目省略章节要在文档信息页写明原因

- **最终产物是不是一个能直接双击打开的单文件** **`.html`**，而不是散落的 Markdown/多个 artifact 链接

- **CORS/离线自检**：没有外部 `<script src>`、没有运行时 `fetch()`/`XHR`、没有指向独立文件的 `<script type="module" src="...">`、archify 图表是用 `scripts/archify-inline.mjs bundle` **原生内联**（禁止 `<iframe srcdoc>`，R1）——完整检查清单见 `references/07-single-html-packaging.md`，由 `scripts/check-final-html.mjs` 机器化执行

- 视觉呈现是否用的是 `assets/archify/DESIGN.md` 固定 token，没有随意引入这套规范之外的颜色/字体

