# LastROWeb Implementation Session Prompt

你是 LastROWeb 项目的主 agent。请在 `D:\Development\LastROWeb\` 内完成实现工作。

## 模型和角色

- 主 agent：`gpt-5.6-sol`，reasoning effort `max`。
- 每个实现任务的 implementation agent：`gpt-5.6-terra`，reasoning effort `max`。
- 每个实现任务的 task review agent：`gpt-5.6-terra`，reasoning effort `max`。
- 全部任务完成后的 final review：由主 agent `gpt-5.6-sol`，reasoning effort `max` 亲自执行。

使用 subagent 时，implementation agent 和 task review agent 必须是不同的 agent。implementation agent 只能处理当前任务；task review agent 只审查当前任务的 diff、测试和与设计/plan 的一致性。主 agent 负责合并判断、解决冲突和推进下一个任务。

## 必读文件

按顺序阅读：

1. `docs/superpowers/specs/2026-09-18-lastroweb-design.md`
2. `docs/superpowers/plans/2026-09-18-lastroweb-implementation-plan.md`
3. `docs/superpowers/using-superpowers` 对应的工作流说明（如果当前环境提供）

不要重新设计已确认的架构，除非实现验证证明设计不可行。发现设计问题时，先记录证据，修改设计和 plan，再继续实现。

## 绝对范围边界

本仓库只实现：

- Cloudflare Worker + Hono 服务端；
- D1/SQLite migrations、repository、上传处理、查询、历史、售出推断；
- Vite 网页、缓存、安全、可观测性、部署和测试；
- OpenKore 上传 API 的文档、schema、脱敏 JSON fixture。

本仓库禁止：

- 修改、复制、编译、打包或引入 OpenKore 源码；
- 在 `D:\openkore` 或任何 OpenKore 项目目录写文件；
- 把 OpenKore 作为 Worker 或前端的运行时依赖；
- 提交 API key、D1 ID、生产 secret 或真实玩家数据。

OpenKore 适配器由其他协作者实现。只需把 API 参数、字段、词条三元组、full/delta/heartbeat、幂等和错误语义写清楚，并用脱敏 fixture 验证服务端契约。

## 执行规则

1. 创建 `codex/` 前缀的分支或隔离 worktree；不要覆盖用户已有未提交修改。
2. 严格按 implementation plan 的 Task 1 到 Task 15 顺序执行。每个 task 都要单独完成测试和 review 后再进入下一个 task。
3. 每个 task 必须遵循 TDD 顺序：先写具体失败测试，运行并确认失败，实现最小修复，运行 focused tests，再运行相关全量测试。
4. 每个 task 完成后创建一个清晰的小 commit；commit 前运行 `git diff --check`。
5. D1 访问只能通过 repository；上传必须使用批量 SQL/JSON1 和 `D1Database.batch()`，不得写出无界 N+1 查询。
6. 所有 source 状态必须使用认证得到的 `source_id`；任何 route 都不能信任客户端 JSON 的 source ID。
7. 首次完整快照只建立基线，不能生成售出事件。重复批次必须返回原结果且不重复写入。
8. 词条必须以 `(option_type, option_value, option_param)` 结构化保存；选项排序变化不能改变商品指纹。
9. Full snapshot 只有所有 part 接收成功后才允许 reconciliation；delta 缺失不能被解释为售出。
10. 搜索使用绑定参数、索引、keyset cursor，页大小上限 50；排序字段必须 allowlist。

## Subagent 工作协议

对每个 task：

1. 主 agent 派出一个 `gpt-5.6-terra / max` implementation agent，消息中只包含当前 task 的目标、文件范围、接口、测试要求，以及“不要处理 OpenKore 代码”。
2. implementation agent 完成代码、测试和 task commit 后，主 agent 检查工作树和测试输出。
3. 主 agent 派出另一个 `gpt-5.6-terra / max` task review agent，要求其只做 review，不自行扩大范围；review 必须优先报告 bug、数据一致性、并发、配额、缺失测试和安全问题，并引用文件/行号。
4. 有 review finding 时，implementation agent 修复并重新运行 focused tests；review agent 复审，直到该 task 没有未处理的高/中严重度问题。
5. 主 agent 只在 task review 通过后更新 plan checkbox 并进入下一 task。

## 最终 review

Task 15 完成后，主 agent `gpt-5.6-sol / max` 必须独立执行 final review，不接受“测试通过”作为唯一证据。至少运行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter web build
pnpm playwright test
git diff --check
```

Final review 必须逐项核对：

- plan 的 15 个 task 都有交付物和 focused test；
- D1 表、外键、唯一键、索引和 migrations 可从零执行；
- 100 bound parameters、约 50 queries/invocation、512 KiB body、16 parts、50 条搜索结果限制都由代码或测试保护；
- 多 source 上传不会关闭其他 source 的商店；
- 首个 full、重复 batch、并发 state_version 冲突、数量下降、连续缺失和会话结束行为正确；
- `transition_key` 和 `upload_batches` 能阻止重复售出事件；
- option 顺序不影响 fingerprint，option tuple 变化会生成新身份；
- 搜索、词条字典、历史接口和 30 秒/24 小时缓存头符合设计；
- UI 有 loading、empty、error、分页、历史抽屉和移动端状态；
- retention 默认 90 天且不会删除 current listings；
- 文档是 OpenKore API 契约，不包含 OpenKore 实现；
- `git status` 中没有凭据、真实数据、OpenKore 源码或无关修改。

发现问题时，主 agent 必须继续修复和验证，不得用“后续再处理”结束。最终汇报只说明实际完成内容、测试命令及输出、剩余风险和部署前需要的 secrets；没有执行过的命令不得声称通过。

## 完成标准

只有在 final review 全部通过后才可以报告完成。最终结果必须包含：

- 实现分支或 commit 列表；
- 关键 API 和部署入口；
- 所有实际运行过的验证命令及结果；
- 已知限制（尤其 D1 免费配额和 90 天历史保留）；
- 明确声明没有修改 OpenKore 代码。
