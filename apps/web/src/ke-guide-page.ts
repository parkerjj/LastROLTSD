// KoreEngine 新手指南页（/ke/guide）。
// 面向新手与菜农：先讲能力边界，再给四个高频配置的手把手路径与通用 FAQ。
// 页面里的“界面片段”全部用真实字段与真实数值绘制，不展示配置块源码。

import { siteNavMarkup, mountSiteNav } from "./nav";
import { injectLegalLinksIntoFooters } from "./footer-links";
import "./ke-guide.css";

export interface GuideRule {
  /** 行标识，也用于 DOM 高亮。 */
  readonly id: string;
  /** 写进规则表的名称或数字 ID。 */
  readonly pattern: string;
  /** 人类可读的说明。 */
  readonly label: string;
  readonly kind: "name" | "id" | "wildcard" | "all";
  /** 这一行为什么存在。 */
  readonly note: string;
}

export interface RuleMatch {
  readonly rule: GuideRule;
  readonly reason: string;
}

/** 演示用的规则账本：顺序即优先级（精确名 → 数字 ID → 通配符 → all）。 */
export const GUIDE_RULES: readonly GuideRule[] = [
  {
    id: "exact-red",
    pattern: "红色药水",
    label: "精确名",
    kind: "name",
    note: "名字完全一致时最先命中",
  },
  {
    id: "item-12622",
    pattern: "12622",
    label: "坐骑用缰绳",
    kind: "id",
    note: "精确名没写时，数字 ID 接着命中",
  },
  {
    id: "wild-red",
    pattern: "红*药",
    label: "红字头，药字尾",
    kind: "wildcard",
    note: "以「红」开头、以「药」结尾",
  },
  {
    id: "wild-color",
    pattern: "?色药水",
    label: "任意颜色药水",
    kind: "wildcard",
    note: "恰好一个字，再加「色药水」",
  },
  {
    id: "wild-card",
    pattern: "*卡片",
    label: "所有卡片",
    kind: "wildcard",
    note: "所有以「卡片」结尾的物品",
  },
  {
    id: "all",
    pattern: "all",
    label: "其它所有物品",
    kind: "all",
    note: "没有具体规则时，最后落到这一行",
  },
];

const WILDCARD_SPECIAL = /[.+^${}()|[\]\\]/gu;

function wildcardRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(WILDCARD_SPECIAL, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "iu");
}

/**
 * 按 OpenKore 规则表的查找顺序返回命中的规则：
 * 精确名 → 数字 ID → 通配符（列表顺序，靠前的优先）→ all 兜底。
 */
export function matchRule(
  input: string,
  rules: readonly GuideRule[] = GUIDE_RULES,
): RuleMatch | null {
  const value = input.trim();
  if (value === "") return null;
  const lower = value.toLowerCase();

  const exact = rules.find(
    (rule) => rule.kind === "name" && rule.pattern.toLowerCase() === lower,
  );
  if (exact) return { rule: exact, reason: "精确名优先" };

  if (/^\d+$/u.test(value)) {
    const byId = rules.find(
      (rule) => rule.kind === "id" && rule.pattern === value,
    );
    if (byId) return { rule: byId, reason: "数字 ID 命中" };
  }

  for (const rule of rules) {
    if (rule.kind !== "wildcard") continue;
    if (wildcardRegExp(rule.pattern).test(value)) {
      return { rule, reason: "通配符命中，取列表中靠前的一条" };
    }
  }

  const fallback = rules.find((rule) => rule.kind === "all");
  return fallback
    ? { rule: fallback, reason: "没有具体规则，落到 all 兜底" }
    : null;
}

const MAP_OPTIONS = [
  { value: "prt_fild08", label: "prt_fild08 南门" },
  { value: "pay_fild04", label: "pay_fild04 斐扬南" },
  { value: "mjolnir_12", label: "mjolnir_12 山脚" },
];

function heroPanelMarkup(): string {
  return `
    <div class="kg-term" data-ui role="group" aria-label="KoreEngine 面板示例">
      <div class="kg-term-bar">
        <span class="kg-term-dot" aria-hidden="true"></span>
        <strong>KoreEngine</strong>
        <span class="kg-term-mode" data-hero-mode>AUTO</span>
      </div>
      <div class="kg-term-id">
        <strong>智者</strong>
        <span>Lv 99/70 · 连接就绪</span>
      </div>
      <div class="kg-term-bars">
        <div class="kg-meter"><span>HP</span><span class="kg-meter-track"><i style="--w:80%"></i></span><b>1200/1500 80%</b></div>
        <div class="kg-meter"><span>SP</span><span class="kg-meter-track"><i style="--w:64%"></i></span><b>64/100 64%</b></div>
      </div>
      <dl class="kg-term-meta">
        <div><dt>模式</dt><dd data-hero-mode>自动</dd></div>
        <div><dt>任务</dt><dd data-hero-task>attack</dd></div>
        <div><dt>地图</dt><dd data-hero-map>prt_fild08</dd></div>
        <div><dt>目标</dt><dd data-hero-target>波利</dd></div>
      </dl>
      <div class="kg-term-actions">
        <button type="button" class="kg-term-button" data-hero-toggle>关闭自动</button>
        <span>清空队列</span>
        <span>经验统计</span>
        <span>经验报告</span>
      </div>
      <div class="kg-term-console" aria-live="polite">
        <p><span>[12:00:01]</span> 攻击 波利 120 伤害</p>
        <p><span>[12:00:02]</span> 使用技能 火箭术 Lv5</p>
        <p data-hero-log><span>[12:00:03]</span> 自动 · 喝药阈值 40%</p>
      </div>
    </div>`;
}

