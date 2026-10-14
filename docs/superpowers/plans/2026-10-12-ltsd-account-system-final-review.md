# LTSD 账号系统最终独立审查记录

最终本地结论：整分支初审的I1/M1/M2已由Luna修复，fresh限定复审Spec PASS / Quality APPROVE；生产条件仍UNVERIFIED。下方保留两次独立报告原文，初审FAIL不是最终未解决状态。管理人仅归档报告，没有改写reviewer结论。

# LTSD 账号系统最终整分支独立审查

Spec Compliance：**FAIL**。Quality：**REQUEST CHANGES**。

发现 **1 项 Important/P2、2 项 Minor/P3，无 Critical**。Important 是规格明确要求的单用户停用/恢复维护说明缺失，涉及恢复后旧会话/动作是否复活；最小修复是补安全维护文档，不需要新管理员门户、API、schema 或重做账号架构。其他已实现本地账号主流程、授权、并发和资源边界未发现新的阻断问题。真实 Workers Free 预算、邮件与远端配置仍未验，本报告不批准生产上线。

## 范围与方法

- fresh `gpt-6.1-sol/high`，共用 checkout；按 dispatch 的 `feat/ltsd-account-system` / HEAD `6768f868fbaae4c87328492ed39c792c033722b1` 审查，Task15 源码/报告冻结且未提交。
- 唯一审查包为 manager 提供的 `final-review.diff`，base `8a2155fcdd84d30193070c1bbca0defeeb28fbd7` 到当前 working tree，包含四个 Task15 新文件；完整连续分块读至包尾，对工具截断片段补读。没有重算全分支 diff、逐任务重做 review。
- 完整读取最终 instructions、全局 AGENTS/RTK、根 `agent.md`、README、Spec、已审 plan/plan-review、progress ledger、34 rulings、validation、Task15 brief/context/spec/report/controller-notes；具名读取 Task13/14 fix1 独立报告、snapshot rename map 和最终 benchmark 原始 JSON/全门禁日志摘要。
- 对 session/action/mail quota 和维护撤销风险先用 CodeGraph，随后仅补它未展示的源码/文档 gap；补核对原 MySQL transaction 实际 `await commit`、rollback/release 和 Worker fetch 的 invocation 生命周期。
- 这是整个系统的模块交互审查，不只审 Task15。历史限定 PASS 作为有界继承证据，与当前完整源码和最终运行日志交叉核对。
- 本轮没有运行 DB/test/full gates、浏览器、Wrangler、远端 workflow/Secrets/DNS、邮件或 Obsidian，也没有修改源码/docs/Git/branch/worktree。唯一写入为本报告。测试数与退出码明确为已有执行证据，不冒称本 reviewer 重跑。
- 当前用户 MySQL/feature branch/no-worktree/local-only 约束覆盖根文档历史 D1/catalog-main 规则；Spec/plan 的早期 UTF-16 与内部接口最小同步有 ledger 理由，不声称原文逐字未变。Task0 的 README 原四链接及原 plan-review 是保存输入，不误判为未经设计的新增。

## Findings

### I1 / Important / P2：缺少受控单用户停用及恢复说明，撤销语义未闭合

**位置：** `docs/operations.md:13` 的账号维护章节（至 `:36`）；需求在 `docs/superpowers/specs/2026-10-12-ltsd-account-system-design.md:165`，审计要求在该 Spec 的 §10。相关当前源码为 `apps/worker/src/auth/repository.ts:331–343`、`apps/worker/src/auth/action-service.ts:98–106`，真实停用 fixture 为 `tests/integration/auth-account-races.test.ts:527–534`。

**触发：** 维护人员需要按 Spec 停用某个账号，之后恢复该账号。分支没有单用户维护入口，也没有规定必须执行的受控事务；operations 只说明全站 `AUTH_ENABLED=false`。目前运行证据只覆盖测试里 `DISABLED` 与 `auth_version++` 同事务的停用，不提供恢复流程。

