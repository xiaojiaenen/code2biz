# Phase 1：结构化提取

目标：在写文档之前，先把代码里"确定性存在"的事实提取成结构化中间数据。这一步能用脚本/grep/AST 做的，就不要靠模型"通读代码后凭印象总结"——凭印象总结正是"内容空洞、异常分支被遗漏"的根源。

## 落盘优先：分析成果不能只存在于对话上下文里

这是一条贯穿 Phase 1-2 的硬性规则，不是可选的最佳实践：**Agent 分析出来的任何结构化事实，必须在分析出来的当下就写进磁盘上的文件，不能等到"这一阶段分析完了"再统一落盘。**

原因很直接：长会话/大代码库分析到中途，上下文会被压缩（Claude Code 这类 agentic 工具在上下文接近上限时会自动摘要/压缩历史），压缩会丢失还没落盘的细节——你辛辛苦苦读了半天代码、在对话里推导出的状态迁移表、规则边界值，如果只停留在这一轮对话的"思考过程"里没有写成文件，压缩发生后这些细节大概率就找不回来了，压缩后的摘要只会留下"分析过某个模块"这种粗颗粒度的印象，具体的字段名、数值边界这些细节不会被完整保留。

**具体做法**：

- **不要按"整个 Phase 1 做完再写一个大 JSON"的节奏工作**。而是按处理单元（一个入口点/一个实体/一条状态机分析完）就立刻写一次文件——用 `memory_write`/`create_file`/`str_replace` 这类工具追加或更新磁盘上的中间数据文件，哪怕这意味着要多次小规模写入，也比一次性大写入但中途风险丢失要可靠
- **维护一份进度清单文件**（比如 `progress-manifest.json`，记录"入口点 A 已提取完成"“入口点 B 处理中”“入口点 C 还没开始"），每完成一个单元就更新这份清单。这样即使发生了上下文压缩，重新开始工作时第一步是**读这份进度清单和已经写好的中间数据文件，而不是凭对压缩后摘要的印象重新判断"做到哪了"**——摘要是不可靠的，磁盘上的文件和进度清单才是可信来源
- 配合 `scripts/scan-entry-points.mjs` 产出的入口点清单本身就是一个天然的进度追踪载体——每条记录的 `status` 字段（`unreviewed`/`detailed`/`recorded`/`flagged`）改一条就存一条，不要攒着一批改完再统一写文件
- 如果不确定当前上下文是不是快满了、要不要主动做一次检查点式落盘，**倾向于更频繁地落盘，而不是更少**——多写几次文件的成本远低于丢失一次深度分析重新来过的成本
- 真的发生了压缩导致某段分析丢失，**如实告诉用户"这部分需要重新分析"，不要基于压缩后的模糊印象编一份看起来完整但实际是臆测的内容去补那段空白**——这和 Phase 5 人工确认层"绝不替说不清的规则编解释"是同一个原则的另一种体现

## 工具优先级与 codegraph（R2 集中实现）

提取阶段有三种工具，**优先级从高到低**：

1. **codegraph**（`scripts/codegraph-extract.mjs` 包装 `@colbymchenry/codegraph`，tree-sitter 真解析）—— **强制使用**。提供符号级 `candidates` / `callers` / `callees` / `impact`，是架构依赖边、状态机触发链、规则影响面的**唯一权威数据源**
2. **`scripts/scan-entry-points.mjs`**（正则多语言扫描）—— 入口点预筛 + 兜底。codegraph 不擅长做"多语言入口点穷举"，所以两者配合：codegraph 算结构、扫描器算入口
3. **grep / 直接读源码** —— 用于补 codegraph + 扫描器覆盖不到的细节（注释里的业务说明、配置文件里的阈值原文、文档里的 AD 记录）