function heroChipsMarkup(): string {
  const maps = MAP_OPTIONS.map(
    (map) => `<option value="${map.value}">${map.label}</option>`,
  ).join("");
  return `
    <div class="kg-chip kg-chip--mode">
      <span class="kg-chip-label">模式</span>
      <div class="kg-seg" role="group" aria-label="AI 模式">
        <button type="button" class="is-on" data-hero-mode-set="auto" aria-pressed="true">自动</button>
        <button type="button" data-hero-mode-set="manual" aria-pressed="false">半自动</button>
      </div>
    </div>
    <div class="kg-chip kg-chip--map">
      <label class="kg-chip-label" for="kg-hero-map">挂机地图</label>
      <select id="kg-hero-map" data-hero-map-set>${maps}</select>
    </div>
    <div class="kg-chip kg-chip--hp">
      <label class="kg-chip-label" for="kg-hero-hp">喝药阈值 <output data-hero-hp-out>40%</output></label>
      <input id="kg-hero-hp" type="range" min="10" max="90" step="5" value="40" data-hero-hp-set />
    </div>`;
}

const SCOPE_DO = [
  ["锁图打怪", "在 lockMap 里自动索敌、接近、普攻、放技能，打完继续找下一只。"],
  ["寻路与跨图", "地图内按可用格子寻路；需要换图时自动传送。"],
  ["保命动作", "按阈值喝药、坐下回血、被围攻或危险时传送。"],
  ["捡物", "按拾取规则捡取；优先拾取会在物品出现时立刻过去。"],
  ["回城补给", "自动找 NPC 买药、卖杂物、存仓、取仓、修理装备。"],
  ["死亡返图", "死亡后按流程回城复活，再返回锁定的挂机地图。"],
  ["经验报告", "查看经验、Zeny、击杀与物品变化，估算每小时收益。"],
  ["实时控制台", "命令、日志、状态和调试入口都在同一个面板里。"],
] as const;

const SCOPE_DONT = [
  ["全自动爬塔", "不会自己组队、切层、处理塔内机制。"],
  ["镜像挑战", "不做镜像副本的进入、路线与机制处理。"],
  ["PVP", "不参与玩家对战，也不做战场自动化。"],
  ["无限塔", "不做无限塔的层数推进与换层决策。"],
  ["自动跑副本", "不进副本、不处理副本流程和结算。"],
] as const;

const AUDIENCE = [
  [
    "第一次挂机的新手",
    "不想研究一整套脚本，也不想用来源不明的程序。跟着四步走，先在一个安全的低阶地图跑起来，再慢慢加规则。",
  ],
  [
    "白手起家的菜农",
    "用一套能长期维护的配置，把打怪、捡物、补给和死亡返图串起来。不追求极限效率，先把稳定收益跑出来。",
  ],
  [
    "接触过 KE 的老玩家",
    "规则表、优先级这些概念基本照旧，只是在网页的配置工作台里用可视化方式完成，不用再手写文件。熟悉的那套思路可以继续用。",
  ],
  [
    "想省手但不想越界的人",
    "只让角色做重复劳动，不碰影响经济循环的玩法。能力范围写在页面上，越界的部分不做。",
  ],
] as const;