**影响及源码依据：** 普通鉴权只检查最新 `status` 和会话版本。如果维护只把 `status` 改成 `DISABLED`，再恢复为 `ACTIVE/PENDING_EMAIL`，仍未到期、未撤销且版本不变的旧 Cookie 会重新满足 `readIdentity`。即使只增加 `auth_version`，旧 RESET/VERIFY 动作仍只比较 `credential_version`、expiry 和 revoked/consumed 标记，恢复状态后可能再次有效。现有 API 的改密/退出流程正确；这里不是声称存在公开可绕过 API，而是 Spec 明确要求的安全维护交付尚缺，不能把它归为远端测量条件。

**最小修复：** 在维护说明增加仅经单独授权、按一个明确字符串用户 ID 操作的安全步骤/事务约定：先锁 `auth_users` 主键；同事务写 `DISABLED`、单调递增 `auth_version`、撤销该用户原有有效 VERIFY/RESET 动作，并写脱敏持久 security event；不删除用户/credential，不等待外部邮件。恢复时同样锁用户，由原有 `email_verified_at` 决定 `ACTIVE` 或 `PENDING_EMAIL`，不自动验证邮箱、不改密码材料；保留/推进撤销版本，绝不减回版本、清掉旧 revoked/consumed 标记或复活旧任务，并记录恢复 audit。恢复后要求新登录、新动作。说明全站维护开关与单用户停用的区别；不需要新 admin portal/API 或生产 SQL 执行。文档应使“旧 Cookie 和旧动作恢复后仍无效”成为明确操作结果，而不依赖操作者猜测。

### M1 / Minor / P3：README 的账号运维锚点不存在

**位置：** `README.md:38`、`:79`。

两处新链接指向 `docs/operations.md#account-auth-and-cleanup`，实际标题 `docs/operations.md:13` 是 `Account mail and cleanup`，生成锚点为 `#account-mail-and-cleanup`。点击能打开文件，但不会跳到账号说明。最小修复两处锚点即可。此项可以明确 defer，风险仅是交付导航；不要求新增文案镜像测试。

### M2 / Minor / P3：Ruling21 摘要把 JSDOM/source 证据升级为 browser

**位置：** `docs/superpowers/plans/2026-10-12-ltsd-account-system-validation.md:155`。

Ruling21 写 `independent source/browser verification`，原 Task11 ledger/review 描述的是源码＋JSDOM/内存 probe 的同页退出→内联登录→主动确认，明确不是实际浏览器证据。后来的 Chrome 记录不能替代该裁决当时的具体来源。最小修复为 `source/JSDOM probe`（或等价精确表述），保留排除疑点的结论。可明确 defer；风险为证据范围表述，不影响当前授权行为。

## 逐模块审查结果

