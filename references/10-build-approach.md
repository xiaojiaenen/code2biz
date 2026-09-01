# 交付形态：固定设计系统 + React 编译 vs 手写原生 JS

两件事分开说：**用什么视觉设计**（不允许自由发挥）、**用什么方式实现**（React 编译还是手写，按环境和复杂度判断）。

## 视觉设计：锁定 archify 的"Evidence Console"，不即兴发挥（SKILL R9）

之前的版本让模型在生成时读 `frontend-design` skill 自己设计视觉方案——用户明确反馈不要这样：不需要用户单独装别的 skill，也不要让每次生成的风格随机漂移。改成：**整份单文件 HTML（不仅是图表，而是业务地图/领域模型/规则手册等全部章节）统一使用 `assets/archify/DESIGN.md` 定义的设计系统**，固定为以下两套主题之一，不允许第三种：

- **默认：Dark（Evidence Console）**——midnight canvas `#020617`、mask `#0F172A`、ink `#FFFFFF`，语义色：frontend 青 `#22D3EE`、backend 绿 `#34D399`、database 紫 `#A78BFA`、cloud 琥珀 `#FBBF24`、security 玫瑰 `#FB7185`、messagebus 橙 `#FB923C`；字体统一 JetBrains Mono（等宽字体，系统兜底：`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`），圆角/间距/字号阶梯完全按 `DESIGN.md` 的 `rounded`/`spacing`/`typography` token 取值，不另起一套数值
- **可选：Light**——archify 本身支持深浅色切换且保证"Theme Parity"（同一套语义色 / 信息层级，只是明暗反转），如果用户要浅色版，用 archify 已实现的浅色 token，**不自己重新配浅色方案**

**语义色跨章节保持一致**：backend 绿在架构图里代表"后端服务"，在领域模型章节的实体卡片、状态机的"正常状态"节点上也应该沿用同一套语义，不允许不同章节各用一套配色逻辑。术语表、待确认清单这些非图表章节用 `DESIGN.md` 的中性色阶（`ink`/`muted`/`dim`/`border`）做层级，不引入这套色板之外的颜色。

**archify 图表的视觉与宿主一致**：经 `scripts/archify-inline.mjs` 转出的原生内联片段，CSS 变量继承宿主 token（--canvas / --mask / --ink / --frontend 等），工具栏、focus 高亮、viewport 都用宿主 design system，**不会出现"图是青色系、宿主是暖色系"的割裂**。archify 图表内部 SVG 仍走自己的 token，但通过 `archify-inline` 的 chromeCss 桥接到宿主的色阶上。

**不是让模型每次都重新"参考"一下这套规范再自由发挥**——是直接把 `DESIGN.md` 的 token 值当常量抄进最终 HTML 的 `:root` CSS 变量里，写死。唯一允许的变化是 Dark/Light 两个开关，不允许第三种风格，也不接受"这次我想试试别的调性"。

## 实现方式：React 编译单文件 vs 手写原生 JS 内联

这件事和上面的视觉规范无关——不管选哪种实现方式，视觉规范都是同一套固定 token。

### 方案 A：手写原生 JS / CSS 直接内联（默认）

零构建步骤，写完即产物，天然满足离线 / 内网环境，配合上面固定死的 CSS 变量，视觉一致性反而更容易保证（没有构建工具链引入的不确定性）。**符合 R1（无 iframe / 无外部挂载）的最简单路径**。

### 方案 B：React 工程 + `vite-plugin-singlefile` 编译成单文件

组件数量多、状态联动复杂（域切换器联动架构图联动术语过滤）时更省心。视觉 token 同样是 `assets/archify/DESIGN.md` 那套固定值，做成 Tailwind config 或 CSS 变量导入，**不是让 React 项目"重新设计一遍"**。

构建产物里不能留任何 `<script type="module" src="./xxx.js">` 这种指向外部文件的写法（违反 R1 + 在 `file://` 下被拦），`vite-plugin-singlefile` 的职责就是把这些全部内联压平，构建完之后一定要实际打开产物文件确认一次（不是只看构建日志没报错就算完事）。

### 决策步骤

1. 探测环境能不能跑 npm（`npm --version`，或试装一个小依赖），内网 / 离线环境大概率装不上，几秒内就能判断
2. 探测失败或明确离线 → 方案 A
3. 探测成功 + 组件多 / 状态联动复杂 → 方案 B
4. 探测成功但复杂度低 → 默认方案 A，除非用户明确要求
5. 不确定就问用户，不要沉默二选一

## 两条路线共享的硬性约束（详见 `references/07-single-html-packaging.md`）

不管选哪条路，产物必须能**双击直接在浏览器打开、无 iframe、无 CORS 报错**——具体检查清单在 `07-single-html-packaging.md`，这里只强调：

- **方案 B 构建产物里不能留任何 `<script type="module" src="./xxx.js">` 或 `<iframe>` 任何形式**——前者 `file://` 下被拦，后者违反 R1
- **archify 图表通过 `scripts/archify-inline.mjs` 转原生内联**（不外链、不 iframe）——这是 R1 在两套方案里的统一实现路径
- 生成完之后用 headless Chrome 截图肉眼确认一次（`chrome --headless --screenshot=...`），不要只看构建日志没报错