const FAQ = [
  [
    "开了「自动」，角色为什么站着不动？",
    "KE 不会在进图、登录或重载后自己启动。先在面板切到「自动」，或输入 ai auto。还是不动，就依次检查：角色是否已经进图、方案是否已激活、控制台有没有配置或地图资源报错。半自动只执行规则里勾选了半自动的自身物品、自身技能和队伍技能，不自动索敌。",
  ],
  [
    "我在网页改了配置，客户端什么时候生效？",
    "保存不等于生效。改的是使用中的方案，要回网页重新激活；然后在客户端右下角点「同步并重载」即可，不需要先关闭 AI。重载不会自动清空旧任务。",
  ],
  [
    "关掉客户端或浏览器，角色还会继续挂吗？",
    "网页版不会：KE 运行在进阶客户端里，客户端窗口关掉，AI 就停止。脱机版可以：Windows 关窗后留在系统托盘，Android 切到后台或锁屏也能继续；电脑关机、手机被系统清理或手动停止后才会停。两者都不是服务器端的离线挂机。",
  ],
  [
    "脱机版和网页里的 KE 有什么区别？",
    "网页版在浏览器里的进阶客户端中运行；脱机版是一个独立的 App，装在你的电脑或手机上，关掉浏览器也能继续挂。两者用的是同一个 LTSD 账号和同一套配置，实例额度也共用。下载入口在脱机版下载页。",
  ],
  [
    "macOS 和 iOS 现在能用吗？",
    "还不能。macOS 在开发中；iOS 受 Apple 分发政策限制，不保证上架，但会尽最大努力提供一份可用方案。确定后会在脱机版下载页和更新说明里公布。",
  ],
  [
    "一个账号能挂几个角色？",
    "注册并验证邮箱后，账号有 1 个 KE 实例额度，可以跑 1 个全自动角色。半自动不占额度，它只做自身物品、自身技能和队伍技能，不自动索敌、拾取或补给。",
  ],
  [
    "官方是什么态度？会不会影响经济？",
    "作者已就 KE 的能力边界与 LastRO 官方 GM 沟通。双方正在一起探讨这类工具在现有玩法中的合理位置，研究如何合理使用、避免过度泛滥；相关规则仍在完善，功能与限制可能随时调整。KE 不做影响游戏经济循环的自动化。",
  ],
  [
    "配置里写了 KE 不认识的功能，会怎样？",
    "范围外的字段或整个配置块会被忽略，控制台会给出一条提示，重载照常成功，其它字段正常生效。注意：触发条件被忽略后，这条规则可能比预期更容易触发。只有配置块结构不完整、值格式非法这类会让解析结果不可信的错误，才会让重载失败，并保留上一次的有效配置。",
  ],
  [
    "角色死亡、卡地图或掉线之后会怎样？",
    "死亡会按 KE 的流程回城、复活、返回锁定的挂机地图。换图、重连和死亡都不会关闭模式；只有登出、换角色或重新登录这类会话结束，才会回到关闭状态，需要重新开启。卡地图或失步时，KE 会停下动作而不是猜位置，先看控制台；地图资源没加载好，可以在调试页重试。",
  ],
  [
    "能自动爬塔、镜像、PVP、无限塔、跑副本吗？",
    "不能，这些都不在能力范围内。KE 面向的是新手和菜农的日常打怪、捡物与补给，不做大后期高端玩法，也不做插件、冷门 KE 功能或自动交易。",
  ],
  [
    "旧客户端能用吗？支持哪些服务器？",
    "KE 只在进阶客户端（RoBrowser 内核）里运行，老旧官方客户端没有这个面板。它和进阶客户端用同一套 LastRO 协议；能不能登录，以 KE 面板是否显示「连接就绪」为准。",
  ],
] as const;

function scopeMarkup(): string {
  const dos = SCOPE_DO.map(
    ([title, body]) => `<li><strong>${title}</strong><span>${body}</span></li>`,
  ).join("");
  const donts = SCOPE_DONT.map(
    ([title, body]) =>
      `<li><strong><span class="kg-cross" aria-hidden="true"></span>${title}</strong><span>${body}</span></li>`,
  ).join("");
  return `
    <section class="kg-scope" aria-labelledby="kg-scope-title">
      <div class="page-width">
        <header class="kg-section-head kg-reveal">
          <h2 id="kg-scope-title">它能做什么，不能做什么</h2>
          <p>先把边界放在最前面。范围内的能力按 KE 的语义实现；范围外的玩法不做，也不假装能做。</p>
        </header>
        <div class="kg-scope-grid">
          <div class="kg-scope-do kg-reveal">
            <h3>它擅长</h3>
            <ul>${dos}</ul>
          </div>
          <div class="kg-scope-dont kg-reveal">
            <h3>它不做</h3>
            <ul>${donts}</ul>
            <p>插件、冷门字段、自动交易、自动登录选角，也都不在范围内。</p>
          </div>
        </div>
        <p class="kg-scope-note kg-reveal">配置统一在网页的配置工作台里可视化完成，规则表按精确名 → 数字 ID → 通配符 → all 查找。范围外的配置会被忽略，并在控制台提示，不会悄悄生效。</p>
      </div>
    </section>`;
}

function audienceMarkup(): string {
  const columns = AUDIENCE.map(
    ([title, body]) =>
      `<div class="kg-audience-col kg-reveal"><h3>${title}</h3><p>${body}</p></div>`,
  ).join("");
  return `
    <section class="kg-audience page-width" aria-labelledby="kg-audience-title">
      <h2 id="kg-audience-title" class="kg-reveal">适合谁</h2>
      <p class="kg-lead kg-reveal">它是一件顺手的工具：在服务器原有支持的挂机玩法上做极大的效率优化，并加入更智能化的物品管理规则（丢弃 / 存仓 / 出售）。</p>
      <div class="kg-audience-grid">${columns}</div>
    </section>`;
}

function consensusMarkup(): string {
  return `
    <section class="kg-consensus" aria-labelledby="kg-consensus-title">
      <div class="page-width">
        <h2 id="kg-consensus-title">关于 KE 的能力范围与用途，作者已与 GM 进行了充分的沟通</h2>
        <blockquote>我们在努力给玩家带来更多新的游戏玩法和革新方向，将会一起研究如何合理使用、避免过度泛滥等问题。</blockquote>
      </div>
    </section>`;
}