| 模块 | 审查范围与判断 |
|---|---|
| 输入与配置 | 邮箱规范化贯穿 register/login/reset/rate；白名单与长度有界。合法密码 5–256 Unicode code point、不 trim/截断/复杂度/历史/新旧不同要求；孤立 surrogate 拒绝有编码碰撞依据。core Secrets 严格 canonical 32-byte Base64、独立材料、current/最多一个 previous 版本选择；缺配置 fail closed，Resend 缺项只影响投递。PASS。 |
| crypto 与 token | 原生 HMAC 固定用途前缀＋16-byte 随机 salt＋原密码 UTF-8；原生 verify。32-byte 随机会话/动作仅存 SHA-256 摘要；AES-GCM 随机 12-byte IV、AAD 绑定 mail ID/purpose，按存储版本解密，不猜 current。无客户端密码摘要或 Worker 图片 codec。PASS。 |
| schema / repository | 009 纯新增 8 表，旧迁移不变；自然首 ID10000，所有 auth ID 显式 CAST 字符串，不依赖 Number insertId。事务绑定同一连接、AuthTx 不暴露嵌套 transaction；用户→session/action→outbox→audit 阶段及 owner 绑定；显式字段、参数 SQL、头像独立读取。MySQL8.4.5 真迁移/唯一/rollback/大 ID 有证据。PASS。 |
| 注册与本人资料 | 注册 user/credential/action/optional avatar/outbox/audit 原子；只有 insertUser 的唯一冲突转通用202，不吞 outbox/audit 故障。profile/avatar 只取会话本人、锁后重验状态/版本/expiry；PENDING 可编辑，禁用不能写；头像版本与动作审计同事务。PASS。 |
| session / 撤销 | 新登录随机 token；快照 HMAC 在锁外，锁内再核版本。30天 Cookie/DB rolling、同 token refresh、GREATEST 不缩短、过期/撤销/版本优先，last_seen 最多每日一次。普通401无清 Cookie头；logout/logout-all/成功改密规定清理。MySQL 当前身份，无 KV/global auth cache；真实撤销先 commit 后旧 refresh 锁的401证据有效。API PASS；单用户维护说明为 I1。 |
| 一次性动作与恢复 | VERIFY 要同用户有效 session，GET 不消费，锁后用途/Email/版本/expiry/消费与撤销校验，成功轮换当前 Cookie并撤销同用户 VERIFY。RESET 不自动登录/验证、不恢复DISABLED、不允许对象选择；同/不同RESET及原快照改密竞争唯一赢家。wrong-current 无改动、same-password 可改已由真实 SQL补证。PASS。 |
| CSRF / rate / CORS / body | 固定 anonymous/session 两种 mode，不凭登录 Cookie切换；可信 Origin与用途/session绑定；匿名 invalid-CSRF仅副作用前可重试一次，session写不重放。流累计8/64KiB并 cancel，不信 Content-Length。多实例 MySQL计数/60秒跨小时共享冷却独立提交、排序锁与 clamp；无内存 fallback。账号无 wildcard/credentials CORS，公开原契约保留。PASS。 |
| 邮件 outbox / quota | intent 可靠入库，首次发送前 lease+attempt0 CAS冻结完整 body；stable ID/key/body，短锁释放后HTTP。发送前原子 attempt/budget/firstAt预留，最多4次及24h窗口，crash不返还。daily/monthly/rate分类正确；recordProviderQuota用 reservedAt原UTC bucket，即使旧lease CAS失败仍记原周期，不暂停新周期；quota终结密文，pendinglogin/202/主动次日重发一致。PASS。 |
| Cron / cleanup / 生命周期 | 独立 `*/2` event，default关闭不建pool；ready mail优先，claimed/cleaned/idle避免同tick发信加清理；每tick一封或一类≤50，无drain，八slot TTL/FK有真库证据。HTTP/Cron数据库 finally close，不在关闭后 waitUntil发信；public资产/market未额外鉴权，旧upload Bearer/admin/game credentials隔离。PASS。 |
| Web 状态与页面 | 单例API/store bootstrap/refresh合并，generation/revision/dirty挡迟到身份；跨标签仅无秘密通知，清昵称/显示态密码/头像draft；不自动重放本人写。七路径与`/accounts`隔离；token先闭包后清URL，auth页无analytics/Storage，内联登录后主动confirm；可见主动申请后最多3×120s，不续期/重发。PASS。 |
| 浏览器头像 | 本机JPEG/PNG/WebP正方形裁剪、方向、pointer/range/keyboard、固定256与五档有界编码，PNG fallback拒绝，资源释放。busy期间冻结编辑器，身份epoch仍优先；失败保留旧图与draft。服务端正规Base64/32KiB/64chunk/VP8/VP8L/VP8X/动画与尺寸边界。Chrome合成三源与VP8L派生产物有本地往返证据，非Worker完整远端codec/CPU。PASS。 |
| CI / 部署 / key映射 | REQUIRE job MySQL8.4.5/三guard/串行完整两file，deploy needs两job且main-only。启用需preflight完整配置；账号Secret前成功false发布屏障，put继承关闭，最终完整current/previous/public mapping恢复；中途停止无空secret覆盖。最终deploy失败/含糊不推断线上状态的两doc已修。静态PASS；未执行remote GHA/部署。 |
| Task15 bench / evidence | 完整default.fetch/scheduled、每调用newpool/close、synthetic数据/fakeprovider；formatter allowlist不输出秘密，CLI拒绝生产URL/无guard。14场景18invocations原JSON与validation表一致、remoteCPU全null且UNVERIFIED；cold是已启动Vitest首dynamicimport+login，不称coldisolate；small N/Node/Vite/TLS边界明示。PASS，M1/M2需收口。 |