**codegraph 缺失时的兜底原则**：环境没装 codegraph 时必须**回落到正则扫描器 + 直接读代码**，**但要在 Phase 5 产物里如实标注"codegraph 缺失，部分边靠正则推断"**——这是为了让 R2 "零漏报"的承诺在工具缺失时不会悄悄失真，而不是装作一切都正确。

```bash
# 1) 入口点穷举（必跑，R8 完整性）
node scripts/scan-entry-points.mjs --path <repo> -o entry-points.json

# 2) codegraph 符号级（推荐，R2）
node scripts/codegraph-extract.mjs candidates --path <repo> --kinds class,interface,enum
node scripts/codegraph-extract.mjs callers    --path <repo> <ModuleClass.method>
node scripts/codegraph-extract.mjs callees    --path <repo> <ModuleClass.method>
node scripts/codegraph-extract.mjs impact     --path <repo> <changed-symbol>   # Phase 6 增量
```

**踩过的边界**（不要重复）：
- codegraph `context` 语义检索不吃中文任务，要用英文/代码关键词
- codegraph **不提供开箱即用的入口点穷举**，所以入口点完整性仍靠 `scan-entry-points.mjs`
- **文件级 import 依赖边在部分语言（实测 Dart）不可靠**——架构依赖图用符号级 `callers`/`callees` 交叉校验，不押在 file-import 上
- `scan-entry-points.mjs` 的入口点清单含**全量**（HTTP / WebSocket / schedule / mq-consumer / cli / event-listener / api-call / route / module-entry 共 9 类），不再只扫 HTTP

## 1.1 领域模型提取

来源优先级：ORM 实体类 / DDL 建表语句 / 数据库注释（COMMENT ON COLUMN）> 手写的 DTO/VO > 接口返回值的字段名推断（最不可靠，仅作补充）。

提取内容：
- 实体名、字段名、字段类型、是否可空、默认值
- 字段的数据库注释（如果有）——这是"字段业务含义"的第一手来源，痛点十一的核心解法
- 枚举字段的所有取值 + 每个取值在代码里的赋值位置（不要只列举枚举定义本身，因为枚举定义可能没有业务含义注释，真正的含义要看赋值它的业务代码上下文）
- 实体间外键/关联关系

如果表/字段没有注释：不要让模型"猜一个听起来合理的含义"直接写进正式文档。做法是：在该字段旁标注"⚠️ 无注释，含义通过代码上下文推断如下：...，建议确认"，并同步进 Phase 5 的待确认清单。

## 1.2 状态机提取

不要只列出状态机的"最终形态"表格，要基于真实控制流：

1. 找到状态字段的枚举定义
2. 全局搜索所有对该字段的赋值语句（`status = X`、`setState(X)`、ORM 的 update 调用等）
3. 对每处赋值，回溯它所在的函数/方法，记录：触发条件是什么、前置状态检查（如果代码里有 `if (status != A) throw`）、赋值后触发了哪些副作用（发消息、写日志、调用下游服务）
4. 把这些赋值点汇总成"状态迁移表"：`当前状态 → 事件/触发条件 → 目标状态 → 副作用`

这样生成的迁移表是可验证的（每一行都能对应到具体代码位置），而不是模型根据状态名称脑补的迁移关系。

异常分支同样重要：搜索该状态字段出现在异常处理代码里的位置（比如超时回滚、人工介入后状态被强制修改），这些往往是静态文档最容易漏掉的部分（对应痛点四、五）。

**先分清楚"持久化状态机"和"单次调用的结果分类枚举"，不要一律当状态机处理**（用一个真实 Flutter 项目测出来的区分）：状态机的特征是"某个实体的状态字段会持久化存储，在多次不同的操作之间发生迁移"（比如订单的 status 字段，创建、支付、发货分别是不同时间点的不同操作，状态在这些操作之间迁移）；而像 `enum ScanOutcome { ok, noTask, noStorage, duplicate, notInPlan, busy, failed }` 这种，是**单次函数调用返回值的结果分类**，不代表某个实体跨越时间的状态迁移。后者不要强行套进 Phase 3 的 lifecycle 状态图——它更适合放进 1.3 节的业务规则提取，当作"一次扫描操作的所有分支结果"来处理，每个分支对应什么后续行为（这个例子里是页面弹出不同的全屏反馈动画）。判断标准：这个枚举的值会不会被写回持久化存储（数据库字段/本地状态管理里跨请求保留的字段），会才算状态机，只是一次调用的返回值分类就不算。