function offlineMarkup(): string {
  return `
    <section class="kg-offline" aria-labelledby="kg-offline-title">
      <div class="page-width">
        <header class="kg-offline-head kg-reveal">
          <p class="kg-offline-kicker">KOREENGINE / STANDALONE</p>
          <h2 id="kg-offline-title">想关掉浏览器？把 KE 装进系统。</h2>
          <p>脱机版是一个独立客户端：账号和配置还是 LTSD 那一套，但挂机跑在你自己的电脑或手机上。Windows 与 Android 已开放下载，macOS 与 iOS 仍在开发中。</p>
        </header>
        <div class="kg-offline-grid">
          <div class="kg-offline-card kg-reveal">
            <span class="kg-offline-code">WIN / PC</span>
            <h3>Windows 桌面版</h3>
            <p>关掉窗口后留在系统托盘，角色继续跑；直接覆盖安装，账号和配置都会保留。</p>
            <a class="kg-btn kg-btn--primary" href="/ke/download?platform=windows">下载 Windows 版</a>
          </div>
          <div class="kg-offline-card kg-reveal">
            <span class="kg-offline-code">AND / APK</span>
            <h3>Android 手机版</h3>
            <p>切到后台或锁屏也能继续跑；直接覆盖安装就行，不用先卸载。</p>
            <a class="kg-btn kg-btn--primary" href="/ke/download?platform=android">下载 Android 版</a>
          </div>
          <div class="kg-offline-card kg-offline-card--dev kg-reveal">
            <span class="kg-offline-code">DEV / LEDGER</span>
            <h3>macOS 与 iOS</h3>
            <p>macOS 正在开发；iOS 受 Apple 分发政策限制，不保证上架，但会尽最大努力提供一份可用方案。</p>
            <a class="kg-offline-more" href="/ke/download">查看平台列表 →</a>
          </div>
        </div>
        <p class="kg-offline-note kg-reveal">下载按钮会直接给你当前稳定版，不经过网盘。脱机版与网页版共用同一套实例额度。</p>
      </div>
    </section>`;
}

function mountFragment(): string {
  return `
    <div class="kg-fragment" data-ui>
      <div class="kg-fragment-head"><strong>物品使用</strong><span>1 条规则</span></div>
      <div class="kg-fragment-field"><span>物品</span><strong>坐骑用缰绳</strong></div>
      <div class="kg-fragment-field"><span>条件</span><strong>状态未生效时 · 搭乘中</strong></div>
      <div class="kg-fragment-field"><span>冷却时间</span><strong class="kg-fragment-hot">2 秒</strong></div>
      <p class="kg-fragment-note">不填冷却，状态还没刷新时会反复触发</p>
    </div>`;
}

function monsterFragment(): string {
  const rows = [
    ["兽人战士", "自动攻击", "不传送"],
    ["波利", "忽略", "见到就飞"],
    ["蘑菇", "仅反击", "被打才飞"],
  ]
    .map(
      ([name, attack, escape]) =>
        `<div class="kg-rule-row"><strong>${name}</strong><span>${attack}</span><span>${escape}</span></div>`,
    )
    .join("");
  return `
    <div class="kg-fragment" data-ui>
      <div class="kg-fragment-head"><strong>怪物规则</strong><span>攻击策略 / 遇怪传送</span></div>
      ${rows}
      <p class="kg-fragment-note">不写的列保持未设置，不会自动补 0</p>
    </div>`;
}

function itemFragment(): string {
  const rows = [
    ["*卡片", "优先拾取"],
    ["红色药水", "拾取"],
    ["杰勒比结晶", "不拾取"],
    ["空瓶", "丢弃"],
  ]
    .map(
      ([name, flag]) =>
        `<div class="kg-pick-row"><strong>${name}</strong><span>${flag}</span></div>`,
    )
    .join("");
  return `
    <div class="kg-fragment" data-ui>
      <div class="kg-fragment-head"><strong>拾取物品</strong><span>一出现就过去 / 路过顺手</span></div>
      ${rows}
      <p class="kg-fragment-note">丢弃＝不捡，并让地上的物品消失</p>
    </div>`;
}

function keepFragment(): string {
  return `
    <div class="kg-fragment" data-ui>
      <div class="kg-fragment-head"><strong>物品规则</strong><span>保留 / 存仓 / 出售</span></div>
      <div class="kg-fragment-field"><span>物品</span><strong>杰勒比结晶</strong></div>
      <div class="kg-fragment-field"><span>身上保留</span><strong class="kg-fragment-hot">20</strong></div>
      <div class="kg-fragment-field"><span>存仓 / 出售</span><strong>存仓开 · 出售关</strong></div>
      <p class="kg-fragment-note">多于 20 的部分才处理；同时开先存仓，仓库满才卖</p>
    </div>`;
}