## Spec 能力与证据边界

AUTH-01–11 均有实现及责任模块；AC-01–29 在 validation 有逐项来源，本轮已与源码/流程核对。当前 Spec FAIL 只因 I1 的维护要求未交付，不因没有远端 CPU 或真实邮件而否定本地功能。

- AC01–06、08–18、20–26、29 的关键主流程/授权/撤销/一次性/幂等额度与头像边界有单元、真实MySQL或本地浏览器的适当证据；未要求每AC独立新case。
- AC07 同版本两个 VERIFY 乱序未动态测试；源码 user锁、validAction、markACTIVE/revokeActions与重复确认及重发证据支持现语义，继续准确保留该动态缺口，不伪GREEN、不新增机械测试矩阵。
- AC27 日quota→PENDING登录→UTC新周期→主动重发→验证真库流程有效；月UI为Web/source/Task11证据，不当作动态Chrome月测试。Provider分类与UI来源不同，未混用。
- AC19/22 为 Chrome155、desktop/mobile viewport与键盘/指针，非实体手机、真实passwordmanager或全浏览器组合。Task12/14 Hono/MySQL bridge非完整remote Worker；Task15完整本地default入口也非Cloudflare CPU。
- AC28 的生产Free预算仍 **UNVERIFIED**。这是上线门禁，不是本地API漏洞的挂起理由，也不把Node超过10ms断言为真实Free超标。

## 34项管理人裁决核对

逐项对照progress原顺序及validation摘要，未发现未经裁决的密码/架构/权限变更。Ruling21证据来源摘要有M2；其功能排除结论本身不推翻。

