# analysis-bulletin

value 是已完成分析的指标点，status 为 estimated/unavailable，definition 是口径指纹。

项目提供本地记录校验、输入指纹、按 `metric` 的原始核算，以及可追溯的发布与对账。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
npm run demo
npm run demo:publish
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js publish --input data/records.json --policy data/policy.json --state var/publish --topic ops-weekly
node src/cli.js reconcile --policy data/policy.json --state var/publish
node src/cli.js trace --state var/publish
```

`npm run demo` 在本地打印输入、现有核算及配置并生成 `var/summary.json`。`npm run demo:publish` 在临时目录里演练完整发布链路（初版、回执写盘前崩溃与 reconcile 恢复、实质更正、阈值内小修、夏令时歧义），不访问网络、不等待真实业务时间。输出目录可删除后重新运行，测试只使用临时目录。

## 可追溯发布

一次签发冻结的是整份材料，而不是分别读取“最新正文”和“最新图”：

- 数据截点 `dataCutoff`、口径指纹 `definition`、输入指纹 `inputFingerprint`；
- 分析产物的中文解释片段与每个产物的 SHA-256 `hash`，以及整体 `artifactHash`；
- 全部指标点快照（数值、状态、口径、截点）；
- 对材料内容（不含签发时间）计算的 `materialHash`，同一份材料在任何时刻重算都得到同一哈希。

同一发布批次只允许一个 `definition`，混用口径版本直接拒绝；跨版本口径漂移不能作为同系列修订。冻结版本按 `主题#v序号` 编号，新版本只追加、永不覆盖旧版本，问“会上看的是哪版结论”时直接取对应冻结版本。

### 修订与分发

候选修订逐点对照已发版本，差异分为三类：

| 判定 | 条件 | 去向 |
| --- | --- | --- |
| `correction` 实质更正 | 数值绝对变化严格超过 `materiality`；状态变化（含 estimated → unavailable）；指标点增删 | 新版本留档并只向覆盖变更点的订阅分发，消息携带原因与变更键 |
| `minor-revision` 小修 | 有变化但未触发更正条件（含仅解释片段变化） | 新版本留档，不分发、不覆盖旧签发 |
| `unchanged` | 材料哈希与已发版本相同 | 跳过，返回已发版本 |

### 投递、幂等与对账

投递器是项目内文件投递器（`src/deliverer.js`），把邮件写成 `state/mail/<订阅>/<幂等键>.json`，不接真实邮箱。幂等键由版本 id 与订阅 id 哈希得到，绑定“版本 × 订阅”；同一键重复入队不会产生第二条消息，重投覆盖同一路径。

持久状态全部落在 `--state` 目录，不依赖内存去重：

- `ledger.json`：冻结版本链、每笔投递状态与事件流，临时文件 + 原子替换写入；
- `outbox/`：待发/已发消息，内嵌完整冻结快照；
- `mail/`：文件投递器落地的邮件；
- `lock`：进程间互斥锁，保证同一状态目录串行修改。

`reconcile` 双向对账：outbox 有记录而 ledger 缺登记则补登记；ledger 是 pending 而 outbox 丢失则按冻结版本重建；邮件文件已存在但回执缺失（回执写盘前崩溃）则幂等重放并收敛。订阅间失败互相隔离，单个订阅持续失败不影响其他订阅。

### 时区与夏令时

按订阅 `zone` 的本地 `localTime` 调度，注入 `FixedClock` 即可快速演练。夏令时歧义采用确定策略并写入投递记录：

- gap（春季跳变，本地时刻不存在）：`shift-forward`，取渲染出该墙钟时间的最早有效瞬间；
- overlap（秋季回退，本地时刻重复）：默认 `earlier` 取第一次出现（较大偏移），订阅可配置 `overlap: "later"`；
- 无夏令时时区始终为 `normal`。

## 容器

```sh
docker build -t analysis-bulletin:local .
docker run --rm --network none analysis-bulletin:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算。
- `src/issuance.js`：材料冻结（截点/口径/产物哈希/解释/指标点）与候选修订分类。
- `src/schedule.js`：订阅本地时刻调度与夏令时 gap/overlap 确定解析。
- `src/policy.js`：业务配置校验与订阅覆盖判断。
- `src/deliverer.js`：项目内文件投递器与故障注入钩子。
- `src/store.js`：ledger、outbox、邮件目录与互斥锁的持久化。
- `src/publisher.js`：发布、到期派发与 reconcile 对账。
- `src/clock.js`：系统时钟与可注入固定时钟。
- `src/cli.js`：summary / inspect / publish / reconcile / trace 入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `scripts/demo-publish.js`：发布链路综合演练。
- `test/`：输入约束、领域核对、调度、签发、发布恢复、命令与输出回归。
- `data/`：合成记录、独立核对值及本地业务配置。