function howToMarkup(): string {
  return `
    <section class="kg-how" aria-labelledby="kg-how-title">
      <div class="page-width">
        <header class="kg-section-head kg-reveal">
          <h2 id="kg-how-title">高频配置，手把手</h2>
          <p>不用写配置块，照着下面的路径点就行。每一步用的都是配置工作台里现有的按钮和字段。</p>
        </header>

        <article class="kg-how-item">
          <div class="kg-how-copy kg-reveal">
            <h3>如何让角色自动上坐骑？</h3>
            <p>坐骑用缰绳的效果会显示成「搭乘中」。让 KE 在没搭乘时自动用一次缰绳，赶路时就不用再手动上马。</p>
            <ol class="kg-flow">
              <li>打开 <a href="/ke/my">配置工作台</a>，选中角色，进入方案编辑。</li>
              <li>左侧切到「物品装备」→「物品使用」，点「添加新规则」。</li>
              <li>物品选「坐骑用缰绳」；点击添加「自身条件」并设置 「状态未生效时」，状态搜索并选择「搭乘中」。</li>
              <li>「冷却时间」填 2，保存方案；如果这是使用中的方案，重新激活。</li>
              <li>回到客户端，点右下角「同步并重载」即可生效。</li>
            </ol>
            <p class="kg-note"><strong>冷却不要填 0：</strong>上下坐骑有动作和动画延迟，状态刷新也需要一点时间。填 0 的话，规则会在「搭乘中」还没生效时反复触发，角色不停上下坐骑，打断攻击、施法和移动。填 2 秒就够。</p>
          </div>
          <div class="kg-how-fragment kg-reveal">${mountFragment()}</div>
        </article>

        <article class="kg-how-item">
          <div class="kg-how-copy kg-reveal">
            <h3>该如何设置怪物规则？</h3>
            <p>「规则表」→「怪物规则」，点「添加怪物规则」，搜索怪物后改两列就够了：攻击策略决定打不打，遇怪传送决定跑不跑。</p>
            <ul class="kg-cases">
              <li><strong>想打：</strong>攻击策略选「自动攻击」。</li>
              <li><strong>完全不想碰：</strong>攻击策略选「忽略」，连围攻计数都不算它。</li>
              <li><strong>可以还手但别主动追：</strong>攻击策略选「仅反击」。</li>
              <li><strong>见到就跑：</strong>攻击策略「忽略」，遇怪传送选「见到就飞」。</li>
              <li><strong>被打才跑：</strong>攻击策略保持原样，遇怪传送选「被打才飞」。</li>
            </ul>
            <p class="kg-note">没写的列保持未设置，不会自动补 0。规则按精确名 → 数字 ID → 通配符 → all 查找，所以给某只怪写了专门一行，就不用担心被 all 覆盖。</p>
          </div>
          <div class="kg-how-fragment kg-reveal">${monsterFragment()}</div>
        </article>

        <article class="kg-how-item kg-how-item--band">
          <div class="kg-how-band-head kg-reveal">
            <h3>如何设置捡物与物品处理？</h3>
            <p>「拾取物品」只管捡不捡；捡起来之后是留、是存、是卖，在「物品规则」里另配。两处都按优先级查找，给具体道具写过规则，就不会被 all 兜底改掉。</p>
          </div>
          <div class="kg-how-band-grid">
            <div class="kg-how-band-col kg-reveal">
              <h4>如何设置捡不捡？</h4>
              <p>「规则表」→「拾取物品」，点「添加拾取规则」，选好物品后挑一个方式。</p>
              <ul class="kg-cases">
                <li><strong>拼命捡：</strong>「优先拾取」，物品一出现就马上过去。</li>
                <li><strong>顺手捡：</strong>「拾取」，路过时捡。</li>
                <li><strong>不捡：</strong>「不拾取」，物品留在地上。</li>
                <li><strong>眼不见为净：</strong>「丢弃」，不捡，并让物品消失。</li>
              </ul>
              <p class="kg-note">「优先拾取」会让角色放下当前目标去捡，卡片、稀有材料才值得这么设；普通垃圾用「拾取」就够了。
              </br>
              作者建议：开启服务器自带捡物功能并设置100%拾取，同时配置KE物品设置中将例如 铁矿石 这种死沉死沉的垃圾设置为 -1(丢弃)， 就算铁矿石自动发到你包里也会马上自动丢地上，啊！呸！</p>
              ${itemFragment()}
            </div>
            <div class="kg-how-band-col kg-reveal">
              <h4>如何处理捡到的东西？</h4>
              <p>「规则表」→「物品规则」，点「添加物品规则」，选中物品后先填「身上保留」。</p>
              <ol class="kg-flow">
                <li>保留是基准线，不是上限。</li>
                <li>身上多于保留：按开关存仓、出售或放进推车。</li>
                <li>少于保留：从推车补回。</li>
                <li>同时开存仓和出售时先存仓，仓库满了才会卖。</li>
              </ol>
              <p class="kg-note">保留 20 的意思是「身上至少留 20 个」，不是「最多带 20 个」。想全部卖掉就把保留填 0。</p>
              ${keepFragment()}
            </div>
          </div>
        </article>
      </div>
    </section>`;
}

function skillRuleFragment(
  name: string,
  rows: readonly (readonly [string, string])[],
  note: string,
): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<div class="kg-fragment-field"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  return `
    <div class="kg-fragment" data-ui>
      <div class="kg-fragment-head"><strong>${name}</strong><span>技能规则</span></div>
      ${body}
      <p class="kg-fragment-note">${note}</p>
    </div>`;
}