| # | 当前落实与成本/边界 |
|---:|---|
| 1 | MySQL feature分支覆盖历史D1/main；避免误部署/架构返工，符合当前授权。 |
| 2 | 已审计划/单Luna实施/管理人提交/no-worktree/no模型升级/noObsidian；本review只读不派代理。 |
| 3 | exFAT环境参数处理pnpm executable，未改lock/CI；本地环境成本保留。 |
| 4 | AES-GCM helpers闭合previous解密；AAD/IV/8KiB固定，内部helper扩展成本而无公开变更。 |
| 5 | malformed surrogate编码拒绝，合法Unicode规则不削弱；碰撞回归与最小Spec同步有理由。 |
| 6 | optional共享mail budgets与全站zero digest，个人HMAC分开；rate秘密轮换不重置整站额度。 |
| 7 | sessionToken只在请求内携带以重发原Cookie，Repo/wire只摘要；无持久原token。 |
| 8 | rate/cooldown SQL归Repository；内部任务归属调整，不散落服务SQL。 |
| 9 | CSRF optional clock兼容，runtime.now准确注入；wire不变。 |
| 10 | LiveAuthIdentity一次JOIN含expiry；me无需第二次session读取/头像。 |
| 11 | 无有效会话logout仍强制可信Origin，幂等不授予授权。 |
| 12 | intent→首次body冻结，lease/attempt0 CAS；missing delivery暂停，重试body/key稳定。 |
| 13 | mailDelivery shape和exactexpiry明确；缺sender/key保留登录，未虚构sender。 |
| 14 | 跨UTC锁等待可留旧bucket零值并release，无次数/预算/HTTP，只有可清理零行成本。 |
| 15 | 注册draft userId null，真实自增后同事务绑定；无预测0/MAX+1。 |
| 16 | confirmReset changedUserId内部，router仅清同用户Cookie；匿名RESET不授予身份。 |
| 17 | profile/avatar optional requestId与有界v，旧调用兼容/仍取当前图。 |
| 18 | 旧staging/production全局校验保留，精确账号命名空间稳定错误，预算只可降低默认值。 |
| 19 | reconcile invalidate＋dirty最新查询，失败无自动retry/replay/回广播；跨标签顺序成本有界。 |
| 20 | profile后一次Store.reconcile同步导航；是有意读，不伪零SQL。 |
| 21 | 同页错账号重登疑点由既有nav消除，无重复按钮；原source/JSDOM证据需M2更正。 |
| 22 | UID＋epoch守本人迟到回调，密码用稳定语义标记清；同UID新session不误清新状态。 |
| 23 | 主动受理才poll，身份/隐藏/quota/离页停，累计最多3不reset；无自动重发/续期。 |
| 24 | 本地14SPA头生效，未增加Worker-first或公开cache变更；远端效果未验。 |
| 25 | same-token guard确实存在，旧refresh吞401疑点排除；内存probe非browser/SQL。 |
| 26 | bundled浏览器/独立临时profile正常localhost；无用户profile/新依赖/受阻data绕过。 |
| 27 | 现有Sharp派生VP8L，Chrome解码/Worker检查补正向；非Canvas直接VP8L，非Worker codec。 |
| 28 | 默认fetch receiver绑定，注入兼容；无CSRF/授权改变。 |
| 29 | Cron专用claim结果区分，ready不饥饿且一工作类别；兼容旧claim，cleanup≤50。 |
| 30 | explicit opt-in＋complete preflight，defaultfalse/非空stdin；只是local workflow配置，未远端run。 |
| 31 | account Secret前false屏障，final完整mapping；维护窗口成本明确，最终命令含糊须核对remote。 |
| 32 | 注册race是service层两accepted，HTTP共享cooldown可429；未削弱限流为迎合两202。 |
| 33 | AC11真库wrong-current/samepwd/原快照change补证，AC07/27缺口准确；未扩每项case矩阵。 |
| 34 | 14管理人归档更名.snapshot且rename map保留，原字节/真实tests/Vitestconfig不变；历史路径需map定位。 |

## 历史 findings / deferred 收口

- Tasks1–12已修 Important 与相关Minor在当前完整代码仍落实：surrogate、digest owner/phase、error requestID/clock、session audit、领取饥饿、不能重发job复用/metadata投影、头像格式与VP8头/初始audit、reconcile dirty、503手动retry、头像freeze/展示用途。没有发现后续回退。
- Task8 VP8L正向缺口由Task12真实encoder派生＋浏览器解码＋Hono/MySQL PUTGET补证；不冒称Canvas直接VP8L。
- Task13唯一明确deferred文案在 `docs/deployment.md:81` / `docs/operations.md:17` 已 **ADDRESSED**：成功barrier后secretput失败停止无恢复，最终完整deploy失败/含糊可能已生效，须核对而不只看exitcode。
- Task14 I1/I2/M1与AC11/RESET fixture/early abort均 **ADDRESSED**；注册赢家绑定真实commit actor，撤销/停用commit先于旧refresh锁且401，错误当前/相同新密码/双change唯一成功都在完整两fileREQUIRE证据内。旧9pass1timeout没有阶段trace，根因是源码/夹具推导，不是旧日志证明某winner。
- Ruling34 snapshot rename不删除历史内容或屏蔽功能tests；ordinary修复后仍明确6file/19test skip，真库与bench另验。
- 既有catalog chunk warning和三ignored .generated lint错误保持范围外；不顺手重构或删除用户产物。physicalphone/passwordmanager、AC07/27动态边界与外部生产条件不静默省略。
- 新M1/M2若defer应由manager明确登记风险；I1不能defer为生产外部条件或自称已满足。

