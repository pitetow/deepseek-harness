# DeepSeek Harness 插件开发全流程指南

> 本文基于 [开发文档「第一个插件」](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 及其后续教程整理，结合当前仓库（deepseek-harness）的实际结构，梳理一个插件从**编写 → 本地联调 → 打包 → 安装部署 → 运行验证**的完整流程与每一步要做的工作。
>
> 仓库内权威出处（相对本文件的路径）：
> - 基础教程：[`../docs/user/develop/basic/index.zh.md`](../docs/user/develop/basic/index.zh.md)
> - 工具开发：[`../docs/user/develop/basic/tool.zh.md`](../docs/user/develop/basic/tool.zh.md)
> - 插件配置：[`../docs/user/develop/basic/config.zh.md`](../docs/user/develop/basic/config.zh.md)
> - 打包与安装：[`../docs/user/develop/basic/publish.zh.md`](../docs/user/develop/basic/publish.zh.md)
> - 生命周期：[`../docs/user/develop/framework/index.zh.md`](../docs/user/develop/framework/index.zh.md)
> - 服务与依赖：[`../docs/user/develop/framework/service.zh.md`](../docs/user/develop/framework/service.zh.md)
> - 事件系统：[`../docs/user/develop/framework/events.zh.md`](../docs/user/develop/framework/events.zh.md)
> - 能力分层：[`../docs/user/develop/practice/index.zh.md`](../docs/user/develop/practice/index.zh.md)
> - 新增仓库包：[`../docs/cookbook/adding-a-package.md`](../docs/cookbook/adding-a-package.md)
> - CLI 行为参考：[`../apps/cli/reference/README.zh.md`](../apps/cli/reference/README.zh.md)

---

## 1. 概念总览

### 1.1 插件是什么

在 DeepSeek Harness 中，**一切都是插件**。插件是一个导出 `apply` 函数的 TypeScript 模块（也支持对象形式与类形式），框架在加载时调用 `apply(ctx)`，传入上下文对象 `ctx`，你通过 `ctx` 注册能力。

一个最小插件：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // 在这里注册能力。
}
```

核心导出项：

| 导出 | 作用 |
|------|------|
| `name` | 插件唯一名称 |
| `inject` | 声明依赖的服务，框架保证其就绪后才执行 `apply` |
| `Config` | 配置的 TypeScript 类型 + 同名 Schemastery schema |
| `apply(ctx, config)` | 插件入口，做注册 |

### 1.2 插件的三种形态

1. **函数形式**（最常见，绝大多数场景够用）：命名导出 `name` / `inject` / `Config` / `apply`，**没有 default 导出**。
2. **对象形式**：`export default { name, inject, apply(ctx) {...} }`。
3. **类形式**：`extends Service`，用于**对外提供服务**的插件，见 [服务与依赖](../docs/user/develop/framework/service.zh.md)。

注意（仓库约定，来自 [`../packages/AGENTS.md`](../packages/AGENTS.md)）：服务类包用 default 导出服务类；函数插件命名导出 `name` / `inject` / `Config` / `apply` 且无 default 导出。混用会导致 Loader 丢弃函数插件的命名空间。

### 1.3 生命周期状态机

每个被加载的插件拥有一个 **Fiber** 作用域，状态迁移为：

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

| 状态 | 含义 |
|------|------|
| PENDING | 已声明，但依赖的服务未就绪 |
| LOADING | 依赖就绪，正在执行 `apply` |
| ACTIVE | 插件运行中 |
| FAILED | `apply` 抛异常 |
| UNLOADING | 正在卸载、释放资源 |
| DISPOSED | 已完全卸载 |

依赖的服务消失时（如提供方被替换），插件自动卸载；服务恢复后自动重新加载。详情见 [生命周期](../docs/user/develop/framework/index.zh.md)。

### 1.4 端到端流程总览

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. 环境准备   pnpm install / pnpm run build / pnpm dsh            │
│ 2. 本地开发   scratch-plugin + cordis.yml patch → 启动 Web UI     │
│ 3. 编写代码   apply / inject / Config / 工具 / 服务 / 事件         │
│ 4. 决定形态   ├─ 路径 A：外部组合包（bundle，交付给用户）           │
│              └─ 路径 B：仓库内 workspace 包（进 monorepo）         │
│ 5. 打包分发   bundle → npm / tarball / git；或注册进仓库并 build    │
│ 6. 安装部署   dsh plugin --profile <name> add <package>            │
│ 7. 运行验证   dsh --profile <name> / dsh web / --dump-config       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 环境准备

### 2.1 依赖要求

- Node.js：`^22.19 || >=24`
- 包管理器：`pnpm`（workspaces）
- 可选：`DEEPSEEK_API_KEY`（真实 API 测试与 demo 需要；无密钥时相关用例自动跳过）

### 2.2 从源码运行

在本仓库根目录：

```sh
pnpm install
pnpm run build
```

之后用源码版 CLI（通过 `node --import tsx/esm` 启动 `apps/cli/src/bin.ts`）：

```sh
pnpm dsh <args...>
```

> 安装形式（`npm i -g` 后）直接用 `dsh <args...>`；源码形式必须写 `pnpm dsh`。源码形式需要先 `pnpm run build` 生成 Typert Host 等产物，缺失时会报模块解析错误。

---

## 3. 本地开发循环（不打包，先跑通）

这是最快的迭代方式：把插件源码作为 **patch overlay** 注入正在运行的 Web UI，改动即热替换。

### 3.1 创建临时项目

在仓库根目录：

```sh
mkdir -p scratch-plugin/src
```

### 3.2 写插件文件

创建 `scratch-plugin/src/my-plugin.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  // apply 执行时，inject 声明的依赖已就绪。
  console.log('[hello-plugin] plugin loaded!')
}
```

### 3.3 写 patch overlay（cordis.yml）

创建 `scratch-plugin/cordis.yml`，把本地插件行插入配置树（`name` 必须是**绝对路径**）：

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

### 3.4 启动并验证

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

打开 `http://127.0.0.1:3080`。启动期间终端应打印 `[hello-plugin] plugin loaded!`。

