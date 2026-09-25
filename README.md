# dsh-ping

English · [简体中文](#简体中文)

**Native DSH. Telegram pings. Nothing else.**

Step away from DeepSeek Harness without missing a question, an approval
request, or a completed turn.

dsh-ping sends the notification. DSH keeps the question cards, answers,
and approval decisions.

**One runtime source file · Zero runtime dependencies · No custom question cards**

[Quickstart](#quickstart) ·
[Compatibility status][compatibility] ·
[For coding agents](#for-coding-agents) ·
[Configuration](#configuration)

<!-- dsh-compat:start -->

<!-- dsh-compat:end -->

## Small on purpose

- **Native questions.** Agents use DSH's `ask_user_question`. No replacement
  tool, special prompting convention, or custom clarification cards.
- **Native interaction.** Answer in DSH's web GUI, including dsh-mobile.
  dsh-ping does not intercept answers or make approval decisions.
- **Simple setup.** Install the plugin, configure two credentials, restart.
  No additional service or dashboard to operate.
- **Release-watched compatibility.** The maintainer runs real-DSH
  canaries when new releases appear on `next`. Results identify the exact
  versions tested.

No Telegram answering flow. No inbound polling or webhooks. No admin
console. No runtime state files. No extra notification channels.

**DSH owns the interaction. dsh-ping gets your attention.**

## What you get

| Event | Telegram notification | Default |
|---|---|---|
| Agent asks a question | `❓ Question asked: <excerpt>` | On |
| Approval is requested | `⚠️ Approval requested: <tool> — <reason>` | On |
| A session turn completes | `✅ Done: <session title> (turn N)` | On |
| Agent encounters an error | `❗ Agent error: <message>` | Opt-in |

Question cards remain in DSH's web GUI, where you answer them.

Completed-turn notifications use a per-session trailing debounce:
one second by default. Sessions with `header.origin === 'subagent'` are
excluded from **completion notifications**; ordinary forked conversations
are not.

Notifications report **observed requests**, not guaranteed pending work.
DSH can reject or cancel an approval after emitting the request, and a
question notification is initiated before the downstream answerer runs.

**A ping does not guarantee something is still waiting. Silence never
approves anything.**

## Quickstart

You need:

- DSH, with `pnpm` on `PATH`.
- Node.js 22 or newer, subject to any additional requirements of your DSH version.
- A Telegram bot token and chat ID.

Create a bot with [@BotFather](https://t.me/BotFather). Message your bot
once, then obtain your `chat.id` from:

```text
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Treat the token as a secret.

### 1. Install into the profile you use

For the `web` profile:

```sh
dsh plugin --profile web add github:chintoleung/dsh-ping
```

Replace `web` if you use another profile.

This adds the dependency and activates its bundle in the profile's
`dsh.profile.bundles`.

For a reproducible installation, use the pinned `installRef` from a
passing [compatibility record][compatibility] instead of the
default-branch reference.

### 2. Configure your credentials

Add this row to your profile's `cordis.patch.yml`, for example
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: dsh-ping
  config:
    telegram:
      botToken: !!js "process.env.DSH_PING_TG_TOKEN || ''"
      chatId: !!js "process.env.DSH_PING_TG_CHAT || ''"
```

Set the two environment variables:

```sh
export DSH_PING_TG_TOKEN='your-bot-token'
export DSH_PING_TG_CHAT='your-chat-id'
```

They must be available to the process that launches DSH. If you use
launchd, systemd, or another service manager, configure them there—not
only in an unrelated terminal.

> **Why `!!js` rather than `${ENV:…}`?**
> DSH's hot-reload path has passed `${ENV:…}` through literally instead
> of expanding it. The `!!js` bindings evaluate during YAML parsing,
> including hot reload.

### 3. Restart DSH

With the default event settings, look for:

```text
[dsh-ping] armed: question/approval/turnEnd → telegram chat …<last4>
```

Ask the agent to ask you a clarification question. You should receive a
Telegram notification and see DSH's native question card.

Answer in DSH, not Telegram.

Without credentials, the plugin stays inert and registers no listeners.

> **Privacy:** notification content goes to Telegram. Question excerpts,
> approval details, and session titles may contain sensitive information.
> See [Privacy](#privacy).

## Compatibility

**Native-first reduces the code that has to follow DSH changes.
Real-DSH canaries check the integration points that remain.**

dsh-ping does not implement its own question cards, clarification protocol,
answering service, or approval system. It observes DSH's existing events
and leaves the native interaction flow intact.

That is a smaller maintenance surface—not a claim that upstream events
can never break.

### Release watch → verification canary

Our maintenance policy is to run a compatibility canary for every new
DSH release on the **`next` channel**.

The release-watch workflow is:

1. The DSH release watch detects a new upstream version.
2. The maintainer selects that **exact DSH version** and
   a specific dsh-ping revision.
3. The unit suite and the real-DSH compatibility canary are run.
4. The outcome and verification evidence are published in
   [compatibility.json][compatibility].
5. Failed checks are investigated. Missing packages, a missing matching
   testkit, or setup failures remain explicitly unverified.

Verification is maintainer-side automation. **You do not need it to
install or run dsh-ping.** The plugin itself does not poll npm, check for
updates, or update your DSH installation.

A new release is unverified until its check passes. A successful check
against an older version is not a pass for a newer release.

### Where to check current compatibility

Read [compatibility.json][compatibility].

A completed verification record identifies:

- The exact DSH and matching testkit versions.
- The dsh-ping version and tested Git commit.
- A pinned installation reference.
- The Node.js version and platform used.
- Unit-test and canary outcomes.
- Verification time and a link to the supporting log or report.

Status meanings:

| Status | Meaning |
|---|---|
| `passed` | The required tests passed for the recorded version/revision pair. |
| `pending` | A target has been identified; verification is not complete. |
| `failed` | A required test failed; inspect the evidence. |
| `blocked` | Verification could not be completed, for example because the matching testkit is unavailable. |
| `unknown` | No usable verification result has been published. |

Missing evidence is **not verified**, not an implied pass.

Our tracked channel is `next`. npm's separate `latest` tag is not covered
merely because a `next` check passed. Neither tag name is a guarantee
about version ordering.

### For coding agents

To answer “Is dsh-ping compatible with the current DSH `next`?”:

1. Resolve the channel now:

   ```sh
   npm view @deepseek-ai/dsh@next version
   ```

2. Read the current [compatibility.json][compatibility] from the
   repository—not only a copy bundled with an older release.

3. Require:
   - `status` is `passed`.
   - `unitTests` and `canary` are both `passed`.
   - `dshVersion` matches the version you just resolved.
   - The tested `pluginCommit` is the revision you intend to use.
   - The record you use is the entry in `records[]` matching **both**
     `dshVersion` and `pluginCommit`.
   - The evidence identifies an executed canary, not a skipped test.

4. Use the record's pinned `installRef` to install the tested revision.

5. If the versions do not match, the record is incomplete, or the
   channel cannot be checked, report **not verified for the current
   channel**. Run the canary rather than guessing.

If the user means npm's `latest` channel, resolve `@deepseek-ai/dsh@latest`
and verify that exact version instead.

An old result can still describe a verified historical pair. It does not,
by itself, establish what the current channel points to.

**Do not infer compatibility from a successful installation, the absence
of peer dependency restrictions, or a generic green CI badge.**

### What the canary exercises

The canary boots real DSH components, including:

- Cordis `Context`.
- `AgentLoop`.
- The user-questions waterfall.
- Approval handling.
- Session-title handling.

It uses an offline model adapter and stubbed Telegram delivery. The
canary itself makes no live LLM calls and needs no live bot credentials.

It exercises:

- Completed-turn notifications and session labels.
- Subagent-origin completion filtering.
- Approval observation without changing the decision.
- Global, prepended question observation.
- Preservation of downstream question results and failures.
- Optional error notifications.
- Plugin unload/reload behavior.

**Boundaries:**

- This is an integration canary, not a browser-rendering or live Telegram
  delivery test.
- The question checks exercise the real waterfall with a test answerer,
  not a complete browser interaction.
- The subagent fixture supplies its own `origin` metadata. The check
  verifies filtering, not whether upstream delegation always produces
  that metadata.

### Verify a version yourself

Run these commands from a checkout of the dsh-ping revision you intend
to deploy.

To resolve the current `next` once, then test that exact version:

```sh
DSH_VERSION="$(npm view @deepseek-ai/dsh@next version)" &&
npm test &&
npm run test:dsh -- "$DSH_VERSION"
```

For another target, set `DSH_VERSION` to its exact published version.

For a release-watch event, use the version from that event rather than
replacing it with whatever `next` points to later.

The convenience form is also available:

```sh
npm run test:dsh -- next
```

For a pre-provisioned installation tree:

```sh
node scripts/dsh-compat.mjs --root /path/to/preprovisioned-dsh
```

The runner installs DSH and its matching testkit with installation scripts
disabled, isolates `DSH_HOME` and the working directory, strips inherited
Telegram credentials, and retains failed installations for diagnosis.

A DSH release without a matching `dsh-agent-loop-testkit` cannot be
canaried by this runner. That means **compatibility not evaluated**, not
automatically incompatible.

Deploy the tested DSH version with the tested plugin revision only after
the required checks pass. Repeat the checks when changing either.

## Configuration

The credentials are required to arm the plugin. Other settings are
optional; the defaults are shown below.

```yaml
- id: dsh-ping
  config:
    enabled: true

    telegram:
      botToken: !!js "process.env.DSH_PING_TG_TOKEN || ''"
      chatId: !!js "process.env.DSH_PING_TG_CHAT || ''"

    events:
      question: true
      approval: true
      turnEnd: true
      agentError: false

    debounceMs: 1000
    excerptChars: 80
```

| Setting | Behavior |
|---|---|
| `enabled` | Set to `false` to disable the plugin. |
| `events.question` | Notify when a native question request is observed. |
| `events.approval` | Notify when an approval request is observed. |
| `events.turnEnd` | Notify when an eligible session turn completes. |
| `events.agentError` | Opt in to error-message notifications. |
| `debounceMs` | Per-session trailing debounce for completion notifications. `0` means immediate; bounded to `0–3600000`. |
| `excerptChars` | Payload excerpt limit. Default `80`; bounded to `20–2048`. |

Invalid numeric settings fall back to their defaults. Assembled messages
are additionally capped at 4,096 characters.

## Runtime design

The plugin uses two event subscriptions by default and one optional
error subscription:

| Integration point | Behavior |
|---|---|
| `session/event` | Observe approvals, completed turns, and session titles. |
| `user-questions/request` | Observe the question, then pass through to the native downstream handler. |
| `agent/error` | Observe errors when explicitly enabled. |

The question listener is registered with `{ prepend: true, global: true }`
and returns `next()`. It does not settle the question, replace the
answerer, or swallow downstream failures.

Other design choices:

- **No service injection:** no `inject` declarations or DSH service API calls.
- **No history reads:** session titles are learned passively from
  `session/title` events.
- **Bounded in-memory bookkeeping:** no runtime state files.
- **Dedup before debounce:** replayed session events cannot cancel a newer
  pending completion notification.
- **Lifecycle-aware delivery:** disposal cancels pending timers and
  prevents new sends and retries.

No DSH peer dependencies are declared. This avoids a declared version
gate; it does **not** prove compatibility.

The runtime audit surface is [src/index.mjs](src/index.mjs).

## Tested behavior

The test suite covers:

- Missing or empty credentials leave the plugin inert.
- DSH event handlers never await Telegram delivery.
- Downstream question results and error objects are preserved.
- Notification failures are contained, logged, and dropped.
- Disposal cancels pending timers and prevents subsequent sends/retries.
- Numeric configuration is validated and bounded, including an explicit
  `debounceMs: 0`.
- Bot tokens are redacted from plugin logs; the armed line shows only the
  chat ID tail.
- Subagent-origin completion filtering does not suppress ordinary forks.

### Delivery policy

Delivery is best-effort:

- Network failures and server errors receive one retry.
- HTTP 4xx responses, including `429` rate limiting, are dropped without retry.
- There is no persistent queue or delivery guarantee.
- Messages can be lost during outages or bursts.

An already in-flight request may finish after the plugin is disposed.

## Privacy

Notifications send the following to Telegram through your bot:

- Question excerpts.
- Approval details: tool name and reason.
- Session titles.
- Error messages, if error notifications are enabled.

**These contents may include sensitive information and are not redacted.**
Token redaction in logs is not content redaction in notifications.

The runtime plugin sends traffic to `api.telegram.org`. It has no
telemetry, analytics, release-watcher traffic, or other network calls.

Compatibility reports are maintainer-published repository metadata, not
state files created by the plugin on your machine.

## Deliberate limitations

- **One destination:** one bot token and one chat ID.
- **Notification-only:** answer questions and handle approvals in DSH,
  not Telegram.
- **Observed, not pending:** a notification does not prove the request
  is still waiting.
- **Best-effort delivery:** no durable queue or guaranteed delivery.
- **Cold-start titles:** sessions titled before the plugin loaded may
  appear as `#<short-id>` until a title is observed.
- **No automatic upgrades:** dsh-ping does not change your DSH version.
- **No blanket compatibility promise:** evidence applies to the recorded
  version/revision pair and tested integration scope.

## Development and verification

From the repository checkout:

```sh
npm test
node --check src/index.mjs
npm run test:dsh -- next
```

The default test suite skips the real-DSH canary unless
`DSH_COMPAT_ROOT` is set. **A passing `npm test` alone is not a real-DSH
compatibility result.** Use the canary runner.

Before publishing a plugin change, verify it against the intended DSH
version again. Upstream release monitoring does not replace testing
changes to this plugin.

### Live smoke test after installation

1. Confirm the boot log shows `armed:`, not `inert:` or a disabled message.
2. Ask the agent to ask you a clarification question.
3. Confirm both the Telegram notification and the native DSH question card.
4. Answer in DSH and confirm the interaction continues normally.
5. Let a turn complete and check the completion notification.

This complements the automated canary by checking your actual
credentials, Telegram connectivity, and user interface.

## Uninstall / migrate

For the `web` profile:

```sh
dsh plugin --profile web remove dsh-ping
```

This removes the dependency and its `dsh.profile.bundles` entry.

Remove the profile configuration row and the two environment variables,
then restart DSH.

## License

MIT — see [LICENSE](LICENSE).

---

# 简体中文

**原生 DSH 交互。Telegram 通知。仅此而已。**

离开屏幕，也不错过 DeepSeek Harness 智能体的提问、审批请求和回合完成。

dsh-ping 负责提醒你。问题卡片、回答和审批决定，继续交给 DSH。

**单个运行时源文件 · 零运行时依赖 · 不自建问题卡片**

[兼容性状态][compatibility] ·
[快速开始](#快速开始) ·
[供编码智能体使用](#供编码智能体使用)

<!-- dsh-compat-zh:start -->

<!-- dsh-compat-zh:end -->

## 小而专一

- **原生提问：** 使用 DSH 的 `ask_user_question`，不引入替代工具、
  特殊提示词约定或自定义澄清卡片。
- **原生交互：** 在 DSH 的 Web GUI（含 dsh-mobile）里作答。
  插件不拦截回答，也不代替你作审批决定。
- **简单配置：** 安装插件、配置两个凭据、重启。
  不需要额外运行服务或管理后台。
- **跟随发布验证：** DSH 发布监控发现 `next` 上的新版本后，
  维护者运行真实 DSH 兼容性 canary，并记录确切的测试版本。

无 Telegram 应答流程、无入站轮询或 webhook、无管理台、
无运行时状态文件、无额外通知渠道。

**DSH 负责交互，dsh-ping 负责提醒。**

## 功能一览

| 事件 | Telegram 通知 | 默认 |
|---|---|---|
| 智能体提问 | `❓ Question asked: <摘要>` | 开 |
| 请求审批 | `⚠️ Approval requested: <工具> — <原因>` | 开 |
| 会话回合完成 | `✅ Done: <会话标题> (turn N)` | 开 |
| 智能体出错 | `❗ Agent error: <消息>` | 需显式开启 |

问题卡片仍在 DSH 的 Web GUI 中显示，并在那里作答。

回合完成通知采用每会话尾随去抖，默认一秒。
`header.origin === 'subagent'` 的会话不发送**完成通知**；
普通 fork 会话不受此限制。

通知表示**观测到了请求**，不保证请求仍在等待处理。
审批可能随后被拒绝或取消；提问通知也在下游应答器运行之前发起。

**收到通知不代表仍有待办；沉默永远不会批准任何操作。**

## 快速开始

需要：

- DSH，且 `pnpm` 在 `PATH` 上。
- Node.js 22 或更新版本；同时满足所用 DSH 版本的额外要求。
- Telegram bot token 和 chat ID。

通过 [@BotFather](https://t.me/BotFather) 创建 bot。
先给 bot 发一条消息，再从以下接口读取 `chat.id`：

```text
https://api.telegram.org/bot<TOKEN>/getUpdates
```

请妥善保管 token。

### 1. 安装到正在使用的 profile

以 `web` 为例：

```sh
dsh plugin --profile web add github:chintoleung/dsh-ping
```

如果使用其他 profile，请替换 `web`。

该命令会添加依赖，并在 profile 的 `dsh.profile.bundles` 中激活 bundle。

需要可复现安装时，请使用通过验证的
[兼容性记录][compatibility] 中的 `installRef`，
而不是默认分支引用。

### 2. 配置凭据

在 profile 的 `cordis.patch.yml` 中加入以下配置。
例如 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-ping
  config:
    telegram:
      botToken: !!js "process.env.DSH_PING_TG_TOKEN || ''"
      chatId: !!js "process.env.DSH_PING_TG_CHAT || ''"
```

设置环境变量：

```sh
export DSH_PING_TG_TOKEN='your-bot-token'
export DSH_PING_TG_CHAT='your-chat-id'
```

这两个变量必须对启动 DSH 的进程可见。
使用 launchd、systemd 等服务管理器时，应在那里配置，
而不是只在另一个终端中导出。

> **为什么使用 `!!js`，而不是 `${ENV:…}`？**
> DSH 的热加载路径曾将 `${ENV:…}` 作为字面量透传。
> `!!js` 在 YAML 解析时求值，也适用于热加载路径。

### 3. 重启 DSH

默认事件配置下，应看到：

```text
[dsh-ping] armed: question/approval/turnEnd → telegram chat …<last4>
```

让智能体向你提出一个澄清问题。
确认收到 Telegram 通知，同时 DSH 中出现原生问题卡片。

在 DSH 中回答，不是在 Telegram 中。

凭据为空时，插件保持惰性，不注册任何监听器。

> **隐私提示：** 提问摘要、审批详情和会话标题会发送到 Telegram，
> 其中可能包含敏感信息。请先阅读下方隐私说明。

## 兼容性与发布跟踪

**尽量使用原生交互，减少需要跟随 DSH 变化的代码；
用真实 DSH canary 验证剩余的集成点。**

dsh-ping 不实现自己的问题卡片、澄清协议、应答服务或审批系统。
它观察 DSH 已有的事件，让原生交互流程保持不变。

这意味着更小的维护面，不代表上游事件永远不会发生破坏性变化。

### 发布监控 → 验证 canary

维护策略是：**针对 `next` 渠道的每个新 DSH 发布运行兼容性 canary。**

流程如下：

1. DSH 发布监控发现新版本。
2. 维护者选定该**确切 DSH 版本**和一个确定的 dsh-ping Git 修订。
3. 运行单元测试和真实 DSH 兼容性 canary。
4. 将结果及验证证据发布到 [compatibility.json][compatibility]。
5. 测试失败时排查；缺少软件包、匹配的 testkit 或运行环境异常时，
   明确记录为尚未完成验证。

验证是维护者侧的自动化。
**安装和运行 dsh-ping 不需要这套验证。**
插件本身不会轮询 npm、检查更新或升级你的 DSH。

新版本只有在验证通过后才算已验证。
旧版本的通过结果不能自动算作新版本通过。

### 查看兼容性状态

查看 [compatibility.json][compatibility]。

完整验证记录包含：

- DSH 和匹配 testkit 的确切版本。
- dsh-ping 版本、被测试的 Git commit 和固定安装引用。
- Node.js 版本与运行平台。
- 单元测试和 canary 结果。
- 验证时间，以及日志或报告链接。

状态含义：

| 状态 | 含义 |
|---|---|
| `passed` | 记录中的版本与修订组合通过了要求的测试。 |
| `pending` | 已发现目标版本，验证尚未完成。 |
| `failed` | 必需的测试失败，需要查看证据。 |
| `blocked` | 无法完成验证，例如缺少匹配的 testkit。 |
| `unknown` | 尚无可用验证结果。 |

缺少证据意味着**未验证**，不是默认通过。

本项目跟踪 `next`。
npm 的 `latest` 是另一个 dist-tag；`next` 验证通过不意味着
`latest` 也已验证。标签名称也不保证版本先后顺序。

### 供编码智能体使用

判断“是否兼容当前 DSH `next`”时：

1. 查询当前渠道对应的确切版本：

   ```sh
   npm view @deepseek-ai/dsh@next version
   ```

2. 读取仓库当前的 [compatibility.json][compatibility]，
   不要只使用旧版本中附带的副本。

3. 确认：
   - `status` 为 `passed`。
   - `unitTests` 与 `canary` 都为 `passed`。
   - `dshVersion` 等于刚查询到的版本。
   - `pluginCommit` 是准备安装或使用的修订。
   - 使用 `records[]` 中**同时**匹配 `dshVersion` 与 `pluginCommit` 的那一条记录。
   - 证据表明确实执行了 canary，而不是跳过。

4. 使用记录中的固定 `installRef` 安装已测试修订。

5. 如果版本不匹配、记录不完整或无法查询当前渠道，应回答
   **“尚未验证与当前渠道兼容”**，并运行 canary，不要推测。

如果用户所说的“latest”指 npm 的 `latest` 标签，
请单独查询 `@deepseek-ai/dsh@latest` 并验证该确切版本。

历史通过结果仍可证明相应历史组合经过验证，
但不能单独证明当前渠道指向什么版本。

**安装成功、没有 peer 版本限制或通用 CI 绿灯，都不是兼容性证明。**

### Canary 验证什么

Canary 启动真实 DSH 组件，包括 Cordis `Context`、`AgentLoop`、
user-questions waterfall、审批处理和会话标题处理。

它使用离线模型适配器，并对 Telegram 投递打桩。
Canary 本身不调用真实 LLM，也不需要真实 bot 凭据。

覆盖内容包括：

- 回合完成通知和会话标题。
- 子智能体来源会话的完成通知过滤。
- 不改变审批决定的请求观察。
- 全局、前置的提问观察器。
- 下游提问结果和错误的原样传播。
- 错误通知开关。
- 插件卸载与重新加载。

边界：

- 这是集成 canary，不是浏览器渲染测试或真实 Telegram 投递测试。
- 提问测试使用真实 waterfall 和测试应答器，不覆盖完整浏览器交互。
- 子智能体 fixture 自行提供 `origin` 元数据，因此验证的是过滤逻辑，
  不是上游委派机制是否始终产生该字段。

### 自行验证版本

在准备部署的 dsh-ping 修订对应的仓库 checkout 中运行。

先解析一次当前 `next`，再验证该确切版本：

```sh
DSH_VERSION="$(npm view @deepseek-ai/dsh@next version)" &&
npm test &&
npm run test:dsh -- "$DSH_VERSION"
```

验证其他版本时，将 `DSH_VERSION` 设置为目标的确切发布版本。

处理发布监控事件时，应使用事件中的版本，
不要用稍后可能已经变化的 `next` 替代它。

也可以直接运行：

```sh
npm run test:dsh -- next
```

使用预置安装目录：

```sh
node scripts/dsh-compat.mjs --root /path/to/preprovisioned-dsh
```

Runner 安装 DSH 和匹配 testkit 时禁用安装脚本，
隔离 `DSH_HOME` 与工作目录，移除继承的 Telegram 凭据，
并在失败时保留安装目录供排查。

缺少匹配的 `dsh-agent-loop-testkit` 时，runner 无法执行 canary。
这表示**未能评估兼容性**，不自动等于不兼容。

只有要求的检查都通过后，才部署被测试的 DSH 版本与插件修订。
任一方变化后，都应重新验证。

## 配置

凭据用于激活插件；其他设置可选。默认值如下：

```yaml
- id: dsh-ping
  config:
    enabled: true

    telegram:
      botToken: !!js "process.env.DSH_PING_TG_TOKEN || ''"
      chatId: !!js "process.env.DSH_PING_TG_CHAT || ''"

    events:
      question: true
      approval: true
      turnEnd: true
      agentError: false

    debounceMs: 1000
    excerptChars: 80
```

- `enabled: false`：禁用插件。
- `events`：分别控制提问、审批、完成和错误通知。
- `debounceMs`：完成通知的每会话尾随去抖，范围 `0–3600000`；
  `0` 表示立即发送。
- `excerptChars`：内容摘要上限，默认 `80`，范围 `20–2048`。
- 非法数值回退为默认值。
- 完整消息另外限制为最多 4,096 个字符。

## 运行时设计

默认使用两个事件订阅，另有一个可选错误订阅：

| 集成点 | 行为 |
|---|---|
| `session/event` | 观察审批、回合完成和会话标题。 |
| `user-questions/request` | 观察提问，再交给原生下游处理器。 |
| `agent/error` | 显式开启后观察错误。 |

提问监听器以 `{ prepend: true, global: true }` 注册，
并返回 `next()`。
它不自行完成提问、不替换应答器，也不吞掉下游错误。

其他设计选择：

- 无 `inject` 声明，不调用 DSH 服务 API。
- 不读取会话历史，通过 `session/title` 事件被动学习标题。
- 只使用有界的内存记录，不写运行时状态文件。
- 会话事件先去重，再处理去抖，避免旧事件重放吞掉新的待发通知。
- 销毁时取消待执行计时器，阻止新的发送与重试。

不声明 DSH peer 依赖意味着没有声明式版本门禁，
**不意味着所有版本都兼容**。

运行时代码可在一个文件中审阅：
[src/index.mjs](src/index.mjs)。

## 已测试的行为

测试覆盖：

- 凭据缺失或为空时保持惰性。
- DSH 事件处理器不等待 Telegram 投递。
- 下游提问结果和错误对象原样保留。
- 通知失败被隔离、记录并丢弃。
- 销毁后取消待执行计时器并阻止后续发送与重试。
- 数值配置经过校验和边界限制，尊重显式 `debounceMs: 0`。
- 插件日志对 bot token 脱敏，armed 日志仅显示 chat ID 尾部。
- 子智能体来源过滤不会抑制普通 fork 的完成通知。

### 投递策略

尽力投递：

- 网络错误和服务器错误重试一次。
- HTTP 4xx（包括 `429` 限流）不重试，直接丢弃。
- 无持久化队列，不保证送达。
- 故障或突发期间可能丢消息。

插件销毁时，已经发出的网络请求仍可能完成。

## 隐私

通知通过你的 bot 将以下内容发送到 Telegram：

- 提问摘要。
- 审批工具名和原因。
- 会话标题。
- 显式开启后的错误消息。

**这些内容可能含有敏感信息，且不会脱敏。**
日志中的 token 脱敏不等于通知正文脱敏。

运行时插件只向 `api.telegram.org` 发送网络请求，
无遥测、分析、发布监控流量或其他网络调用。

兼容性报告是维护者发布到仓库的元数据，
不是插件在用户机器上创建的状态文件。

## 刻意保留的限制

- **单一目标：** 一个 bot token、一个 chat ID。
- **仅通知：** 在 DSH 中回答问题和处理审批，不在 Telegram 中操作。
- **观测而非待处理：** 通知不证明请求仍在等待。
- **尽力投递：** 无持久化队列或送达保证。
- **冷启动标题：** 插件加载前已命名的会话，
  在观察到标题前可能显示为 `#<短id>`。
- **不自动升级：** 插件不会修改你的 DSH 版本。
- **不作无限兼容承诺：** 证据只适用于记录中的版本、修订和测试范围。

## 开发与验证

在仓库 checkout 中运行：

```sh
npm test
node --check src/index.mjs
npm run test:dsh -- next
```

未设置 `DSH_COMPAT_ROOT` 时，默认测试会跳过真实 DSH canary。
**仅 `npm test` 通过，不代表真实 DSH 兼容性验证通过。**
请使用 canary runner。

发布插件修改前，应重新针对目标 DSH 版本验证。
监控上游发布不能替代对插件自身修改的测试。

### 安装后的线上检查

1. 确认启动日志出现 `armed:`，而非 `inert:` 或禁用提示。
2. 让智能体向你提出澄清问题。
3. 确认收到 Telegram 通知，且 DSH 中出现原生问题卡片。
4. 在 DSH 中回答，确认交互正常继续。
5. 让一个回合完成，确认收到完成通知。

这补充了自动 canary 未覆盖的真实凭据、Telegram 连通性和界面检查。

## 卸载 / 迁移

以 `web` profile 为例：

```sh
dsh plugin --profile web remove dsh-ping
```

该命令移除依赖及对应的 `dsh.profile.bundles` 条目。

随后删除 profile 配置行和两个环境变量，并重启 DSH。

## 许可证

MIT — 见 [LICENSE](LICENSE)。

[compatibility]: https://raw.githubusercontent.com/chintoleung/dsh-ping/master/compatibility.json