## 最终已有验证证据

读取实际日志摘要及dispatch捕获的直接退出码；空stdout不被单独当作exit0证明。本review未再次执行这些命令。

| 验证 | 实际结果与范围 |
|---|---|
| ordinary suite | exit0，93filespass/6filesskip；552testspass/19skip。 |
| auth完整REQUIRE | exit0，2files/10testspass/0skip，178.26s；MySQL8.4.5、9迁移、专用_test与串行guards。 |
| local full-entry bench | exit0，1testpass/0skip；14scenarios/18invocations，16HTTP＋2scheduled，fakeprovider。 |
| formatter | 早期direct exit0、1pass0skip；后期TAP同结果但zsh status变量wrapperexit1，未伪报wrapper通过。 |
| source lint / type | 直接捕获exit0；source lint仅命令排除.generated/.superpowers，未改repo配置。 |
| migration / docs / webbuild | exit0；5pass0skip / 58assertions / buildpass，既有catalog chunkwarning。 |
| diff whitespace | manager直接exit0，无diagnostics。 |
| full lint | **FAIL / exit1**，366errors/0warnings，3个既有ignored generated index.js各122；未删除或修产物伪GREEN。 |

19skip拆分：authflow8＋races2＋bench1共11由另外完整REQUIRE及bench覆盖；既有市场 `mysql-upload-collation`6、`mysql-upload-session`1、`catalog-upload-search-flow`1共8真MySQL本轮未跑。不能声称全部旧SQL通过。Task0历史lint单路径记录缺原log，不能用当前三路径反推当时分布；validation已明示。

原bench JSON来源、runtime24.21.0、MySQL8.4.5、HEAD build SHA、样本数与表一致。首次import+login NodeCPU84.562ms、resetconfirm13.172ms、32KiBavatar12.631ms、hotlogin5sample max8.523ms只是本地风险信号；其他多为1sample，p99不统计稳定。Node processCPU可能含Vite/loader、exclude MySQL serverCPU、localTLS未确认、Node/Vitest启动不在cold段、ColdCloudflareisolate未确认，所有remote_cpu_ms=null、production budget UNVERIFIED。头像401旧session夹具仅调整测量顺序，无产品授权弱化。

## 生产条件（不作为I1的延期理由）

需要未来用户单独授权并实际验证：Cloudflare Free完整HTTP/Cron invocationCPU（init/crypto/driver/TLS/open-close/jobs），完整冷/热样本及采样/确证cold说明、p99≤5ms/observedmax≤8ms且无10ms/resourceerror；真实Secret注入/传播/完整currentpreviousmapping、可信站点；发信域名控制/DNS/SPF/DKIM/DMARC与Resend账户真实额度/可控测试邮箱投递；Cron跨Worker共享账户总额度；远端GHA REQUIRE job；生产MySQL备份/迁移/恢复。5% invocationlog采样不能证明全人口max，localwall/NodeCPU/mock均不能代替。

账号默认关闭继续保留。整个分支修复I1并复审后可判断本地交付；这仍不等于上线验收。当前唯一阻断为I1，建议在同一最小docs修复中收口M1/M2，然后一次限定复审；无源码变更/新具体失败时不机械重跑DB、浏览器或整套门禁。


---

# LTSD 账号系统最终 fixwave 限定独立复审

限定 Spec Compliance：**PASS**。限定 Quality：**APPROVE**。

原 I1 Important/P2、M1/M2 Minor/P3 均 **ADDRESSED**。本次文档修复未发现新增 Critical/Important。该结论关闭原整分支审查的三个文档 findings，其他源码审查结论和已有验证边界有界继承；不表示生产就绪，也不把维护 SQL 模板视作实测。