function skillsMarkup(): string {
  return `
    <section class="kg-skills" aria-labelledby="kg-skills-title">
      <div class="page-width">
        <header class="kg-section-head kg-reveal">
          <h2 id="kg-skills-title">如何合理设置释放技能和时机？</h2>
          <p>「技能规则」页签里有三种卡片：攻击技能、自身增益 / 治疗、队伍技能。同一张卡片里的条件要全部满足才会释放，所以先用最少的条件跑通，再逐条加。</p>
        </header>

        <div class="kg-skill-grid">
          <article class="kg-skill-ex kg-reveal">
            <span class="kg-skill-tag">例 1</span>
            <h3>怪多才放范围技能</h3>
            <p>单只怪用普攻解决，聚到一堆再放范围技能，SP 和咏唱都不浪费。</p>
            ${skillRuleFragment(
              "暴风雪 · 攻击技能",
              [
                ["自身条件", "周围可见怪物数量 ≥ 3"],
                ["统计范围", "7 格"],
                ["自身条件", "SP &gt; 30%"],
                ["冷却时间", "8 秒"],
              ],
              "怪物数量不够时，这条规则不触发，AI 继续走普攻。",
            )}
            <ol class="kg-flow">
              <li>「技能规则」→「攻击技能」，点「添加新规则」，搜索技能名选中。</li>
              <li>「自身条件」栏点「＋ 添加条件」，选「周围可见怪物数量」，设 ≥ 3；「怪物数量统计范围」填 7。</li>
              <li>再加一条自身条件：SP &gt; 30%，蓝不够就不放。</li>
              <li>冷却填 8 秒，避免同一波怪里反复起手。</li>
            </ol>
          </article>

          <article class="kg-skill-ex kg-reveal">
            <span class="kg-skill-tag">例 2</span>
            <h3>打残了再用技能收尾</h3>
            <p>技能留给血量见底的怪，前半段用普攻磨，省下大量 SP。</p>
            ${skillRuleFragment(
              "单体技能 · 攻击技能",
              [
                ["怪物条件", "目标 HP &lt; 40%"],
                ["怪物条件", "目标距离 ≤ 6"],
                ["自身条件", "SP &gt; 25%"],
                ["冷却时间", "1 秒"],
              ],
              "目标 HP、目标距离属于怪物条件，只有攻击技能能加。",
            )}
            <ol class="kg-flow">
              <li>建一张「攻击技能」卡片，选你的主力单体技能。</li>
              <li>「怪物条件」栏点「＋ 添加条件」，选「目标 HP」，设 &lt; 40%。</li>
              <li>再加「目标距离 ≤ 6」，太远就先走近。</li>
              <li>自身条件补 SP &gt; 25%，冷却 1 秒。</li>
            </ol>
          </article>

          <article class="kg-skill-ex kg-reveal">
            <span class="kg-skill-tag">例 3</span>
            <h3>增益掉了才补</h3>
            <p>不用自己算持续时间，交给状态判断，buff 一掉就补上。</p>
            ${skillRuleFragment(
              "加速术 · 自身技能",
              [
                ["自身条件", "状态未生效 · 加速"],
                ["自身条件", "SP &gt; 15%"],
                ["冷却时间", "2 秒"],
              ],
              "靠「状态未生效」判断，持续多久都不用改；冷却只用来防止重复触发。",
            )}
            <ol class="kg-flow">
              <li>「技能规则」→「自身增益 / 治疗」，添加一张卡片。</li>
              <li>「自身条件」加「状态未生效时」，搜索并选中对应状态。</li>
              <li>补一条 SP &gt; 15%，避免把蓝耗在 buff 上。</li>
              <li>冷却填 2 秒，防止施放动作里重复触发。</li>
            </ol>
          </article>
        </div>

        <div class="kg-skill-notes">
          <p class="kg-note"><strong>治疗先交给智能治疗：</strong>技能页签的「智能治疗」默认开启，会按 HP 和 SP 自己挑治疗手段。想固定阈值，才在治愈术这条规则上勾「不使用智能治疗」，这个选项只在治愈术上出现。</p>
          <p class="kg-note"><strong>咏唱太长会被打断：</strong>用「最小 / 最大咏唱」把读条过长的技能挡掉，需要贴身的技能就用「施放距离」和「最大距离」控制起手位置。</p>
          <p class="kg-note"><strong>卡片顺序就是判断顺序：</strong>同一类型里从上往下逐张检查，第一张条件全部满足的卡片会被执行，后面的同类型卡片不再看。卡片右上角可以拖动排序。</p>
        </div>
      </div>
    </section>`;
}

