# code2biz

把当前工作区的业务代码，净化为一份**双击即可打开的单文件 HTML 业务文档**的 Agent Skill。

它不写常用 API 说明书，而是从源码里抽取"业务本身发生了什么"：谁、在什么状态、走什么流程、被按什么规则卡住、同一个东西在不同模块叫什么、哪些入口第一眼可以进去——最终以左导航 + 语义化章节 + 交互组件（可点状态机、规则计算器、术语悬停）的形式，打包成一个体积小、可离线分享的 HTML。

> 只分析**当前工作区**的源码，不做跨仓库比对。装进哪个项目，就分析哪个项目。

## 它能交付什么

一份单文件 `*.html`，内含：

- **业务地图**：模块/边界总览（业务全景）
- **架构图 + 领域模型**：实体、字段、关系、为什么存在、具体例子
- **核心流程 / 状态机**：含全部异常分支与迁移表
- **规则手册**：业务规则的条件原文 + 数值边界 + 代码引用
- **词汇表**：术语映射（含跨模块"同物异名"）
- **待确认清单**：代码里无法确定的、需要人确认的地方，独立成章

生成过程是**确定性提取**起手：只写代码里找得到的，找不到的进"待确认"，不编造。

## 前置要求

| 项 | 要求 |
|---|---|
| 运行时 | Node.js ≥ 18（自带 npm） |
| 目标项目 | 源码位于当前工作区（skill 只分析这里） |
| Git | 安装到可选，手动安装方式需要 |

检查：`node --version`、`npm --version`。

## 安装

### 方式一：npx（skills.sh，跨 Agent、跨平台）

```bash
# cd 到你要分析的项目根目录
npx skills@latest add xiaojiaenen/code2biz
```

安装器会让你选择装到哪个 Coding Agent（Claude Code / Codex / Cursor 等）。选完后重启/刷新会话生效。

### 方式二：手动安装（网络受限 / 自己维护）

**项目级（推荐）** —— 装进你要分析的那个项目：

```bash
cd your-target-project
mkdir -p .claude/skills
git clone https://github.com/xiaojiaenen/code2biz.git .claude/skills/code2biz
```

**用户级（对所有项目生效）**：

```bash
git clone https://github.com/xiaojiaenen/code2biz.git ~/.claude/skills/code2biz
```

另一种项目级写法：直接复制本目录为 `<项目根>/.claude/skills/code2biz`。

> 说明：因为本 skill 只分析"当前工作区"，推荐装到目标项目里（项目级），并配合把目标仓库的 `package.json`/依赖等交给 Agent——这样"找错仓库"的问题天然不存在。

### 验证安装

```bash
/skills
```

应看到 `code2biz` 已就位。

## 使用

1. `cd` 到目标项目，进入 Agent 会话（skill 已装好）。
2. 给一句需求，例如：**"分析这个仓库的业务，生成业务文档"**。
3. agent 自动走六阶段流水线：
   确定性提取 → 反空洞自查 → 人工确认层 → 设计系统 → 单文件打包 → 增量更新。

### 关于"丢上下文"的保障

Phase 1 的全部提取成果会按集合落盘到项目根的 `phase1/`，任何时刻会话被压缩或中断，最多丢正在写的一小块；新会话用下面命令即可把已完成的 Phase 1 全貌读回、精确续写，不重做。

```bash
node scripts/check-phase1.mjs        # 读回 Phase 1 中间数据 + 校验完整性
node scripts/check-final-html.mjs <final.html>   # 交付前离线/CORS 自检
```

## 目录结构

```
code2biz/
├── SKILL.md                  # 主流程指令（六阶段）+ 触发条件
├── references/
│   ├── 01-extraction.md      # Phase 1：确定性提取 + 落盘恢复
│   ├── 02-synthesis-checklist.md
│   ├── 03-interactive-artifacts.md
│   ├── 04-incremental-update.md
│   ├── 05-human-verification.md
│   ├── 06-output-structure-and-map.md
│   ├── 07-single-html-packaging.md
│   ├── 07a-diagram-generation.md
│   ├── 08-domain-segmentation.md
│   ├── 09-glossary-tooltips.md
│   └── 10-build-approach.md
├── schemas/phase1.schema.json       # Phase 1 中间数据的权威结构
├── scripts/                         # 校验与转换脚本（见上文命令）
└── assets/archify/                  # 内置"图着色"渲染引擎（archify）
```

## 影响当前工作区的文件

运行过程中会写入：

- `phase1/`：Phase 1 中间数据（唯一真源，可恢复）
- `output/`：最终 HTML 交付物