## 范围与方法

- fresh `gpt-6.1-sol/high`，共用 `feat/ltsd-account-system` checkout；按管理人给定 HEAD `6768f868fbaae4c87328492ed39c792c033722b1`、Task15 未提交状态审查。没有重新计算 Git diff 或重审原 18431 行整分支包。
- 完整读取 `final-fix-review-instructions.md`、原 `final-review-report.md`、`final-fix-report.md` 和管理人提供的 195 行 `final-fix-review.diff`；完整读取 Task15 brief/context/spec、最新 README/operations/validation/task15 report、Spec §6/§10、全局 AGENTS/RTK、根 `agent.md` 和相关任务约束。相关路径没有更近的 AGENTS/AGENTS.override 规则。
- 先用 CodeGraph 定位 auth schema/session/action/audit；009 SQL 未被索引、repository 的具体查询与锁阶段未完整展示，随后仅补读这些 gap。对照 `009_account_system.sql`、`readIdentity`、`validAction`、`createAuthTx` 的用户→session/action→outbox→audit 阶段，核对维护模板。
- M2 同时核对原 Task11 review 的具体 source/JSDOM probe 和管理人 Ruling21；不重新运行 probe、浏览器或测试矩阵。
- 限定检查 I1、M1、M2 以及此次 fix 新增的 Critical/Important。没有派子代理，没有修改 product/source/tests/docs/Git/branch/worktree，没有 DB、维护 SQL（包括测试库）、邮件、remote、浏览器或 Obsidian 操作。唯一写入是本报告。

## Findings 裁决

| Finding | 裁决 | 当前证据 |
| --- | --- | --- |
| I1 / Important / P2：受控单用户停用及恢复说明缺失 | **ADDRESSED** | `docs/operations.md:38–108` 补全受控事务模板及恢复后旧会话/动作保持无效的约定，符合 Spec §6/§10。 |
| M1 / Minor / P3：README 两处运维锚点不存在 | **ADDRESSED** | `README.md:38`、`:79` 均为 `#account-mail-and-cleanup`，对应 `docs/operations.md:13` 的真实 `Account mail and cleanup` 标题。 |
| M2 / Minor / P3：Ruling21 证据来源被升级为 browser | **ADDRESSED** | validation `:157` 写明 source review + JSDOM/in-memory probe，并把 Task12 后续 Chrome 单列；与 Task11 初审 `:39–43` 及原 Ruling21 一致。 |

### I1 的安全闭合依据

1. 维护仅在可信操作者对明确账号与操作获得单独授权后执行。一个规范非零十进制字符串 ID，限制在 `BIGINT UNSIGNED`，主键查询 `CAST(id AS CHAR)`，用户 ID 参数绑定且禁止拼接。授权/操作者留在受保护变更系统，数据库仅存 ≤64 ASCII 字符的不透明 `request_id` 引用；显式选列，不读取邮箱、凭据、头像、token 或 mail ciphertext。
2. 同一连接、同一事务先锁用户主键，锁后取一个 UTC Unix-ms 时间。缺用户、错误/未知状态、用户更新或 audit 插入不是一行、任何语句失败都 rollback；已 DISABLED 的停用不改状态，不推测成功。无 outstanding action 时零行 action update 合法。模板后的参数说明明确区分用户 ID、时间和 audit reference。
3. 停用只接受 ACTIVE/PENDING_EMAIL，写 DISABLED 并递增 `auth_version`。当前 `readIdentity` 要求 session/user 的 `auth_version` 一致且用户未禁用；恢复再次递增且禁止降回版本，因此旧 Cookie 不因恢复状态重新有效，无需批量重写历史 session。
4. 两个模板均撤销所有该用户未消费且未撤销的 VERIFY_EMAIL/RESET_PASSWORD，不只撤销未过期部分。当前 `validAction` 要求 `consumedAt === null` 和 `revokedAt === null`；恢复不清旧标记，即使动作仍在有效期且 credential version 未变也不能复活。正在发送的旧邮件可能到达，但其中动作已撤销。
5. 恢复仅接受 DISABLED，由锁定行原 `email_verified_at` 的 NULL/非 NULL 决定 PENDING_EMAIL/ACTIVE，保留原验证时间与密码材料、`credential_version`。明确禁止解除历史 session/action 撤销或消费、重置失败 outbox，并要求新登录及正常流程的新动作。
6. `auth_users`、`auth_action_tokens`、`auth_security_events` 的名称、字段、枚举和可空性与 009 一致；`ACCOUNT_DISABLED`/`ACCOUNT_RESTORED`、SUCCESS、authorized_maintenance 均符合 audit 字段长度，事件和状态同事务提交。锁序为用户→actions→audit；不写 outbox、不持锁等待 HTTP。全局 `AUTH_ENABLED=false` 明确仅为全站暂停，不能替代单用户停用。

