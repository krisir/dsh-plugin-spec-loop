# dsh-plugin-spec-loop

把一句话需求**先聊清楚**，再拆成多个独立的 [OpenSpec](https://github.com/Fission-AI/OpenSpec) change，然后让每个 change 自己一轮一轮地做完——轮数可配，进度以 `tasks.md` 的勾选数为准，生成的 change 有一个常驻列表。

它是会话视图里的一个整页标签（`规格`），和 `对话` / `轨迹` / 任务队列 并列。

## 它做什么

```
/spec 给后台加多租户隔离
   │
   ├─ 需求落进插件状态，并给会话发一条开场消息（只发一条）
   │
   ├─ 讨论：agent 先读仓库（openspec/config.yaml、已有的 specs、相关代码），
   │        一次问 2～4 个关键问题；你回答，它追问，直到它能说清怎么拆
   │
   ├─ agent 调用 spec_loop_propose 工具提交计划
   │        （工具只写进插件状态，磁盘上什么都不建）
   │
   ├─ 你在页面上勾选 / 取消 / 改标题和摘要
   │        ← 也可以 /spec apply
   │
   ├─ 确认之后，插件把这个会话叫回来，让它用 openspec-propose 技能去建
   │        （插件自己不写任何 change 文件，只按 id 核对结果）
   │        proposal.md / design.md / tasks.md / specs/*/spec.md
   │
   └─ 每个 change 进入 ralph 循环
          │
          每一轮：
            1. 跑 `openspec instructions apply --change <id> --json` 读权威任务清单
            2. 把「还没勾选的任务」渲染成 objective
            3. 让会话调用内置 `ralph` 工具跑一轮（maxRounds: 1）
            4. 重新读任务清单，看勾选数有没有变
          │
          └─ 结束时落到 done / exhausted / blocked / failed / cancelled
```

### `/spec` 命令

| 输入 | 作用 |
| --- | --- |
| `/spec <需求>` | 记下需求并开始讨论。**不创建任何 change** |
| `/spec` | 看当前讨论到哪一步了 |
| `/spec plan` | 催 agent 现在就把计划交上来 |
| `/spec apply` | 确认并创建（和页面上那个按钮是同一个操作） |
| `/spec cancel` | 放弃这次讨论；仓库里从来没写过东西 |
| `/spec list` | 列出这个项目已有的 change 和进度 |

控制词只在**整条输入恰好是这个词**时才算控制（跟 `/goal` 一个规则），所以 `/spec 帮我修一下 plan 的解析` 依然是一个需求。`确认` / `取消` / `计划` / `列表` / `状态` 是中文别名。

### 为什么创建必须由人来点

**创建权限只在用户手里，模型没有办法自己开始。** 这不是提示词里的请求，而是结构上的事实：

- agent 唯一的提交入口是 `spec_loop_propose` 工具，它只往插件状态里写一份 pending 计划；
- 走创建那一步的 `Proposals.apply()` 只从两个地方被调用：`/spec apply`（命令处理器）和页面的确认按钮——两者都是用户动作，而且共用同一段代码；
- 所以不管 agent 在讨论里说什么、调多少次工具，`openspec/changes/` 在你确认之前都是空的。

### 为什么 change 文件不由插件写

插件只收一份**计划**：`id`、`title`、`summary`——做什么、为什么它该独立成一个 change。proposal / specs / design / tasks 的正文它一概不收，也不写。

落盘交给 agent 自己：确认之后插件给那个会话发一条提示，点名 `openspec-propose` 技能和每一个已确认的 `id`，然后等这一轮跑完，再回到磁盘上**按 id 逐个核对**。这样做的理由是不要在插件里养一份 OpenSpec 模板的第二实现——模板属于 schema，schema 属于项目配置（`openspec/config.yaml`），而技能是从那里读的；插件抄一份，只会在 OpenSpec 某次升级改了模板之后悄悄跑偏。

核对是硬性的，三种结果都会说出来：

- 请求的 id 都在 → 逐个登记进列表，并把每个 change 的 `tasks.md` 勾选数读回来；
- 少了一部分 → 建成的照常登记，缺的那几个在结果里点名；
- 一个都没建成 → 报错，不写任何记录。如果 agent 用了自己发明的名字，报错里会把它一起点出来——那个目录确实在磁盘上，瞒着不说只会让你自己撞见它。

顺带的两条检查也落在这一轮：`tasks.md` 里没有 `- [ ]` 复选框会当场提醒（循环按勾选数统计进展，没有复选框的 change 跑不动），每个建成的 change 都会跑一次 `openspec validate`，结论记在 change 卡上。

这一轮是有等待的：页面上点确认之后按钮变成「正在创建…」，要到 agent 把 `openspec` 命令跑完才回来。它能跑多久用的是**设置里那个「单轮超时」**，和迭代的一轮共用同一个预算——建一个 change 和做完一轮是同一量级的工作，另外藏一个上限只会让你调高了看得见的那个之后仍然被卡住。

### 讨论的轮数

**不限轮数。** 需求聊到清楚为止，没有"最多几轮"这种隐藏上限——限定轮数只会让 agent 在第 N 轮硬凑一个计划出来。想结束讨论有两个出口：让它出计划（`/spec plan`），或者放弃（`/spec cancel`）。

### 一个 change 一个会话

迭代**不是**在后台默默跑一段脚本，而是在一个普通会话里开一轮对话——所以你能像看别的会话一样看它，也能中途打断它。

- **会话在第一次点「开始」时才建**，并且用 `cwd = 该 change 所在的工作区` 创建。这会话落在项目里，不是为了整洁，而是必须的：`openspec` 命令要靠 `cwd` 才能解析到同一个仓库，否则它会在插件的目录里找 `openspec/`。
- **后续每一轮复用同一个会话**。change 记录上存着 `sessionId`，是持久化的，所以宿主重启之后再点「继续」也还是同一个会话，上下文不丢。
- 只有这个会话真的没了（被删掉/归档掉），下一轮才会新建一个。
- **会话会被登记进该目录在侧边栏的工作区分组**（见下）。
- 每轮的提示词带着 `rpcId`（`spec-loop-<change>-<轮次>-<时间戳>`），所以在会话里能一眼看出哪一轮是哪一轮。

页面上 change 卡片的 `▶ xxxxxxxx` 就是跳到这个会话的入口。

#### 为什么还要显式登记工作区分组

这里有个容易踩的坑：**`sessionController.create({ cwd })` 只是给会话一个工作目录，并不会把它放进侧边栏的任何分组。** 工作区是用一份**显式的 `sessionIds` 账本**记着自己的会话的，"目录"和"分组"是两件事。

注册表**确实**会按 `cwd` 认领游离的会话——但只在**首次使用的那一次性历史引导**里做（`workspace.json` 里的 `initialized` 标记）。引导跑完之后新建的会话不会再被认领，于是它会掉进「未分组」，而它和你自己的会话其实是同一个目录。

所以插件建完会话后会自己登记一次：

```js
const workspace = await ctx.workspaceRegistry.resolveByPath(projectPath);
if (workspace) await workspace.attachSession(sessionId);
```

`attachSession` 是 `Workspace` 接口上的公开方法，而且它会**再校验一遍**：读取会话存储的 `cwd`、做 `realpath` 归一化，必须等于工作区自己的规范路径才写入。`resolveByPath` 也走 `realpath`，两边用同一个 `projectPath` 就必然相等。

两个刻意的选择：

- **复用的会话也重新登记一次**，不只新建的。这次修改之前建出来的、还留在「未分组」里的老会话，下一次点「继续」就会自动归位，不用你手工收拾。
- **目录没有工作区时不去替它建一个。** 注册工作区是对侧边栏可见的改动，点一下「开始迭代」不该顺手重排你的工作区。这种情况只记一行日志，会话保持未分组。

登记失败不影响迭代：注册表写不动、会话的 `cwd` 已经不存在、目录中途被删——都只是少一个分组，不该让一轮失败。这几条路径都有测试。

### 为什么一轮只传 `maxRounds: 1`

`ralph` 工具自己会连跑多轮，但那样外层就看不到中间状态了——页面上根本没法在轮与轮之间刷新进度、判断卡住、或者让你中途停止。所以插件把 `ralph` 当成"跑一轮"的原语：轮与轮之间的推进由插件根据 `tasks.md` 决定。这样「迭代 3/5」在页面上就是字面意思。

也正因为如此，**objective 不是一段散文式目标，而是「剩余复选框列表」本身**。这让 `tasks.md` 成为跨轮唯一的交接媒介：一轮没有办法靠汇报声称自己完成了，只有把 `- [ ]` 改成 `- [x]` 才算数。

### 关于 `ralph` 工具

`@deepseek-ai/dsh-tool-ralph` 在 DSH 里是**默认关闭的 opt-in 行**：`dsh-web-app` 的 `minimal` / `ptc` / `standard` 三个 agent preset 里都写着 `disabled: true`。

所以插件**在每一轮开始前先问一遍注册表**，再决定提示词怎么写：

```
ctx.tools.get('ralph', agent)   // 传 agent 作为查看范围
```

传 agent 是关键：工具是**按 agent preset 组合**的，全局注册的工具还可能被某个 scope 的 `restrict()` 掩掉——注册表文档里原话是「被限制掉的全集工具读起来就像不存在」。只看全局视图会得到一个对模型不成立的答案。因此：

- **拿得到 `ralph`** → 要求会话调用它，并把 objective 逐字传入（保留"调用失败就自己做"的兜底：工具可见不等于一定起得来）。
- **拿不到** → 提示词直接写"这一轮由你本人完成"，**完全不提** `ralph`。

第二种情况以前不是这样的：那时提示词一律要求调用 `ralph`，于是每一轮都先花一步发现它不存在，然后在回复里宣布一句「`ralph` 仍不可用」。功能其实一直在正常工作（会话会自己把这一轮做完），但这句话让一个正常的循环看起来像坏的。现在这一句不会再出现了。

两条路的判定标准完全一样（`tasks.md` 的勾选数），而且两种提示词**都会在结尾强调必须勾选** —— 这是循环唯一的进展信号，不勾就等于这一轮白跑。

**想真正启用它不是改一行开关那么简单**，下面是把尝试过的三条路都记下来，免得再翻一遍：

- **在 host 平面打开它——不行。** `plugin_manager set_plugin include:tool-ralph enabled:true` 会写到 profile patch，但实际结果是
  `pending (waiting for service: workflowEngine)`：`tool-ralph` 依赖 `workflowEngine` 服务，而那个服务由 preset 里 `delegation` 这个 `group: true` 行用 `isolate: { workflowEngine: true }` 提供，只在 preset 的隔离域里存在。host 平面没有它，行永远挂不起来。
- **在 bundle patch 里覆盖 `delegation`——不行。** 顶层 patch 条目命中不了 preset 内部的嵌套行：把 `- id: delegation` 写进本插件的 `cordis.patch.yml` 后，重组的 `cordis.yml` 里 `tool-ralph` 仍然是 `disabled: true`。
- **覆盖整个 `preset-standard`——可行，但代价要说清楚。** patch 的 `config` 是**整体替换、从不深合并**，所以必须把该 preset 的整份 146 行 `plugins` 列表原样重述一遍，只去掉 `tool-ralph` 的 `disabled: true`。这样做的后果是把你 profile 里的 `standard` preset **冻结在今天的形态**：以后 DSH 升级往 `standard` 里加了新工具，你不会得到，而且没有任何提示；同时它还会和 Creator 模式对同一个 preset 的自定义互相覆盖。

所以本插件**没有**替你做这个覆盖：双路径提示词已经覆盖了两种情况，代价只是当前 profile 下一轮里多一次无效的工具调用。真要启用，按上面的第三条来，改完用 `plugin_manager list_plugins` 确认 `include:preset-standard` 仍是 `fiberPhase: active`，并在**新会话**里验证（已存在的会话保留它创建时的 preset 版本）。

## 安装

走 Plugin Manager（推荐，宿主会负责依赖链接和 patch）：

```
plugin_manager install_bundle → /path/to/dsh-plugin-spec-loop
```

或者用包自带的脚本（不依赖 Plugin Manager，直接 symlink 进 profile 并追加一段带标记的 patch）：

```bash
node install.mjs install   --profile desktop   # 默认 $DSH_PROFILE 或 web
node install.mjs status    --profile desktop
node install.mjs uninstall --profile desktop
```

改完源码之后：

```bash
node build.mjs      # src/*.js → client.js
node --test test/   # 141 个测试
```

浏览器那一半的源码按文件名顺序拼接成一个 factory，所以**文件之间不能有相对 `require`**，只能用 `react`。`build.mjs` 会检查这一点。

想跑渲染测试的话先装 devDependencies（只用到 `react` / `react-dom` 的 `react-dom/server`）：

```bash
pnpm install --dev
```

没有安装时渲染测试会整体 skip，其余测试照常跑。

> 宿主那一半改了之后，ESM 模块缓存不会自动失效：要么让 profile 的 `hmr` 行监听本目录（`root: ["/path/to/dsh-plugin-spec-loop"]`），要么重启应用。Plugin Manager 的安装/卸载只保证配置生效，不保证重新从磁盘导入模块。

## 页面

**需求讨论** —— 页面**没有**输入框：入口只有 `/spec`。一轮拆分讨论是一次（或者好几次）真正的 agent turn，发生在会话输入框里，而不是在这个面板里；面板负责显示讨论到哪一步、待确认的计划长什么样，以及确认按钮。一个只能打字、却接不上下文的面板比没有更糟。

**待确认的计划** —— 每个条目一张小卡：一个复选框决定要不要建，一个可改的标题，一段可改的摘要，加上它的 `id`。卡片上再没有别的东西，因为这个阶段确实没有别的东西：文档还没生成。`id` 是只读的——它会变成目录名，插件确认之后就是按它核对的，在这里改掉只会让那个 change 对不上号。

**change 列表** —— 每个 change 一张卡：

| 元素 | 含义 |
| --- | --- |
| 状态胶囊 | 见下面的状态表 |
| `任务 3/7` | 来自 `openspec instructions apply` 的权威计数 |
| `迭代 2/5` | 已经跑过的轮数 / 当前轮数预算 |
| 进度条 | 任务完成百分比 |
| 开始 / 继续 / 重试 | 未跑过→开始；跑过但没做完→继续；已完成→重试 |
| 轮数输入框 | 单个 change 的预算，1–50 |
| 详情 | 逐轮记录（每轮的起止时间、勾选数变化、会话汇报摘要）+ `openspec validate` 输出 |
| `▶ xxxxxxxx` | 点一下跳到这个 change 的会话，看这一轮到底在干什么。`xxxxxxxx` 是会话 id 里去掉公共前缀 `session-` 之后能区分彼此的那一段 —— 直接截前 8 位的话，每个会话都显示成一样的 `session-`。当客户端没有 `uiWorkspace` 时退化成 `◈ xxxxxxxx`（复制 id） |

**设置** —— 默认轮数、并发数、单轮超时、无进展容忍轮数、是否自动跳过授权、`openspec` 命令路径。

### 状态

| 状态 | 含义 |
| --- | --- |
| `draft` 未开始 | 已创建，没跑过 |
| `queued` 排队中 | 在等并发槽位 |
| `running` 迭代中 | 有一轮在跑 |
| `done` 已完成 | CLI 报告 remaining === 0 |
| `exhausted` 轮数用尽 | 预算花完了还有活。**这不是错误**，点「继续」加轮数即可 |
| `blocked` 需要处理 | 连续 `stallLimit` 轮勾选数没动，或者 `tasks.md` 里根本没有 `- [ ]`。再跑只会烧 token |
| `failed` 失败 | CLI 或会话报错 |
| `cancelled` 已停止 | 手动停止 |

`exhausted` 和 `blocked` 的区别是这套状态词汇存在的理由：前者是"钱花完了，继续付就行"，后者是"再付也没用，得有人看一眼"。

## 状态存哪

`$DSH_HOME/spec-loop/state.json`（默认 `~/.dsh/spec-loop/state.json`），原子写入（临时文件 + rename）。文档解析失败时会改名成 `state.json.corrupt-<时间戳>` 保留现场，而不是直接覆盖。

讨论状态（需求、状态机、待确认的计划、被丢弃的条目）也在同一个文档里，按 session 存，最多保留 100 条、超出按最久未更新淘汰。待确认的计划写进去的就是它本来的样子——一个词都没多：没有文档正文可存，因为那时候还没有文档。

**仓库里的 `openspec/changes/` 才是真相**：列表只是一个投影。每次 `/state` 都会把磁盘上存在但列表里没有的 change 补进来，所以删掉状态文件也不会丢东西。

## 无人值守是怎么做到的

插件驱动的会话必须能在没人看着的时候跑完一轮，三层一起保证：

1. `sandbox/mode` → `danger-full-access`
2. `tools/pre-execute` → `{ kind: 'allow' }`
3. `approval/request` → `'allowed-once'`

三层都只对**插件自己管的会话**生效（`Privileges` 维护一个 managed 集合），并且都是 `{ prepend: true }` 注册的，所以只覆盖插件创建的那些会话，不影响你自己开的会话。设置里关掉「自动跳过授权」就会退回默认策略——代价是无人值守的轮次可能卡在授权请求上。

## HTTP 接口

浏览器那一半没有用生成的 Remote 协议（那需要 build 期产物），而是插件自己注册了一条路由：

```
/dsh-spec-loop/api
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state?sessionId=` | 整页快照（`discussion` 字段是当前会话的讨论） |
| POST | `/init` | `openspec init . --tools none --no-animation` |
| POST | `/draft/update` | 勾选 / 取消 / 改标题和摘要 |
| POST | `/draft/plan` | 催 agent 出计划（和 `/spec plan` 同一条消息） |
| POST | `/draft/apply` | **确认创建**（和 `/spec apply` 同一段代码） |
| POST | `/draft/discard` | 放弃这次讨论 |
| POST | `/changes/run` | 跑一个 change（可带 `rounds` 追加轮数） |
| POST | `/changes/runAll` | 跑全部未完成的 |
| POST | `/changes/stop` | 停止 |
| POST | `/changes/update` | 改轮数等字段 |
| POST | `/changes/delete` | 从列表移除（**不动磁盘上的 change 目录**） |
| POST | `/changes/refresh` | 从磁盘重新导入 |
| POST | `/settings` | 保存设置 |

两条不变量：

- **页面只发 `sessionId`，从不发路径。** 宿主用 `ctx.sessions.get(sessionId)?.header?.cwd` 反解出项目目录。客户端如果能自己指定路径，就等于能把这个循环指向机器上任意一棵树。
- **写操作只接受 loopback + `Content-Type: application/json`。** 表单提交或者局域网里的跨站请求都进不来。

## 测试

```
node --test test/
```

141 个测试：

- **纯函数** —— `parseSpecCommand` / `normalizeProposal` / `renderProposalRules` / `renderCreationPrompt` / `toKebab` / `renderObjective` / `normalizeSettings` / `parseTaskText` 等
- **持久化** —— 原子写、损坏文件改名保留、未知状态归一化、讨论状态按 session 存取与淘汰
- **客户端契约** —— 语言包 zh/en 键位对齐、页面用到的每个 key 都存在、bundle 只 `require('react')`、`apply` 注册出的 slot 条目（id / order / locale / label / inject）符合预期；会话跳转的三条：有 `uiWorkspace` 时能跳、没它时退化成复制、以及它**晚于**本插件装配时仍然会被认出来（能力是每次渲染现问的，不是在 `apply()` 里钉死的）
- **渲染** —— 用真实的 React 渲染真实的组件，断言每个状态、每种按钮文案、进度条的 `aria-valuenow`、日志顺序、讨论面板与待确认计划的每种形态，超长错误/摘要不会撑爆卡片，以及会话 chip 的两种形态（能跳时 `▶` + tooltip 说「打开会话」，不能跳时 `◈` + tooltip 说「复制会话 id」）和「还没跑过就没有 chip」
- **注册契约** —— 把 `commands.register()` / `tools.register()` 的准入规则照抄进测试（schema 子集、命令名字法、handler 返回值形状），断言插件真的交得出合格的定义。服务本身在 app 的模块图里，插件装完是 import 不到的；这份抄写不是权威，但能把"注册了一个会被注册表拒绝的工具"从用户会话里的运行时报错变成一条失败的测试
- **装配** —— 用一个 stub context 真跑一遍 `apply()`：命令定义、工具定义、路由是否按各自的契约注册；`commands`/`tools` 服务缺失时仍然能加载；命令名撞车时只丢命令不丢插件；非 loopback 的写请求被拒
- **创建委派** —— `apply()` 单测，把 session seam 换成一个假 agent：它会建，也会**故意不建**。核对的三条路各测一次（全都建出来 → 逐个登记；少建一个 → 只登记建成的、缺的点名；一个都没建 → 抛错且不写记录），agent 用了自己发明的名字时那种「磁盘上多了个你没批过的目录」会被指出来；技能**确证缺失**时在花掉一轮之前就报错（跳过 `runTurn`）；`tasks.md` 没有复选框时给出提醒；没有会话可委派、以及一个都没勾选时都拒绝，且都不发提示
- **端到端** —— 在一个临时项目上放一个假的 `openspec` 可执行文件，跑完整的 `/spec → 讨论 → 提交计划 → 确认 → 由 agent 落盘` 全流程，以及 `RalphRunner` 按轮推进直到 `done`、预算耗尽变 `exhausted`、连续无进展变 `blocked`；提示词两种形态都走真实循环跑一遍：注册表里有 `ralph` 时会要求调用，没有时**一次都不提**，而那一轮照样把活干完；注册表问不动（抛错）时也只是退回「不问」这条路，不会把一轮弄挂；新建的会话会被登记进工作区分组，复用的会话会**再登记一次**（老会话因此自动归位），而目录没有工作区、登记抛错、`resolveByPath` 抛错这三种情况下那一轮照样跑完
- **真 CLI 契约** —— 拿真的 `openspec`（1.9.0）在一个临时项目上跑 `init` / `new change` / `list` / `instructions apply` / `validate`，断言插件依赖的那几个输出字段和退出行为。装了 CLI 才跑，没装就整层跳过。其余测试要么替掉 CLI、要么放一个假的，这对测试**插件**是对的，但 CLI 是另一个程序：它改了而插件没跟上时，一个假的都不会红

端到端那层用一个假的 session seam 替掉宿主，因为它要精确控制"这一轮对 `tasks.md` 做了什么"——而这是循环唯一被允许依赖的东西。假的 `openspec` 是**可执行脚本**而不是被替换的类：这段流程有意思的地方恰恰在于插件真的去 shell 了，换掉 `Openspec` 类就是在测试那个替身。

创建那段流程的替身比别的都关键：那个假 agent 会**按提示词里点到的 id** 把目录建出来，正是技能该做的事。所以断言落在插件的**核对**上——它有没有问、问的时候有没有点名每个 id、回来之后有没有按 id 对账——而不是落在插件写出了什么文件。插件要是哪天又自己写起文件来，这些测试里的 `writes` 会是空的，而对账那几条立刻就会红。

最重要的一条断言是否定的：需求记下、计划提交之后，`openspec/changes/` 仍然是空的。

## 目录

```
index.js                宿主入口（re-export host/plugin.js）
cordis.patch.yml        bundle patch：一行 insert
client.js               构建产物（src/*.js 拼接）
build.mjs               拼接脚本
install.mjs             symlink + patch 的安装脚本
host/
  plugin.js             装配：服务、effect、路由、命令/工具注册、启动时对账
  openspec.js           openspec CLI 接缝（含 GUI 场景下的可执行文件解析）
  state.js              持久化状态（原子写、损坏恢复、字段归一化、讨论草稿）
  discourse.js          /spec 的语法与讨论用的提示词
  command.js            /spec 命令处理器（讨论、催计划、确认、放弃）
  tool.js               spec_loop_propose 工具定义与待确认计划的视图
  proposal.js           计划的校验、委派创建、按 id 核对（apply 是唯一的入口）
  ralph.js              ralph 循环（objective 渲染、进度门控、卡住判定）
  session.js            会话接缝（create / prompt / 等一轮结束 / 超时 / 取消）
  privilege.js          无人值守三层授权
  http.js               路由
src/
  00-util.js            常量与格式化
  05-locale.js          zh / en 字典
  10-api.js             fetch 封装（含 /draft/* 动词）
  20-store.js           轮询 + mutation 状态
  30-styles.js          样式表（只用 --dsw-* 主题 token）
  40-page.js            页面组件
  90-plugin.js          slot 注册
test/
  helpers.js            stub context、假 openspec 可执行文件、注册契约的镜像
  contract.test.js      交给 commands / tools 两个注册表的定义
  discussion.test.js    /spec → 讨论 → 提交 → 确认 → 落盘 的端到端（假 CLI）
  cli.test.js           真 openspec CLI 的契约（没装就跳过）
  loop.test.js          ralph 循环的端到端（真 CLI）
  ...
```

## 已知边界

- **一个 change 只能由一次讨论创建**：计划落盘之后讨论就结束了，想加一个 change 就再开一次 `/spec`。已有的 change 不会因为新计划而修改。
- **审阅界面只让你改标题和摘要**：proposal / specs / design / tasks 的正文来自 agent。想改正文就在讨论里说，或者落盘之后直接改文件——迭代循环读的是文件。
- **讨论状态按 session 存**：换一个会话标签就看不到上一个会话那次的讨论（已经创建的 change 不受影响，它们在项目列表里）。
- **一轮 = 一次 `ralph` 调用**：如果一轮里模型自己又跑了很长的循环，插件只能在它返回后才能看到进度。
- **卡住判定看的是勾选数**：一个 change 如果任务描述本身含糊到"做完了但不知道算不算完成"，会被判成 `blocked`——这是有意的，含糊的任务正需要人来看一眼。
- **并发是按 change 记的**：`concurrency: 3` 表示同时最多 3 个 change 在跑，不是 3 个会话。

## License

[MIT](./LICENSE)