function rulesMarkup(): string {
  const rows = GUIDE_RULES.map(
    (rule) =>
      `<div class="kg-ledger-row" data-rule="${rule.id}"><code>${rule.pattern}</code><span>${rule.label}</span><span>${rule.note}</span></div>`,
  ).join("");
  const examples = [
    ["红*药", "红色药水、红药……以「红」开头、以「药」结尾的名字"],
    ["*卡片", "波利卡片、兽人卡片……所有卡片"],
    ["?色药水", "黄色药水、白色药水……恰好一个字加「色药水」"],
    ["兽人*", "兽人战士、兽人弓箭手……以「兽人」开头的怪物"],
  ]
    .map(
      ([pattern, text]) =>
        `<li><code>${pattern}</code><span>${text}</span></li>`,
    )
    .join("");
  return `
    <section class="kg-rules" aria-labelledby="kg-rules-title">
      <div class="page-width kg-rules-grid">
        <div class="kg-rules-copy kg-reveal">
          <h2 id="kg-rules-title">规则怎么命中？</h2>
          <p>怪物规则、拾取物品、物品规则都用同一套查找顺序：先找精确名，再找数字 ID，然后按列表顺序找通配符，最后才落到 all。右边这张账本会即时判定。</p>
          <h3>all 是最后一行</h3>
          <p>all 是兜底：没有为某个对象写具体规则时，才会用到它。怪物规则还多两个保留名：all_mvp 只匹配 MVP，all_miniboss 只匹配小 Boss；两者都不写时，才落到 all。</p>
          <h3>* 和 ? 怎么用</h3>
          <ul class="kg-examples">${examples}</ul>
          <p class="kg-note">多条通配符同时命中时，取列表中靠前的一条。所以把更精确的通配符放在上面。</p>
        </div>
        <div class="kg-ledger kg-reveal" data-ui>
          <label class="kg-ledger-label" for="kg-rule-input">输入一个物品名，看看哪一行会命中</label>
          <input id="kg-rule-input" type="text" autocomplete="off" spellcheck="false" value="红色药水" />
          <div class="kg-ledger-chips" role="group" aria-label="示例物品">
            <button type="button" data-rule-sample="红色药水">红色药水</button>
            <button type="button" data-rule-sample="黄色药水">黄色药水</button>
            <button type="button" data-rule-sample="波利卡片">波利卡片</button>
            <button type="button" data-rule-sample="12622">12622</button>
            <button type="button" data-rule-sample="杰勒比结晶">杰勒比结晶</button>
          </div>
          <div class="kg-ledger-head" aria-hidden="true"><span>规则写法</span><span>对应</span><span>说明</span></div>
          <div class="kg-ledger-rows">${rows}</div>
          <p class="kg-ledger-result" data-rule-result role="status" aria-live="polite"></p>
        </div>
      </div>
    </section>`;
}

function faqMarkup(): string {
  const items = FAQ.map(
    ([question, answer]) =>
      `<details name="ke-faq"><summary>${question}</summary><p>${answer}</p></details>`,
  ).join("");
  return `
    <section class="kg-faq page-width" aria-labelledby="kg-faq-title">
      <div class="kg-faq-head kg-reveal">
        <h2 id="kg-faq-title">常见问题</h2>
        <p>先看这里。答案都按当前版本的实际行为写。</p>
        <div class="kg-faq-side">
          <strong>记住三条边界</strong>
          <ul>
            <li>不做爬塔、镜像、PVP、无限塔、自动副本。</li>
            <li>不做自动交易、插件和冷门 KE 功能。</li>
            <li>经济相关玩法按沟通约定克制使用。</li>
          </ul>
        </div>
        <p class="kg-faq-note">没找到答案？<a href="/guestbook">去留言板提问 →</a></p>
      </div>
      <div class="kg-faq-list kg-reveal">${items}</div>
    </section>`;
}

function ctaMarkup(): string {
  return `
    <section class="kg-cta page-width" aria-labelledby="kg-cta-title">
      <h2 id="kg-cta-title" class="kg-reveal">下一步，去配一套自己的方案</h2>
      <p class="kg-reveal">从一张安全的地图开始，先把打怪和捡物跑顺，再补补给和规则。卡住了，就回来看这一页。</p>
      <div class="kg-cta-actions kg-reveal">
        <a class="kg-btn kg-btn--primary" href="/ke/my">去配置我的方案</a>
        <a class="kg-btn kg-btn--ghost" href="/ke/hall">看看别人怎么配</a>
        <a class="kg-btn kg-btn--ghost" href="/ke/download">下载脱机版</a>
        <a class="kg-link" href="/client">安装进阶客户端</a>
      </div>
    </section>`;
}

function footerMarkup(): string {
  return `
    <footer class="site-footer kg-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/ke/guide">KE指南</a><a href="/ke/download">脱机版下载</a><a href="/ke/my">配置工作台</a><a href="/ke/hall">配置大厅</a><a href="/client">进阶客户端</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>`;
}