以上是当前文档与源码/schema 的静态核对。SQL 块是带执行前置条件和失败处理的维护模板，并非本轮执行过的维护脚本；未声称数据库操作或 rollback 路径得到新动态验证。按用户纯 docs 验收边界，无新 API、管理门户、schema 或测试矩阵要求。

## 文档验证证据与继承范围

| 执行方 / 来源 | 命令 | 记录结果 |
| --- | --- | --- |
| fixer 的 `final-fix-report.md`，与 `task-15-report.md` 的 fix 小节一致 | `rtk proxy env pnpm_config_prefer_symlinked_executables=false pnpm test:docs` | exit 0；58 assertions passed。 |
| fixer 的同两份报告 | `rtk proxy git diff --check` | exit 0；无 whitespace diagnostics。 |

上表是 fixer 实际执行记录，本 reviewer 没有重跑这些 checks。管理人补充确认 fixer turn 的工具 stdout 直接返回上述 count/exit，未另存专用 raw log；本 reviewer 依据 fixer 报告及该来源说明归因，不冒称亲自执行。既有 `scratch/task-15-gate-docs-ac-evidence.log` / `scratch/task-15-gate-diff-check.log` 属于原 Task15 门禁，不能冒充本次文档修复的新日志，也不把未来管理人收尾检查倒称历史证据。静态复审直接读取当前文档并核对锚点、schema 与鉴权条件，而非仅信 fixer 的 addressed 声明。

原整体审查除这三个 findings 未发现其他源码阻塞；34 rulings、ordinary 552 pass/19 skip、完整 auth REQUIRE 10 pass/0 skip、14 场景/18 invocation local bench、source lint/type/migration/docs/build 等原证据继续继承，未重跑。原 full lint exit 1（既有 generated 文件 366 errors）、formatter wrapper exit 1、旧 SQL suite skip、AC07/27 动态缺口等限制未被本次 docs fix 消除，也没有机械增加测试或 DB reset。

## 剩余生产条件

真实 Workers Free 完整 HTTP/Cron invocation CPU（含 init/crypto/driver/TLS/open-close/jobs）、确认的 cold-isolate、充分冷/热样本及采样范围仍未验证；`remote_cpu_ms` 仍为 null、`production_budget` 仍为 **UNVERIFIED**。10ms 完整调用限制及 p99≤5ms/observed max≤8ms 的待验目标继续保留；Node/Vite CPU、local wall time 或 5% logs 不能证明真实完整 CPU/全人口最大值。

Secrets 注入/传播及完整 current/previous 映射、可信站点、DNS/SPF/DKIM/DMARC/发信域名、Resend 真实账户额度与测试邮箱投递、Cron 配置及共享账户额度、remote GitHub Actions REQUIRE job、生产 MySQL 备份/迁移/恢复仍需未来单独授权和实际验证。账号默认关闭继续保留。本轮仅批准限定文档修复的本地交付，不批准生产上线。