## 1.3 业务规则提取

搜索目标：
- 条件表达式中出现的**数值字面量**（金额阈值、数量阈值、时间窗口）——原样记录数值，不要转述成"较大的订单"这种模糊表达
- 配置文件/配置表/feature flag/灰度开关，尤其是 key 命名带 `threshold`、`limit`、`vip`、`special`、`exception`、`whitelist` 等字样的
- 分支条件里对特定角色/客户类型/渠道的判断（`if (customerType == VIP)`）

每条规则记录格式：`条件表达式原文 + 数值边界 + 命中后的行为 + 代码位置`。不要把规则转写成自然语言之后就丢弃原始条件表达式——原文是校验用的。

## 1.4 术语映射提取

对多模块/多仓库代码库：
1. 收集每个模块/域下出现的核心名词（类名、表名、API path 里的资源名、注释里反复出现的词）
2. 对语义相近但字面不同的词做聚类（比如"订单" / "运单" / "销售单据" / "工单"——可以先用简单的共现分析：这些词是否指向同一个业务对象 ID，比如都能通过 order_id 关联）
3. 生成映射表：`统一业务概念 → 域A叫法 → 域B叫法 → 域C叫法`，并标注字段级别的映射（`orders.status` 的取值 1/2/3/4 对应 `shipments.ship_status` 的哪些取值）

如果无法确定两个词是否指向同一实体（只是语义相似，没有代码层面的关联证据），不要武断合并，标注"疑似同义词，待人工确认"。

## 1.5 可选增强：用 codegraph 做符号/调用关系提取

前面的 1.1-1.4 描述的方式是"grep + AST + 读代码"，对中小项目够用；当项目跨语言、偏大、或需要精准回答"谁调用了它""改动它影响谁"这类问题，且环境里装了 codegraph（`npm i -g @colbymchenry/codegraph`）时，可以用它作为增强数据源，而不是纯粹靠正则和人工。

**启用判断**：先探测是否可用再决定用不用，不要假设一定有：

```bash
node scripts/codegraph-extract.mjs probe --path <repo>   # 返回 installed + indexed
```

不可用（`ok:false`）就回落到 1.1-1.4 的做法——codegraph 是本 skill 的**可选依赖**，缺失不阻塞主流程。

**常见用法**（全部输出 JSON，便于结论直接进入中间数据/图表）：

```bash
node scripts/codegraph-extract.mjs init     --path <repo>                 # 建索引（会在 repo 下生成 .codegraph/，可 uninit 清理）
node scripts/codegraph-extract.mjs files    --path <repo>                 # 全部文件 + 语言 + 符号数（识别项目语言构成）
node scripts/codegraph-extract.mjs candidates --path <repo>               # Phase 1 候选清单底座：导出全部符号并按 kind 分组（interface/class/enum/function/method…），带 file+line
node scripts/codegraph-extract.mjs symbols  --path <repo> --query <kw>    # 跨语言按名搜符号（查实体/函数/接口定义位置）
node scripts/codegraph-extract.mjs callers  --path <repo> <symbol>        # 谁调用了它（状态机迁移的触发方）
node scripts/codegraph-extract.mjs callees  --path <repo> <symbol>        # 它调用了谁（副作用/下游调用）
node scripts/codegraph-extract.mjs impact   --path <repo> <symbol...>     # 改动它影响谁（增量定位，可传多个符号）
node scripts/codegraph-extract.mjs context  --path <repo> --query <task>  # 为一个任务聚合相关符号+关系
```