### 3.5 自动清理与 HMR

- 通过 `ctx` 注册的任何东西（事件监听、工具、定时器）在插件卸载时**自动清理**，无需手动 `removeListener` / `clearInterval`。
- 需要手动清理的资源（网络连接等）用 `ctx.effect()` 返回 disposer。
- 修改插件源码会触发 HMR：卸载旧插件 → 重载新代码 → 重新执行 `apply`，旧实例的注册不会残留。

---

## 4. 编写插件核心代码

### 4.1 声明依赖（inject）

```ts
export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  // ctx.tools 在此处已就绪。
  ctx.tools.register(/* ... */)
}
```

- **必需依赖**：写进 `inject`；服务未就绪时插件处于 PENDING 等待。
- **可选依赖**：不写 `inject`，在使用处用 `ctx.get('metrics')` 查询（返回可能为 undefined）。

### 4.2 配置（Config）

导出同名的 `Config` 接口与 Schemastery schema，默认值写在 schema 中：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)
}
```

在 patch 行中传入：

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greeting: 'Hi there'
        maxRetries: 5
```

设计原则（仓库硬约定）：
- **无硬编码可调参数**：凡不同部署可能需要不同值的参数，都必须定义为 `Config` 字段（检验标准：能否只改 `cordis.yml` 而不改代码）。
- **配置错误要响亮**：schema 表达自完备约束，无效配置在加载时即失败。
- 修改 `cordis.yml` 中的 `config` 会触发插件热替换。

### 4.3 开发一个工具

用 `@deepseek-ai/dsh-tools` 的 `defineTool`，`inject = ['tools']`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

