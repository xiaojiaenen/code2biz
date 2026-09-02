# 待展开业务清单（recorded / flagged 补写骨架）

> 由 `scripts/expand-recorded.mjs` 从 `entry-points.json` 生成。
> 这些条目在文档里原本是被一句话带过的。四要素填完之前，这份文档没有覆盖到它们。

## 现状

- 入口点总数 **38**，已定稿 **38**
- detailed 8 / recorded 29 / flagged 1 / 未处理 0
- **recorded 占比 76.3%**（上限 50%，**已超标**）

> ⚠️ recorded 占比超过 50%，`check-content-depth.mjs`（R9-4）会直接判不合格。
> 这通常不是因为业务真的都这么简单，而是**分类粒度太粗**：把几个本该 `detailed` 的流程合并成了 `recorded`，
> 或者根本没看进去就标了。两条出路：把确实复杂的改成 `detailed` 走完整五维度；或者按下面的分组**整组展开**。

## 补写要求（每条 recorded 都要达到）

- **业务目的**：谁在什么场景下用它、用来达成什么
- **输入 / 输出**：关键入参与返回内容
- **失败边界**：最容易踩的坑、失败时是什么表现、有没有静默失败
- 每条 **≥60 可见字符**，落进最终 HTML 时带 `data-entry-id` 与 `data-entry-status="recorded"`
- 模板与示例见 `references/12-content-depth-gate.md` §3.2，骨架见 `examples/content-depth-pass-sample.html`

## 分组建议（CRUD 密集的可以整组展开，不用逐条硬写）

- **api**（29 条）：/hosts、/ssh-setup、/hosts-sync、/components、/check 等
- **backend**（1 条）：/api/health

> 整组展开的写法："这一组接口共同完成 X 的维护，其中 A 是软删、B 带分页、C 失败时返回空列表而非报错…"
> ——这仍然是逐条交代，不是"其余同理"。

## 逐条骨架