**对 1.1-1.4 的增强点**：
- 领域模型/规则/状态机的**候选清单底座**（增强 1.1/1.2/1.3）：`Phase 1` 一开始先跑 `candidates`，拿到全项目按 kind 分组的符号清单（接口/类=候选实体，枚举/类型别名=候选状态机，函数/方法=候选规则与入口），**作为提取的起点**，而不是凭空靠 grep 一个个猜。`--filter <dir>` 可限定到某一业务目录，`--kinds interface,enum,function` 可只取某几类。
- 状态机提取（1.2）：用 `callers` 找到"给状态字段赋值的那个方法被谁调用"，补全迁移触发的调用链，而不是只靠全局搜 `status = X` 再人工回溯。
- 业务规则提取（1.3）：用 `candidates` 穷举出所有函数/方法作为候选，配合 `callers`/`impact` 判断规则变更影响面。
- **设计动机交叉验证（Phase 2 防编造，对应痛点⑨）**：`context --query <task>` 能给一个任务聚合出相关符号、入口点与调用关系，用来确认某个实体/流程"为什么存在"的代码层线索；但如果 project 里没有任何 commit/wiki 线索，仍按 1.x 的规则标"设计动机未在代码中找到线索"，不要用 context 结果脑补。
- 正则扫描结果的交叉核验（1.1/入口点部分）：`candidates`/`scan-symbols` 能列出"类/方法存在"，`callers` 能告诉你"有没有真正被调用"——用来把 `scan-entry-points.mjs` 扫出来的候选里"扫到了但没接入运行时"的（模板/脚手架/废弃代码）标 `flagged`，而不是展开成正常业务流程。

**实测过的边界（必须记住，不要比工具更乐观）**：
1. **它不提供开箱即用的入口点穷举**——`query` 需要关键词，`explore` 是语义检索（给相关源码），都不等价于"把所有入口列全"。所以"完整性保证"（不遗漏任何业务）**仍然**要靠 `scan-entry-points.mjs` 的人为穷举 + `check-entry-coverage.mjs` 覆盖率核对，codegraph 只是补充调用关系，不替代它。
2. **文件级 import 依赖边在部分语言上不可靠**——在一个真实 Flutter 项目上实测：某个模块类明明被 `module_registry.dart` import 并实例化，codegraph 却报告"没有文件依赖它"；而另一个其实只被 import、方向的判断也会出现错乱。所以**依赖图（Phase 3 的 architecture 图）不要把边全押在 codegraph 的 file-dependents 上**，仍要交叉核对项目的注册中心/路由清单/共享表，或直接用 1.1-1.4 的方法提取。
3. `context` 的语义检索以**符号名/代码术语**为语料，用中文任务描述往往匹配不到英文符号（实测"订单状态机迁移规则"返回 0 结果，换成 `order state machine pay ship` 才能命中）。用它时 query 写**英文/代码关键词**，或先用 `candidates`/`symbols` 定位到符号名再交给它聚合关系。
4. codegraph 会在项目里生成 `.codegraph/` 目录、可能起 daemon、采集匿名 telemetry。**离线/只读/内网交付场景不要强制启用**，按需 `codegraph uninit` 清理。

## 跨域场景（多仓库/微服务）

单个 repo 分析只能覆盖一个域。如果任务目标是"下单→支付→库存→发货"这种跨域链路：

1. 先问用户这条链路涉及哪些仓库/服务，不要假设
2. 对每个域分别做 1.1-1.4 的提取
3. 找"域间调用点"：HTTP 客户端调用、消息队列的生产者/消费者、共享数据库表——这些是链路真正的连接点
4. 重点检查每个域间调用点的**补偿/回滚逻辑**（try-catch 里的补偿调用、消息重试、死信队列处理）——这是痛点七里"跨域异常补偿没人讲得清"的直接解法，正常路径通常代码本身就比较直白，补偿路径才是真正需要文档化的复杂部分
5. 把跨域链路作为独立的"主线文档"产出（比如"订单到现金"全链路），区别于单域的领域模型文档