- `parameters` 由 `defineTool` 推导并校验 `args`。
- `execute` 返回 `output.schema` 声明的规范值；`output.render` 把该值转换为面向模型的内容。
- 嵌套 schema、规范值、后台工作、策略钩子、Code Mode、UI 卡片见 [工具编写参考](../docs/cookbook/adding-a-tool.md)。
- 工具的 UI 渲染意图（`generic` / `terminal` / `diff`、`locations`）在设计阶段就要定，渲染方法是 `args` 的纯函数。

### 4.4 提供服务（Service 基类）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export default class MetricsService extends Service {
  static inject = ['llm']  // 服务也可以依赖其他服务。

  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }

  record(event: string, value: number) {
    // ...
  }
}
```

消费方通过 `inject = ['metrics']` 后访问 `ctx.metrics`。用声明合并给 `ctx.metrics` 正确类型。

内置服务（`tools`、`llm`、`agents` 等）的服务名、公开方法与源码位置由仓库自动生成到各[子系统页面](../docs/subsystems/README.md)，开发时应以生成区块与 TypeScript 接口为准，不要另维护静态清单。

### 4.5 事件系统

事件是插件间松耦合通信的核心，命名遵循 `namespace/action`：

| 模式 | 语义 |
|------|------|
| `ctx.emit` | 广播，同步执行，返回值被忽略 |
| `ctx.bail` | 短路，第一个非空返回值成为最终结果 |
| `ctx.serial` | 顺序执行并等待异步，首个非空返回值终止后续 |
| `ctx.waterfall` | 流水线，监听器可包装下游返回值；**必须调用 `next()`**，否则短路整个流水线 |

类型安全事件用声明合并：

```ts
import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
  }
}
```

注意：`turn/*`、`step/*`、`tool/call`、`tool/result` 等是**持久化会话事件类型**，不是同名 Cordis 事件；要观察它们需监听 `session/event` 并检查 `event.type`。

### 4.6 资源管理与嵌套上下文

- `ctx.on(event, handler)`、`ctx.tools.register(tool)`、`ctx.llm.registerAdapter(...)`、`ctx.effect(() => cleanup)` 都会被自动追踪并清理。
- 插件卸载时 disposer 按注册顺序**逆序**调用；多个异步 disposer 并发执行，不保证顺序。有顺序依赖的清理必须放进同一个 `ctx.effect()` 返回的 disposer 内串行等待。
- `ctx.plugin(childPlugin)` 创建子 Fiber，继承父上下文但有独立生命周期，随父卸载。
- 提前终止：`const fiber = ctx.plugin(myPlugin); await fiber.dispose()`。

---

## 5. 决定交付形态：两条路径

开发完成后，根据插件的去向二选一（或先 A 后 B）：

| | 路径 A：外部组合包（bundle） | 路径 B：仓库内 workspace 包 |
|---|---|---|
| 定位 | 独立 npm 包，交付给**用户**通过 `dsh plugin add` 安装 | `packages/<group>/<pkg>`，进本 monorepo，随官方发布 |
| manifest | `package.json` 声明 `dsh.bundle` | 遵循 workspace 约束（`private: true` 等） |
| 关键动作 | 写 `cordis.patch.yml` + 发布 | 注册进根 tsconfig/knip + `pnpm run build` + `hygiene` |
| 是否换插件代码 | 插件入口写法完全一致 | 插件入口写法完全一致 |

两条路径的**插件代码本身写法完全相同**，差异只在"如何被打包、如何被解析、如何进入配置层"。

---

## 6. 路径 A：打包为可安装组合包（bundle）

### 6.1 两个概念、两种 manifest

安装机制建立在两个概念之上，二者都由一份 `package.json` 描述，但在 `dsh` 键下携带不同 manifest：

- **组合包（bundle）**：附带一个配置层的 npm 包。`dsh.bundle` 声明它贡献的 patch 文件（"这个包贡献什么？"）。
- **profile**：位于 `$DSH_HOME/profiles/<name>`、描述一份可启动组合的目录。`dsh.profile` 声明它由哪些组合包按什么顺序组成（"这套配置由谁组成？"）。

组合包是你编写并分发的东西；profile 是用户用 `dsh --profile <name>` 启动的东西。没有东西同时是两者。

### 6.2 组合包目录结构与 manifest

```
hello-plugin/
├── package.json       # 声明 dsh.bundle
├── cordis.patch.yml   # 被 profile 引用时应用的配置层
└── index.js           # patch 行引用的插件模块
```

`hello-plugin/package.json`：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`hello-plugin/index.js`：

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

`hello-plugin/cordis.patch.yml`（插件行按**包名**引用，而不是相对源码路径，这样 Node 模块解析才能找到已安装代码）：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

> 没有 `dsh.bundle` 声明的包仍可安装，但只作为普通依赖（`dsh plugin` 会打印警告且不激活任何层）。供插件包 import 的库用这种包格式。

### 6.3 profile manifest

profile 目录含两个文件：

- `package.json` — 树外插件依赖（pnpm 管理）+ `dsh.profile` manifest 及有序 `bundles` 列表。
- `cordis.patch.yml` — 用户自己的 patch 层，在每个组合包层之后应用。

profile manifest **从不需要手写**，由 `dsh plugin` 创建和维护。

### 6.4 安装进 profile

在包含 `hello-plugin` 的目录中：

```sh
dsh plugin --profile demo add ./hello-plugin
```

首次使用会初始化 profile（`@deepseek-ai/dsh-base` 作为第一个组合包），pnpm 链接 checkout，`dsh` 因该包声明了 `dsh.bundle` 把它追加进 `dsh.profile.bundles`：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"]
    }
  }
}
```

先验证层、再启动：

```sh
dsh --profile demo --dump-config   # 应显示 "# == dsh-hello-plugin" 层
dsh --profile demo
```

卸载：

```sh
dsh plugin --profile demo remove dsh-hello-plugin
```

### 6.5 加载顺序

生效配置在空根之上按序组合：

1. profile `dsh.profile.bundles` 列表的各个组合包 patch（按列表顺序：先是 `@deepseek-ai/dsh-base`，再是各已安装组合包按加入顺序）。
2. profile 自己的 `cordis.patch.yml`。
3. home 级 `$DSH_HOME/cordis.patch.yml`（各 profile 共享的机器本地偏好）。
4. 每个 `--patch <path>` overlay（按 argv 顺序）。

后应用的层按行胜出；patch 会替换目标行的**整个 `config` 值**（不是深度合并各键）。推论：

- 你的 patch 可按 `id` 覆盖前面层的行，但必须重述该行需要的**每个键**。
- 用户可在自己 profile 的 `cordis.patch.yml` 中覆盖你的行，无需改你的包——所以优先给出用户大概率保留的默认值，其余交给 schema。

### 6.6 表层组合包持有自己的命令行

定义了可运行应用的组合包挂载普通提供方插件，注入 `cmdlineArgs`，用自己的 commander program 解析应用参数（见 [`../packages/boot/cmdline/README.md`](../packages/boot/cmdline/README.md)）。受参数配置的行在 `!!js` 选项中读取该服务：

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

这样为组合包增加应用专属 flag 无需修改启动器。

### 6.7 三种分发方式

1. **发布到 npm**（推荐、无需用户授权构建）：`pnpm publish` 时构建好 `lib/`；用户 `dsh plugin add your-package` 安装预构建代码。
2. **交付 tarball**：`pnpm pack` 打包；用户 `dsh plugin add ./hello-plugin-0.1.0.tgz`。
3. **从 git 安装**：`dsh plugin add github:you/hello-plugin`。注意 git 拉取的是**源码**而非构建产物，必须：
   - **作者**提供自包含的 `prepare` 脚本（pnpm 在 git 安装后运行它），从源码构建出发布入口；不能假设旁边有 monorepo checkout。
   - **用户**授权构建：pnpm ≥10 默认拒绝运行 git 依赖的 `prepare`，第一次 `add` 失败后，把 pnpm 打印的包键复制进该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，再重新 `add`。
   - 该授权意味着"允许该包代码在安装时于你的机器上执行"，且不在 agent 沙箱内；只对可信源码授权，并**锁定 commit**（`github:you/hello-plugin#<sha>`）。

---

## 7. 路径 B：在仓库内新增 workspace 包

把插件做进本 monorepo（`packages/<group>/<pkg>`）。完整逐文件清单见 [`../docs/cookbook/adding-a-package.md`](../docs/cookbook/adding-a-package.md)。

### 7.1 目录结构

```
packages/<group>/<pkg>/
  package.json     # 从 packages/core/tools 复制，改 name/description/deps
  tsconfig.json    # extends ../../../tsconfig.base.json；rootDir src；
                   # outDir lib/types；references 指向 vendor/cordis(+schemastery)
                   # 及每个 dsh 依赖
  src/index.ts     # 服务 default 导出，或插件 name/inject/apply/Config
  README.md        # 服务 API、事件、扩展点、设计说明 + Model Experience + 限制
```

### 7.2 package.json 不变量（由 `pnpm run constraints` 强制）

- `private: true`、`version` 与根 `package.json` 一致、`type: module`。
- `main: "lib/index.js"`、`types: "lib/types/index.d.ts"`。
- `exports["."].types: "./lib/types/index.d.ts"`、`exports["."].default: "./lib/index.js"`。
- `@deepseek-ai/cordis` 同时出现在 `peerDependencies` 和 `devDependencies`（同范围）。
- `@deepseek-ai/schemastery` 放在 `dependencies`（它是运行时校验器）。
- `files` 精确列出 `lib/index.js`、`lib/invariant.js`、`lib/types/**/*.d.ts` 及包专属运行时产物；不发布 `src`、声明 map、JS map。

### 7.3 注册到根配置

| 文件 | 改动 |
|---|---|
| `tsconfig.base.json` | 已有 group 无需改；新 group 需在 `@deepseek-ai/dsh-*` 通配里加 `./packages/<group>/*/src` |
| `tsconfig.host.json`（Host 包）或 `tsconfig.client.json`（Client 包） | 在 `references` 加 `{ "path": "./packages/<group>/<pkg>" }`；普通包只属于一个 aggregate |
| `knip.json` | 仅当包有仓库发现覆盖不到的入口时才改 |

由 glob / manifest 自动覆盖、无需改的：根 `package.json` workspaces、`scripts/publint-all.ts`、`tsdown.config.ts`、`.oxlintrc.json`、`scripts/check-workspace-constraints.ts`。

### 7.4 拓扑决策

- 一项能力足够通用、需要可替换提供方时，拆成三个角色包：**Service Definition**（定义服务与 Request/Result 类型）/ **Service Provider**（实现）/ **Consumer**（把能力暴露为模型可调用工具）。
- 拆分前提是"角色需要独立演进或替换"；**不要预防性拆分**。简单工具插件单包即可。
- Service Provider 与 Consumer 互不依赖，都只依赖 Service Definition。
- 命名见 cookbook 的"角色命名表"（Controller / Store / Registry / Runtime / Provider / Backend 等，按真实职责取名）。

### 7.5 README 要求

- 先写服务 API、配置、事件、扩展点、设计说明。
- 以规范格式写 **Model Experience**（模型看到的字段、token 影响、KV Cache 影响）。
- 以 `## Known Limitations and Deferred Work` 记录持久的消费方缺口与维护约束。
- 改动了行为（配置键、默认值、错误码、wire 字段）必须在同一 commit 更新 README 与 JSDoc。

### 7.6 让仓库内包生效

内置组合包（`base` / `web-app` / `headless`）位于 [`../packages/bundle/`](../packages/bundle/README.zh.md)，它们的 `cordis.patch.yml` 决定默认挂载哪些行。仓库内新包要被默认 profile 加载，需要在相应 bundle 的 patch 里插入对应行（或供用户通过自己的 patch 挂载）。

---

## 8. 验证与质量门禁

### 8.1 本地校验命令

```sh
pnpm install                       # 注册 workspace
pnpm run doc-sync                  # 文档门禁
pnpm run constraints && pnpm run typecheck && pnpm run lint
pnpm run build && pnpm run hygiene
```

测试相关：

```sh
pnpm run test                       # vitest 单元测试
pnpm run test:coverage              # CI 覆盖率门禁（packages/*/*/src 每文件 100%）
pnpm run test:e2e                   # 真实 API 测试（无 DEEPSEEK_API_KEY 自动跳过）
pnpm run test:snapshot              # 无密钥快照回放；filter: -t <name>
```

### 8.2 仓库强约束（写插件时务必遵守）

- **产品可见插件必须有非单元级 REAL-composition 测试**：通过 Loader 启动测试专用 `cordis.yml`，断言模型可见 / 持久化 / 用户可见输出；仅 mock 外部服务或不确定输入。手搭 `ctx.plugin(...)` 套件不够（见 [`../docs/testing.md`](../docs/testing.md)）。
- **注册项要证明可处置**：dispose fiber 并观察移除（HMR 安全测试）。
- 每个包要有 `./invariant`：注册 manifest 名、检查事件/数据关系，或给出包专属的 "No runtime invariant" 理由。
- 每个包要有模型可见性 / token / KV Cache 影响说明；非平凡改动同一 PR 附带 Agent Note。
- 快照测试用于模型或用户输出；真实 API e2e 用于提供方行为。

### 8.3 用 dump 验证组合结果

不启动即可检查配置树：

```sh
dsh --profile web --dump-default-config            # 只打印组合包各层
dsh --profile web --patch ./extra.yml --dump-config # 额外加 profile/home/--patch 层
```

dump 会标注每行由哪个文件提供、哪些 overlay 修改过它；`!!js` 保持未求值，找不到目标的 patch 报告到 stderr。

---

## 9. 部署与运行

### 9.1 启动 profile

```sh
dsh --profile <name>            # 启动 $DSH_HOME/profiles/<name>
dsh web                         # 等价于 dsh --profile web，默认 http://127.0.0.1:3080
dsh web --patch ./extra.cordis.yml
dsh --profile headless "run the tests"   # 一次性任务，需要 DEEPSEEK_API_KEY
```

`web` 与 `headless` profile 首次使用会从随附模板自动初始化（`web`: base + web-app；`headless`: base + headless）；其他缺失的 profile 会显式报错并提示 `dsh plugin --profile <name> add <package>`。

### 9.2 生产 Web 运行前提

生产 Web 运行器需要已构建的包和前端产物：

```sh
pnpm run build
```

源码形式每次产物需要更新时都要单独跑 `pnpm run build`，再用 `pnpm dsh ...`。

### 9.3 组合包解析顺序

组合包名称先从 dsh 安装目录解析，再从 profile 目录解析。因此内置组合包始终来自当前 `dsh` 安装；树外组合包来自 profile 里 pnpm 管理的 `node_modules`。patch 行中的裸插件 `name` 从 profile 目录按 Node 模块解析逐级向上查找，直至 dsh 维护的安装后备目录 `$DSH_HOME/profiles/node_modules`。

---

## 10. 端到端完整步骤清单

以"开发一个 `greet` 工具插件并交付"为例：

**本地开发**
1. `pnpm install` + `pnpm run build`（源码形式）。
2. `mkdir -p scratch-plugin/src`。
3. 写 `scratch-plugin/src/my-plugin.ts`（`name` + `inject = ['tools']` + `apply` + `defineTool`）。
4. 写 `scratch-plugin/cordis.yml`（`insert` 行，`name` 为绝对路径）。
5. `pnpm dsh web --patch ./scratch-plugin/cordis.yml`，浏览器验证工具可被模型调用。
6. 迭代代码，靠 HMR 热替换；需要配置时加 `Config` schema。

**打包（路径 A）**
7. 建 `hello-plugin/`：`package.json`（`dsh.bundle`）+ `index.js` + `cordis.patch.yml`（按包名引用）。
8. 选分发方式：`pnpm publish`（npm）/ `pnpm pack`（tarball）/ git + `prepare`（需 `allowBuilds`）。

**安装部署**
9. `dsh plugin --profile demo add ./hello-plugin`（或 npm 包名 / tarball / git spec）。
10. `dsh --profile demo --dump-config` 验证出现 `# == dsh-hello-plugin` 层。
11. `dsh --profile demo` 启动验证。

