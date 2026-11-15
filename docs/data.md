# 数据与现有口径

value 是已完成分析的指标点，status 为 estimated/unavailable，definition 是口径指纹。

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。`id` 是导入记录键，不自动代表企业、访问或其他统计单位；记录键不得重复。数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于字段约定允许的未公开标签，不用零冒充缺测。

| 字段 | 类型 |
| --- | --- |
| `id` | `string` |
| `metric` | `string` |
| `country` | `string` |
| `period` | `string` |
| `value` | `number` |
| `cutoff` | `integer` |
| `definition` | `string` |
| `status` | `string` |

现有 `summary` 按 `metric` 清点记录，`sum` 为 `value` 的逐行核对值，不代表统计推断或跨期业务指标。分组按键排序，行按记录键稳定处理。`data/expected-summary.json` 是独立生成的现有核算对照；`data/policy.json` 保存业务配置的演练值，当前清点命令不消费分析配置。

`inspect` 返回输入行数、字段列表与 SHA-256 指纹；指纹不依赖字段或记录排列。数据版本不支持时应直接拒绝，不做静默迁移。错误发生时命令返回非零退出码。

## 业务配置与发布状态

`data/policy.json` 的 `materiality` 是实质更正阈值（非负数），指标点数值绝对变化严格超过它才分发更正。`subscriptions` 是收件组：`id` 唯一，`zone` 必须是可识别的 IANA 时区，`localTime` 为 `HH:MM` 本地时刻，`countries` 为非空且不重复的国家列表；可选 `metrics` 限定指标，省略即全部指标；可选 `overlap` 为 `earlier`（默认）或 `later`，决定秋季夏令时重叠时刻取哪一次出现。`artifacts` 列出分析产物，`id` 唯一，`explanation` 是随材料一起冻结的中文解释片段。

发布状态目录（CLI 的 `--state`，默认 `var/publish`）布局：

| 路径 | 内容 |
| --- | --- |
| `ledger.json` | 版本号为 1 的冻结版本链、投递登记与事件流；原子写入，版本不符直接拒绝 |
| `outbox/<幂等键>.json` | 待发或已发消息，内嵌完整冻结快照；幂等键为版本 id 与订阅 id 的 SHA-256 |
| `mail/<订阅 id>/<幂等键>.json` | 文件投递器落地的邮件，同键重投覆盖同一路径 |
| `lock` | 进程间互斥锁，发布与对账期间占用，结束后释放 |

夏令时解析结果随投递登记持久化：`normal` 表示无歧义，`gap` 配合 `shift-forward` 策略前移到跳变后最早有效瞬间，`ambiguous` 配合 `earlier`/`later` 记录所选偏移，`alternatives` 保留重叠时刻的全部候选瞬间。