/** 让没有 IntersectionObserver 的环境（含测试）也能看到全部内容。 */
function revealSections(root: HTMLElement): void {
  const targets = [...root.querySelectorAll<HTMLElement>(".kg-reveal")];
  if (targets.length === 0) return;
  if (typeof IntersectionObserver === "undefined") {
    targets.forEach((target) => target.classList.add("is-in"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
  );
  targets.forEach((target) => observer.observe(target));
}

interface HeroState {
  mode: "auto" | "manual";
  running: boolean;
  map: string;
  hp: number;
}

function mountHero(root: HTMLElement): void {
  const state: HeroState = {
    mode: "auto",
    running: true,
    map: MAP_OPTIONS[0]!.value,
    hp: 40,
  };
  const modes = [...root.querySelectorAll<HTMLElement>("[data-hero-mode]")];
  const task = root.querySelector<HTMLElement>("[data-hero-task]");
  const map = root.querySelector<HTMLElement>("[data-hero-map]");
  const target = root.querySelector<HTMLElement>("[data-hero-target]");
  const log = root.querySelector<HTMLElement>("[data-hero-log]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-hero-toggle]");
  const modeButtons = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-hero-mode-set]"),
  ];
  const mapSelect = root.querySelector<HTMLSelectElement>(
    "[data-hero-map-set]",
  );
  const hpInput = root.querySelector<HTMLInputElement>("[data-hero-hp-set]");
  const hpOut = root.querySelector<HTMLOutputElement>("[data-hero-hp-out]");

  const render = (): void => {
    const modeLabel = state.running
      ? state.mode === "auto"
        ? "自动"
        : "半自动"
      : "关闭";
    const modeCode = state.running
      ? state.mode === "auto"
        ? "AUTO"
        : "MANUAL"
      : "OFF";
    modes.forEach((node) => {
      node.textContent = node.tagName === "DD" ? modeLabel : modeCode;
    });
    if (task)
      task.textContent = !state.running
        ? "idle"
        : state.mode === "auto"
          ? "attack"
          : "assist";
    if (map) map.textContent = state.map;
    if (target)
      target.textContent = !state.running
        ? "—"
        : state.mode === "auto"
          ? "波利"
          : "等待手动指令";
    if (log) {
      log.innerHTML = state.running
        ? `<span>[12:00:03]</span> ${modeLabel} · 喝药阈值 ${state.hp}% · ${state.map}`
        : "<span>[12:00:03]</span> 已暂停 · 等待指令";
    }
    if (toggle) toggle.textContent = state.running ? "关闭自动" : "开启自动";
    modeButtons.forEach((button) => {
      const active = button.dataset.heroModeSet === state.mode;
      button.classList.toggle("is-on", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (mapSelect) mapSelect.value = state.map;
    if (hpInput) hpInput.value = String(state.hp);
    if (hpOut) hpOut.textContent = `${state.hp}%`;
  };

  toggle?.addEventListener("click", () => {
    state.running = !state.running;
    render();
  });
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.heroModeSet === "manual" ? "manual" : "auto";
      state.running = true;
      render();
    });
  });
  mapSelect?.addEventListener("change", () => {
    state.map = mapSelect.value;
    render();
  });
  hpInput?.addEventListener("input", () => {
    state.hp = Number(hpInput.value);
    render();
  });
  render();
}

function mountRuleLedger(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("#kg-rule-input");
  const result = root.querySelector<HTMLElement>("[data-rule-result]");
  const rows = [...root.querySelectorAll<HTMLElement>("[data-rule]")];
  const samples = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-rule-sample]"),
  ];
  if (!input || !result) return;

  const render = (): void => {
    const match = matchRule(input.value);
    rows.forEach((row) => {
      row.classList.toggle("is-hit", row.dataset.rule === match?.rule.id);
    });
    if (!match) {
      result.textContent = "输入一个物品名或数字 ID。";
      return;
    }
    result.textContent = `命中「${match.rule.pattern}」· ${match.reason}`;
  };

  input.addEventListener("input", render);
  samples.forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.ruleSample ?? "";
      render();
      input.focus();
    });
  });
  render();
}

export function mountKeGuidePage(root: HTMLElement): void {
  document.title = "KE 指南 · 露天商店.Ro";
  root.innerHTML = `
    <header class="site-header kg-header">
      <div class="topbar page-width">
        <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
        ${siteNavMarkup("guide")}
      </div>
    </header>
    <main class="kg-main">
      <section class="kg-hero" aria-labelledby="kg-title">
        <div class="kg-hero-inner page-width">
          <div class="kg-hero-copy">
            <h1 id="kg-title"><span class="kg-line"><span>把 KE</span></span><span class="kg-line"><span>搬进浏览器</span></span></h1>
            <p class="kg-hero-lead">KE 是进阶客户端里的挂机辅助：配置统一在网页里可视化完成，用超高性能 AI 在本地进行决策，实测内存占用 2–3MB。登录仍由你自己完成。</p>
            <div class="kg-hero-actions">
              <a class="kg-btn kg-btn--primary" href="/ke/my">去配置我的方案</a>
              <a class="kg-link" href="/client">还没装 进阶客户端？</a>
            </div>
            <p class="kg-hero-foot">写给新手和菜农 · 锁图打怪、捡物、补给、死亡返图</p>
          </div>
          <div class="kg-hero-stage">
            <div class="kg-hero-app" data-ui>
              <div class="kg-hero-controls">${heroChipsMarkup()}</div>
              ${heroPanelMarkup()}
            </div>
          </div>
        </div>
      </section>

      ${consensusMarkup()}
      ${offlineMarkup()}
      ${scopeMarkup()}
      ${audienceMarkup()}
      ${howToMarkup()}
      ${skillsMarkup()}
      ${rulesMarkup()}
      ${faqMarkup()}
      ${ctaMarkup()}
    </main>
    ${footerMarkup()}
  `;

  mountSiteNav(root);
  injectLegalLinksIntoFooters(root);
  mountHero(root);
  mountRuleLedger(root);
  revealSections(root);
}