**打包（路径 B，进 monorepo）**
7'. 建 `packages/<group>/<pkg>/`（package.json / tsconfig / src/index.ts / README.md）。
8'. 注册进 `tsconfig.host.json`（或 `client.json`）、必要时 `knip.json`、`tsconfig.base.json`。
9'. 在目标 bundle 的 `cordis.patch.yml` 插入该包行。
10'. `pnpm run constraints && pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run hygiene` + 相关测试 + `pnpm run doc-sync`。

**验证收尾**
- 确认 `--dump-config` 符合预期。
- 确认测试覆盖（含 REAL-composition 测试）通过。
- 非平凡改动附带 Agent Note；README/JSDoc 同步。

---

## 11. 常用命令速查

| 命令 | 作用 |
|------|------|
| `pnpm dsh web --patch ./scratch-plugin/cordis.yml` | 源码形式启动 Web UI 并注入本地插件层 |
| `pnpm dsh --profile headless "task"` | 一次性任务（需 `DEEPSEEK_API_KEY`） |
| `dsh plugin --profile <name> add <package>` | 安装插件/组合包进 profile（转发 pnpm） |
| `dsh plugin --profile <name> remove <pkg>` | 移除依赖及对应层 |
| `dsh --profile <name>` | 启动 profile |
| `dsh web` | 启动 web profile（默认 127.0.0.1:3080） |
| `dsh --profile <name> --dump-config` | 打印组合配置树（含 overlay 来源标注） |
| `dsh --profile <name> --dump-default-config` | 只打印组合包各层 |
| `pnpm run build` | 生成 Host/前端产物（源码形式启动前需要） |
| `pnpm run typecheck` / `lint` / `hygiene` / `doc-sync` | 质量门禁 |

---

## 12. 参考链接

- 基础：[第一个插件](../docs/user/develop/basic/index.zh.md) · [开发一个工具](../docs/user/develop/basic/tool.zh.md) · [插件配置](../docs/user/develop/basic/config.zh.md) · [打包与安装](../docs/user/develop/basic/publish.zh.md)
- 框架：[生命周期](../docs/user/develop/framework/index.zh.md) · [服务与依赖](../docs/user/develop/framework/service.zh.md) · [事件系统](../docs/user/develop/framework/events.zh.md)
- 进阶：[能力分层](../docs/user/develop/practice/index.zh.md) · [LLM 适配器](../docs/user/develop/practice/llm-adapter.zh.md)
- 仓库：[新增 workspace 包](../docs/cookbook/adding-a-package.md) · [工具编写参考](../docs/cookbook/adding-a-tool.md) · [CLI 行为参考](../apps/cli/reference/README.zh.md) · [bundle 组合包](../packages/bundle/README.zh.md) · [测试策略](../docs/testing.md)