## 完整性保证：不漏掉任何大小业务流程

用户明确要求"深入分析代码，不要漏任何大大小小的业务流程"。这不是靠"多读几遍代码、尽量仔细"就能保证的，要有一个可核对的枚举清单，而不是凭感觉判断"读得差不多了"。

### 第一步：先枚举全部入口点，再谈业务流程（用 scan-entry-points.mjs，不要靠人工通读代码找）

任何业务流程都是从某个入口点触发的。在开始梳理"有哪些业务流程"之前，先**穷举代码库里所有的入口点**，用 `scripts/scan-entry-points.mjs` 做多语言/多框架的正则扫描，产出一份结构化的入口点清单，而不是靠通读代码凭印象判断"应该找得差不多了"：

```bash
node scripts/scan-entry-points.mjs <repo-root> entry-points.json
```

已覆盖的框架模式：Spring（`@GetMapping`/`@PostMapping`/`@Scheduled`/`@KafkaListener`/`@RabbitListener` 等）、Express/Koa、Flask/FastAPI、NestJS、Go gin/echo、node-cron、Python APScheduler、Celery、Commander、Click、EventEmitter/`@EventListener`、**Flutter/Dart（GoRouter 路由、客户端 API 调用、模块插件架构）**。这份规则列表不是穷尽的——遇到没覆盖的框架语法，照着脚本里 `RULES` 的写法加一条正则规则即可，不用整个重写。

**移动端/客户端项目（Flutter/Android/iOS）的"入口点"和服务端反过来，不是接收请求的地方，是发起请求的地方。** 用一个真实 Flutter 项目（Riverpod + GoRouter + 自研模块插件架构）测出来的经验：服务端项目的入口点是"谁能触发我"（HTTP handler、MQ 消费者），客户端项目的业务流程真正的触发点是"这次操作调用了后端哪个接口"。`scan-entry-points.mjs` 里对应加了三种类型：`api-call`（识别 `xxx.get('/path...')` 这种第一参数是以 `/` 开头的字符串字面量的调用，不依赖变量名，因为不同项目 HTTP 客户端的变量名不一样，比如 `_client`/`_api`/`_dio` 都可能，靠"路径字面量"这个更稳定的特征识别，而不是变量命名）、`route`（GoRouter 的页面导航入口）、`module-entry`（如果项目本身是插件式模块架构，一个业务能力对应一个模块类）。

**扫描器能看到"类/函数存在"，看不到"这段代码有没有真的接入运行时"——这是正则扫描的天然盲区，必须在 review 阶段人工交叉核对，不能只看扫描清单**。同一个真实项目里测出来的例子：项目里有个 `_template/module.dart`，定义了一个完整的 `TemplateModule` 类实现了模块接口，扫描器正确地把它识别成一个 `module-entry` 候选——但这个类实际上是脚手架模板，从没有被写进 `ModuleRegistry.all` 那个真正生效的注册列表里，用户在 App 里永远访问不到它。review 扫描结果时，如果代码库有类似的"注册中心/入口清单"模式（一个集中列出所有生效模块/路由/任务的地方），要交叉核对一下扫描出来的候选是不是真的出现在那个注册列表里，被扫到不代表它是活的业务流程，也可能是模板/脚手架/废弃但没删除的代码——这类"扫到了但没接入"的候选，标成 `flagged` 进待确认清单，不要当成正常业务流程详细展开写。