| # | ID | 方法 | 路径 / 说明 | 源码位置 | 业务目的（待填） | 输入（待填） | 输出（待填） | 失败边界（待填） |
|---|---|---|---|---|---|---|---|---|
| 1 | http:backend/api/cluster.py:20 | HTTP | /hosts | `/Users/xiaojia/code/Russh/backend/api/cluster.py:20` |  |  |  |  |
| 2 | http:backend/api/cluster.py:27 | HTTP | /ssh-setup | `/Users/xiaojia/code/Russh/backend/api/cluster.py:27` |  |  |  |  |
| 3 | http:backend/api/cluster.py:42 | HTTP | /hosts-sync | `/Users/xiaojia/code/Russh/backend/api/cluster.py:42` |  |  |  |  |
| 4 | http:backend/api/cluster.py:54 | HTTP | /components | `/Users/xiaojia/code/Russh/backend/api/cluster.py:54` |  |  |  |  |
| 5 | http:backend/api/cluster.py:93 | HTTP | /check | `/Users/xiaojia/code/Russh/backend/api/cluster.py:93` |  |  |  |  |
| 6 | http:backend/api/cluster.py:110 | HTTP | /start | `/Users/xiaojia/code/Russh/backend/api/cluster.py:110` |  |  |  |  |
| 7 | http:backend/api/cluster.py:126 | HTTP | /stop | `/Users/xiaojia/code/Russh/backend/api/cluster.py:126` |  |  |  |  |
| 8 | http:backend/api/cluster.py:141 | HTTP | /restart | `/Users/xiaojia/code/Russh/backend/api/cluster.py:141` |  |  |  |  |
| 9 | http:backend/api/components.py:64 | HTTP | /{name}/versions | `/Users/xiaojia/code/Russh/backend/api/components.py:64` |  |  |  |  |
| 10 | http:backend/api/components.py:79 | HTTP | /{name} | `/Users/xiaojia/code/Russh/backend/api/components.py:79` |  |  |  |  |
| 11 | http:backend/api/monitor.py:37 | HTTP | /overview | `/Users/xiaojia/code/Russh/backend/api/monitor.py:37` |  |  |  |  |
| 12 | http:backend/api/monitor.py:57 | HTTP | /nodes/{node_id} | `/Users/xiaojia/code/Russh/backend/api/monitor.py:57` |  |  |  |  |
| 13 | http:backend/api/monitor.py:63 | HTTP | /alerts | `/Users/xiaojia/code/Russh/backend/api/monitor.py:63` |  |  |  |  |
| 14 | http:backend/api/monitor.py:69 | HTTP | /alerts/ack | `/Users/xiaojia/code/Russh/backend/api/monitor.py:69` |  |  |  |  |
| 15 | http:backend/api/nodes.py:73 | HTTP | /{node_id} | `/Users/xiaojia/code/Russh/backend/api/nodes.py:73` |  |  |  |  |
| 16 | http:backend/api/nodes.py:82 | HTTP | /{node_id} | `/Users/xiaojia/code/Russh/backend/api/nodes.py:82` |  |  |  |  |
| 17 | http:backend/api/nodes.py:106 | HTTP | /{node_id} | `/Users/xiaojia/code/Russh/backend/api/nodes.py:106` |  |  |  |  |
| 18 | http:backend/api/nodes.py:129 | HTTP | /{node_id}/test | `/Users/xiaojia/code/Russh/backend/api/nodes.py:129` |  |  |  |  |
| 19 | http:backend/api/nodes.py:143 | HTTP | /{node_id}/components | `/Users/xiaojia/code/Russh/backend/api/nodes.py:143` |  |  |  |  |
| 20 | http:backend/api/nodes.py:163 | HTTP | /{node_id}/components/{component_name}/check | `/Users/xiaojia/code/Russh/backend/api/nodes.py:163` |  |  |  |  |
| 21 | http:backend/api/nodes.py:184 | HTTP | /{node_id}/yum-repo | `/Users/xiaojia/code/Russh/backend/api/nodes.py:184` |  |  |  |  |
| 22 | http:backend/api/service.py:34 | HTTP | /start | `/Users/xiaojia/code/Russh/backend/api/service.py:34` |  |  |  |  |
| 23 | http:backend/api/service.py:46 | HTTP | /stop | `/Users/xiaojia/code/Russh/backend/api/service.py:46` |  |  |  |  |
| 24 | http:backend/api/service.py:53 | HTTP | /restart | `/Users/xiaojia/code/Russh/backend/api/service.py:53` |  |  |  |  |
| 25 | http:backend/api/service.py:60 | HTTP | /status | `/Users/xiaojia/code/Russh/backend/api/service.py:60` |  |  |  |  |
| 26 | http:backend/api/templates.py:40 | HTTP | /{template_id} | `/Users/xiaojia/code/Russh/backend/api/templates.py:40` |  |  |  |  |
| 27 | http:backend/api/templates.py:73 | HTTP | /apply | `/Users/xiaojia/code/Russh/backend/api/templates.py:73` |  |  |  |  |
| 28 | http:backend/api/templates.py:120 | HTTP | /validate | `/Users/xiaojia/code/Russh/backend/api/templates.py:120` |  |  |  |  |
| 29 | http:backend/api/yum.py:40 | HTTP | /switch | `/Users/xiaojia/code/Russh/backend/api/yum.py:40` |  |  |  |  |
| 30 | http:backend/main.py:124 | HTTP | /api/health | `/Users/xiaojia/code/Russh/backend/main.py:124` |  |  |  |  |

> 填完四要素后，把这张表落进最终 HTML 的第 07 章，`check-content-depth.mjs` 会逐条核对
> `data-entry-id` 是否齐全、业务说明是否达标。占位符（"未单列"、"其余见某某说明"、"待补"）会被 R10 拦下。