**这是"召回优先"的正则粗筛，不是精确解析**：会有误报（同一行被多条规则同时命中——脚本会在 `alsoMatchedBy` 字段里如实标出这种情况，不会悄悄吞掉），也可能有漏报（没覆盖到的框架/写法）。用一个混合 Java/Express/FastAPI/Click 的测试样例验证过：11 个人工埋入的入口点全部被找到，唯一的问题是一处框架语法误判（Express 规则命中了 FastAPI 的 `@app.get(...)`，因为两者字面上几乎一样），扫描器把这种情况诚实地标了出来，而不是悄悄产出一条错误但看似确定的记录。**扫描结果交给人（或者下一步 Phase 2 整合时的 LLM）过一遍再定稿，不要不加甄别地全盘当作最终清单。**

具体做法：扫描产出的每条记录带 `file:line` 和匹配到的路径/条件，对应的业务模块归属如果做了域拆分（见 `references/08-domain-segmentation.md`）还要补上 `domain` 字段。

### 第二步：每个入口点都要有一个"是否已梳理"的状态

不是每个入口点都值得写成一整套详细流程（有些是简单的 CRUD 查询，业务含义有限），但**每一条都要有明确的处理结论**，而不是没提到就等于被忽略了。扫描产出的每条记录默认 `status: "unreviewed"`，人工/Phase 2 整合时改成以下三态之一：

- `detailed`：走完 Phase 1-2 全套流程提取
- `recorded`：只是简单的查询/管理类接口，业务逻辑单薄，在文档里给一行归类说明即可，不需要展开
- `flagged`：识别为异常/特例入口，进 Phase 5 待确认清单

不应该出现"清单里有但文档里完全没提到"的条目——如果某个入口点判断为不值得展开，也要有意识地标注原因，而不是遗漏。

### 第三步：用 check-entry-coverage.mjs 反向核对文档覆盖率（可执行，不是自我感觉良好）

Phase 2 文档生成完之后，回头用这个脚本核对：

```bash
node scripts/check-entry-coverage.mjs entry-points.json coverage-report.json
```

产出的报告里，`stillUnreviewedList` 是重点——不是只看总体百分比达标就行，而是每一条没处理的都要能点名。**这份覆盖率报告本身也作为交付物的一部分**（Phase 5 单文件 HTML 里可以单独一节"入口点覆盖率"），让用户能一眼看出"这份文档覆盖了代码库里几个入口点中的几个，具体哪几个还没处理"，而不是无法验证的"应该都写了"。

### 关于"大大小小"

不要只梳理"看起来重要"的核心流程而忽略琐碎的分支。判断一个流程是否要展开写，标准不是"业务重要程度"（这个容易主观误判、遗漏冷门但关键的边缘流程），而是**入口点是否存在**——存在就要有上面第二步的三种结论之一，重要程度只决定详略，不决定是否处理。

## 落盘目录约定与 Phase 1 退出门禁

落盘目录固定为工作区根下的 `phase1/`（本 skill 只分析当前工作区，该目录天然就是目标仓库根），按集合拆分，写完一个集合立即写对应文件：

```
phase1/_checkpoint.json        —— 上次执行进行到哪个集合（续写定位）
phase1/00-domains.json         —— 业务域边界
phase1/10-entities.json        —— 领域模型
phase1/20-state-machines.json  —— 状态机迁移表
phase1/30-business-rules.json  —— 业务规则（条件原文 + 数值边界）
phase1/40-terms.json           —— 术语映射
phase1/50-entry-points.json    —— 入口点清单（含三态评审结论）
```

每个集合文件的顶层形状对齐 `schemas/phase1.schema.json` 里对应数组的契约（每条事实尽量带 `source_ref`；无法从代码确定业务动机的条目标 `needs_confirmation=true`，最终进 Phase 6 待确认清单）。

**离开 Phase 1 前必须跑 `node scripts/check-phase1.mjs`**：校验结构、核对七个文件是否齐全、汇总条目数。退出码 0 才能进 Phase 2；有缺失时它会点名"上次可能停在哪一步"，新会话据此精确续写，而不是从零重来。
