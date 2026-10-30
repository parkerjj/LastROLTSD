// KE 萌新一键配置页（/ke/my/create/setup-guide）。
// 单页 5 卡片布局对齐 design-preview-setup-guide-simple.html（v6）：
// 1 去哪挂机 · 2 怎么找怪 · 3 要哪几个功能 · 4 用哪些技能 · 5 将写入的配置。
// 数据来自真实接口（角色 /ke/options.json /ke/map-mobs.json /ke/skill-types.json），
// 保存经 ke-schema / ke-controls 序列化后 POST /api/v1/ke/profiles 真实落库。

import { keFetch } from "./ke-page";
import { openWorldmapPicker } from "./ke-worldmap";
import {
  defaultDoc,
  serializeConfig,
  stripConfigComments,
  validateConfigDoc,
  type BlockValue,
  type ConfigDoc,
} from "./ke-schema";
import {
  CONTROL_SCHEMAS,
  GRASS_MOB_NAMES,
  controlSafeName,
  defaultControlDoc,
  ensureAllFallback,
  newControlRow,
  serializeControl,
  TIMEOUT_DEFAULT_OVERRIDES,
  validateControlDoc,
  type ControlDoc,
  type ControlRow,
} from "./ke-controls";
import { isLocalDemoMode } from "./demo-mode";
import { mountSiteNav, siteNavMarkup } from "./nav";
import { injectLegalLinksIntoFooters } from "./footer-links";
import {
  FALLBACK_JOBS,
  SKILL_SPECIALS,
  buildJobsFromOptions,
  clampJobForNid,
  isAoeSkill,
  listJobSeries,
  presetOf,
  serverCapOf,
  type AuxCat,
  type JobData,
  type JobSeriesOption,
} from "./ke-jobs";
import { maxLvlOfHandle } from "./ke-skill-max";
import "./ke-setup-guide.css";

interface KeCharacter {
  aid: number;
  cid: number;
  nid: number;
  char_name: string;
  job_id: number | null;
  map_name: string | null;
  last_seen_at: number;
}

interface SkillOpt {
  id: number;
  name?: string;
  nameZh?: string;
  handle?: string;
}
interface StatusOpt {
  id: number;
  handle: string;
  name?: string;
  nameZh?: string;
}
interface NameOpt {
  id: number;
  name: string;
}
interface KeOptionsLite {
  jobs?: Record<string, string>;
  jobs_zh?: Record<string, string>;
  skills?: SkillOpt[];
  statuses?: StatusOpt[];
  monsters?: NameOpt[];
  items?: NameOpt[];
  job_skills?: Record<string, number[]>;
  job_skill_groups?: Record<string, Record<string, number[]>>;
  timeouts?: { key: string; value: string }[];
}
interface MapMobsEntry {
  mobs: number[];
  drops: number[];
  /** 该图里的 MVP 怪物 ID：生成 mon_control 时跳过它们的具名行，交给 all_mvp（见到就飞）。 */
  mvp?: number[];
}
interface MapMobsData {
  maps: Record<string, MapMobsEntry>;
}
interface SkillTypesFile {
  skills?: Record<string, string>;
}
interface MapNamesFile {
  names?: Record<string, string>;
}

type ElemKey = "fire" | "ice" | "thunder" | "earth" | "holy" | "phys";
type SwitchKey = "attack" | "basic" | "potion" | "wing" | "loot" | "mount";
type HuntMode = "walk" | "tp";
type TpMode = "item" | "skill";
type PickMode = "yes" | "no" | "drop";
type HandleMode = "keep" | "store" | "sell";

interface AtkSkill {
  id: string;
  name: string;
  lv: number;
  elem: ElemKey;
  /** 特殊打法说明（挑衅每只怪 1 次 / 弹指神通 9 格等）。 */
  hint?: string;
}
interface BuffSkill {
  name: string;
  id: string;
  lv: number;
  cat: AuxCat;
  conds: Cond[];
  hint: string;
}
interface Cond {
  k: string;
  v: string;
}
interface ItemRule {
  pick: PickMode;
  handle: HandleMode;
}
interface AdvState {
  sp: number;
  dist: number;
  potHp: number;
  tpHp: number;
  tpAggr: number;
  sitLo: number;
  sitHi: number;
  sitSpLo: number;
  sitSpHi: number;
  townWeight: number;
  sellNpc: string;
  storeNpc: string;
  follow: boolean;
  followTarget: string;
}

const ELEM_LABEL: Record<ElemKey, string> = {
  fire: "火",
  ice: "冰",
  thunder: "雷",
  earth: "地",
  holy: "圣",
  phys: "物理",
};
const CAT_LABEL: Record<AuxCat, string> = {
  buff: "增益",
  ground: "地面",
  heal: "治疗",
  survival: "保命",
};
const SWITCHES: { key: SwitchKey; name: string; desc: string }[] = [
  { key: "attack", name: "自动打怪", desc: "自动攻击范围内的怪，技能用下面勾选的那几条" },
  { key: "basic", name: "使用平A攻击", desc: "打怪时用武器普攻补伤害；魔法师等施法职业默认关闭" },
  { key: "potion", name: "喝药回复", desc: "血量低自动喝回血药，只回血不喝蓝" },
  { key: "wing", name: "濒死瞬移", desc: "血量过低或被围攻时自动飞走" },
  { key: "loot", name: "拾取 + 回城补给", desc: "捡自己的掉落，负重满自动回城卖店补药" },
  { key: "mount", name: "自动坐骑", desc: "背包里有坐骑缰绳就自动上马" },
];
const ICONS: Record<SwitchKey, string> = {
  attack: '<svg viewBox="0 0 24 24"><path d="M4 20l7-7"/><path d="M14 4l6 6-9 9-3 1 1-3 5-5"/></svg>',
  basic: '<svg viewBox="0 0 24 24"><path d="M5 19l9-9"/><path d="M13 5l6 6-4 2-2 4-6-6 2-4z"/><path d="M3 21l3-3"/></svg>',
  potion: '<svg viewBox="0 0 24 24"><path d="M9 3h6"/><path d="M10 3v5L6 17a3 3 0 003 4h6a3 3 0 003-4l-4-9V3"/><path d="M7.5 15h9"/></svg>',
  wing: '<svg viewBox="0 0 24 24"><path d="M4 16c4-1 7-4 8-11 1 7 4 10 8 11-3 1-5 1-8-2-3 3-5 3-8 2z"/></svg>',
  loot: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 016 0v2"/></svg>',
  mount: '<svg viewBox="0 0 24 24"><path d="M6 4c0 5 3 8 7 8h3a2 2 0 012 2v6"/><path d="M4 20h8"/><path d="M16 8l2-4"/></svg>',
};

// 常见回血物品（名称逐个对照 KE items 表核过）：只回血，不管 SP。
const POTIONS: readonly string[] = [
  "红色药水", "赤色药水", "黄色药水", "白色药水",
  "轻盈红色药水", "轻盈赤色药水", "轻盈黄色药水", "轻的白色药水",
  "香蕉", "苹果", "青苹果", "红萝卜", "蜜饯香蕉", "金黄烤苹果",
];
const TELEPORT_ITEM = "魔法苍蝇翅膀";
const MOUNT_ITEM = "坐骑缰绳";
const ARROW_ITEM = "箭矢";
const AMMO_BOX = "魔法箭矢筒";
const SELF_USE_ITEMS = new Set<string>([...POTIONS, ARROW_ITEM, MOUNT_ITEM, TELEPORT_ITEM, AMMO_BOX]);

function esc(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function elemOf(name: string): ElemKey {
  if (/火|炎|陨石|燃烧|爆炎|火箭|火球|火烟/iu.test(name)) return "fire";
  if (/冰|霜|冻|水球|暴风雪|冰刃/iu.test(name)) return "ice";
  if (/雷|电|雷鸣|怒雷|雷击|闪电|风刃|朔风/iu.test(name)) return "thunder";
  if (/地|震|石|大地|重力|崩击/iu.test(name)) return "earth";
  if (/圣|治愈|天使|神圣|光耀|十字|祈福/iu.test(name)) return "holy";
  return "phys";
}

function footerMarkup(): string {
  return `
    <footer class="site-footer kg-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/ke/guide">KE指南</a><a href="/ke/my">配置工作台</a><a href="/ke/hall">配置大厅</a><a href="/client">进阶客户端</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>`;
}

function pageMarkup(): string {
  return `
  <header class="site-header kg-header">
    <div class="topbar page-width">
      <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup("guide")}
    </div>
  </header>
  <div class="ksg">
    <main class="ksg-main">
      <div class="ksg-wrap">
        <section class="ksg-hero">
          <p class="ksg-eyebrow">KE · 萌新一键配置</p>
          <h1>不用看文档，<em>勾一下</em>就能挂机。</h1>
          <p class="ksg-sub"><span id="ksgJobCount">…</span> 条职业线全内置技能与 buff 预设，按角色所在服务器自动匹配最高职业，其余全部自动。</p>
        </section>

        <p class="ksg-state" id="ksgState" role="status" aria-live="polite">正在加载角色与配置数据…</p>

        <section class="ksg-card ksg-char-card" id="ksgCharCard">
          <div class="ksg-avatar" id="ksgAvatar">…</div>
          <div class="ksg-char-main">
            <b><span id="ksgCharName">…</span><span class="ksg-badge" id="ksgCharBadge">已绑定</span></b>
            <small id="ksgJobMeta">正在匹配职业预设…</small>
          </div>
          <div class="ksg-char-switch" id="ksgJobSwitch" hidden>
            <span>切换预览</span>
            <select class="ksg-job-select" id="ksgJobSelect"></select>
          </div>
          <div class="ksg-char-switch" id="ksgJobFixed" hidden>
            <span>职业</span>
            <b id="ksgJobName">…</b>
          </div>
        </section>

        <div id="ksgCards">
          <section class="ksg-card">
            <div class="ksg-sec-head"><h2>1. 去哪挂机</h2><span>回城点默认普隆德拉</span></div>
            <div class="ksg-map-row">
              <div class="ksg-field ksg-grow">挂机地图
                <button class="ksg-map-pick" id="ksgMapPick" type="button">
                  <span class="ksg-map-pin">⌖</span>
                  <span class="ksg-map-txt">
                    <b id="ksgMapName">…</b>
                    <small>点开世界地图，点一下格子就选好了</small>
                  </span>
                  <span class="ksg-map-go">世界地图 →</span>
                </button>
              </div>
              <div class="ksg-field ksg-auto">回城点
                <div class="ksg-town-fixed"><b>普隆德拉</b><span class="ksg-tag">默认坐标</span></div>
              </div>
            </div>
            <p class="ksg-hint" id="ksgMapHint">正在读取地图数据…</p>
          </section>

          <section class="ksg-card">
            <div class="ksg-sec-head"><h2>2. 怎么找怪</h2><span>二选一</span></div>
            <div class="ksg-seg" id="ksgHuntSeg">
              <button class="ksg-seg-btn" data-hunt="walk" type="button"><b>走路寻怪</b><small>绕全图边走边找，不烧翅膀</small></button>
              <button class="ksg-seg-btn" data-hunt="tp" type="button"><b>瞬移寻怪</b><small>原地飞进怪堆，找怪更快</small></button>
            </div>
            <div id="ksgTpWrap"></div>
            <p class="ksg-hint" id="ksgHuntHint">…</p>
          </section>

          <section class="ksg-card">
            <div class="ksg-sec-head"><h2>3. 要哪几个功能</h2><span>6 个开关 · 细节自动</span></div>
            <div class="ksg-switch-grid" id="ksgSwitches"></div>
            <p class="ksg-hint">使用平A攻击：大多数职业默认开启，用武器普攻补伤害；魔法师、巫师、贤者等施法职业默认关闭，避免普攻拖慢施法。关闭后只放上面勾选的技能。</p>
          </section>

          <section class="ksg-card">
            <div class="ksg-sec-head"><h2>4. 用哪些技能</h2><span id="ksgSkillCount">…</span></div>
            <div class="ksg-sec-h3">自动攻击技能</div>
            <div class="ksg-sk-list" id="ksgAtkList"></div>
            <div id="ksgElemPanel"></div>
            <div class="ksg-sec-h3">保持自身 buff</div>
            <div class="ksg-sk-list" id="ksgBuffList"></div>
            <p class="ksg-hint">勾选后自动保持，状态一消失就会补上，不用管等级和间隔。</p>
          </section>

          <section class="ksg-card">
            <div class="ksg-sec-head"><h2>5. 将写入的配置</h2><span id="ksgOutCount">…</span></div>
            <div class="ksg-chips" id="ksgChips"></div>
            <div class="ksg-output-foot">
              <p class="ksg-hint">全部自动生成，保存前会再按 KE 规则校验一次。</p>
              <button class="ksg-ghost" id="ksgPreviewBtn" type="button">查看生成的配置 →</button>
            </div>
          </section>

          <details class="ksg-card ksg-advanced" id="ksgAdvanced">
            <summary>高级设置 <span>一般不用改 · 展开可微调数值与物品规则</span></summary>
            <div class="ksg-adv-grid">
              <div class="ksg-adv-col">
                <h3>战斗数值</h3>
                <div class="ksg-adv-row"><label>施法 SP</label><input class="ksg-mini" id="ksgSp" value="20" /><span class="ksg-unit">% 以上才放技能</span></div>
                <div class="ksg-adv-row"><label>攻击距离</label><input class="ksg-mini" id="ksgDist" value="1" /><span class="ksg-unit">格</span></div>
                <p class="ksg-adv-note">技能等级按该技能的满级写入，已逐条核对技能库；需要时可在生成的 config.txt 里改 lvl。</p>
              </div>
              <div class="ksg-adv-col">
                <h3>生存数值</h3>
                <div class="ksg-adv-row"><label>瞬移 HP</label><input class="ksg-mini" id="ksgTpHp" value="25" /><span class="ksg-unit">%</span></div>
                <div class="ksg-adv-row"><label>被围</label><input class="ksg-mini" id="ksgTpAggr" value="3" /><span class="ksg-unit">只即飞</span></div>
                <div class="ksg-adv-row"><label>喝药 HP</label><input class="ksg-mini" id="ksgPotHp" value="60" /><span class="ksg-unit">%</span></div>
                <div class="ksg-adv-row"><label>坐下 HP</label><input class="ksg-mini" id="ksgSitLo" value="40" /><span class="ksg-unit">% ~</span><input class="ksg-mini" id="ksgSitHi" value="90" /><span class="ksg-unit">%</span></div>
                <div class="ksg-adv-row"><label>坐下 SP</label><input class="ksg-mini" id="ksgSitSpLo" value="15" /><span class="ksg-unit">% ~</span><input class="ksg-mini" id="ksgSitSpHi" value="80" /><span class="ksg-unit">%（0 = 不按 SP 坐下）</span></div>
                <div class="ksg-adv-row"><label>跟随队长</label><input type="checkbox" id="ksgFollow" /><input class="ksg-mini" id="ksgFollowTarget" placeholder="玩家名" style="width:120px" /></div>
              </div>
              <div class="ksg-adv-col">
                <h3>补给与 NPC</h3>
                <div class="ksg-adv-row"><label>负重回城</label><input class="ksg-mini" id="ksgTownWeight" value="70" /><span class="ksg-unit">%</span></div>
                <div class="ksg-adv-row"><label>卖店 NPC</label><input class="ksg-mini ksg-mini-wide" id="ksgSellNpc" value="prontera 105 87" /></div>
                <div class="ksg-adv-row"><label>仓库 NPC</label><input class="ksg-mini ksg-mini-wide" id="ksgStoreNpc" value="prontera 146 89" /></div>
                <p class="ksg-adv-note">普隆德拉默认坐标；换城市再改这里。猎人箭矢走 prt_in 162 135，药水不自动买，喝背包里现有的。</p>
              </div>
            </div>

            <div class="ksg-item-block">
              <h3>物品精细化 · 本图掉落</h3>
              <p>每个物品两项：<b>拾取规则</b>写 pickupitems.txt，<b>最终处理</b>写 items_control.txt。下表列出全图所有怪物的全部常规掉落。</p>
              <div class="ksg-item-scroll">
                <table class="ksg-item-tbl">
                  <thead><tr><th style="width:30%">物品</th><th style="width:26%">拾取规则</th><th style="width:24%">最终处理</th><th>最终结果</th></tr></thead>
                  <tbody id="ksgItemRows"></tbody>
                </table>
              </div>
              <p class="ksg-hint" id="ksgItemRest">…</p>

              <div class="ksg-fixed">
                <b>固定规则（每次都会写入，保护新手装备）</b>
                <p></p>
                <code>魔法箭矢筒 1 0 0
魔法苍蝇翅膀 1 0 0
坐骑缰绳 1 0 0
乐园团* 1 0 0
伊甸园* 1 0 0
*卡片 0 1 0
# pickupitems.txt
*卡片 2</code>
              </div>
            </div>
          </details>
        </div>

        <section class="ksg-jobgrid" id="ksgJobGrid" hidden></section>
      </div>
    </main>

    ${footerMarkup()}

    <div class="ksg-dock" id="ksgDock">
      <div class="ksg-wrap ksg-dock-in">
        <div class="ksg-dock-info">
          <b>生成 5 个配置文件</b>
          <small>config.txt · mon_control.txt · pickupitems.txt · items_control.txt · timeouts.txt</small>
        </div>
        <div class="ksg-dock-btns">
          <button class="ksg-primary" id="ksgSaveBtn" type="button">保存并激活</button>
        </div>
      </div>
    </div>

    <div class="ksg-modal" id="ksgModal" hidden>
      <div class="ksg-modal-box">
        <div class="ksg-modal-head">
          <h3>生成的配置预览</h3>
          <small id="ksgModalJob">…</small>
          <button class="ksg-modal-close" id="ksgModalClose" type="button">×</button>
        </div>
        <div class="ksg-tabs" id="ksgTabs">
          <button class="ksg-tab" data-file="config" type="button">config.txt</button>
          <button class="ksg-tab" data-file="mon" type="button">mon_control.txt</button>
          <button class="ksg-tab" data-file="pickup" type="button">pickupitems.txt</button>
          <button class="ksg-tab" data-file="items" type="button">items_control.txt</button>
          <button class="ksg-tab" data-file="timeouts" type="button">timeouts.txt</button>
        </div>
        <div class="ksg-code-wrap"><pre class="ksg-code" id="ksgCode"></pre></div>
        <div class="ksg-modal-foot">
          <span>预览内容与保存写入完全一致（不含 # 注释行）。</span>
          <button class="ksg-primary" id="ksgModalSave" type="button">保存并激活</button>
        </div>
      </div>
    </div>
  </div>`;
}

export function mountKeSetupGuidePage(root: HTMLElement): void {
  document.title = "萌新一键配置 · 露天商店.Ro";
  root.innerHTML = pageMarkup();
  mountSiteNav(root);
  injectLegalLinksIntoFooters(root);

  const stateEl = root.querySelector<HTMLElement>("#ksgState")!;
  const cardsEl = root.querySelector<HTMLElement>("#ksgCards")!;
  const charCard = root.querySelector<HTMLElement>("#ksgCharCard")!;
  const dock = root.querySelector<HTMLElement>("#ksgDock")!;
  const jobGridEl = root.querySelector<HTMLElement>("#ksgJobGrid")!;
  const modal = root.querySelector<HTMLElement>("#ksgModal")!;
  const codeEl = root.querySelector<HTMLElement>("#ksgCode")!;
  const jobSwitch = root.querySelector<HTMLElement>("#ksgJobSwitch")!;
  const jobFixed = root.querySelector<HTMLElement>("#ksgJobFixed")!;

  const $ = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
  const $$ = (sel: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel));
  const inputVal = (sel: string): string => $<HTMLInputElement>(sel)?.value.trim() ?? "";

  let demo = false;
  let character: KeCharacter | null = null;
  let options: KeOptionsLite | null = null;
  let mapMobs: MapMobsData | null = null;
  let skillTypes: SkillTypesFile | null = null;
  let mapNames: Record<string, string> = {};
  let JOBS: Record<string, JobData> = FALLBACK_JOBS;
  let jobList: string[] = Object.keys(FALLBACK_JOBS);
  let seriesList: JobSeriesOption[] = Object.keys(FALLBACK_JOBS).map((id) => ({
    key: id, name: FALLBACK_JOBS[id]!.name, jobId: id, capped: false,
  }));
  let currentFile = "config";
  let saving = false;

  const state = {
    job: "",
    map: "",
    hunt: "walk" as HuntMode,
    tpMode: "item" as TpMode,
    on: { attack: true, basic: true, potion: true, wing: true, loot: true, mount: true } as Record<SwitchKey, boolean>,
    atk: new Map<string, boolean>(),
    buff: new Map<string, boolean>(),
    scope: new Map<string, "all" | "pick">(),
    picks: new Map<string, Set<string>>(),
    rules: new Map<string, ItemRule>(),
    adv: {
      sp: 20, dist: 1, potHp: 60, tpHp: 25, tpAggr: 3,
      sitLo: 40, sitHi: 90, sitSpLo: 15, sitSpHi: 80, townWeight: 70,
      sellNpc: "prontera 105 87", storeNpc: "prontera 146 89",
      follow: false, followTarget: "",
    } as AdvState,
  };

  // —— options.json 索引 ——
  const skillIdsByName = new Map<string, number[]>();
  const skillOptByName = new Map<string, SkillOpt>();
  const maxByName = new Map<string, number>();
  const statusHandleByKey = new Map<string, string>();
  const statusHandleByNorm = new Map<string, string>();
  const monsterById = new Map<number, string>();
  const itemById = new Map<number, string>();

  function buildIndexes(): void {
    for (const sk of options?.skills ?? []) {
      const max = maxLvlOfHandle(sk.handle);
      if (sk.nameZh) maxByName.set(sk.nameZh, max ?? 10);
      if (sk.name) maxByName.set(sk.name, max ?? 10);
      if (sk.handle) maxByName.set(sk.handle, max ?? 10);
      // 同名技能可能有多个 ID（如 挑衅 6=玩家技能 / 8232=佣兵技能），全部记下来再按当前职业挑选。
      for (const alias of [sk.nameZh, sk.name, sk.handle]) {
        if (!alias) continue;
        const ids = skillIdsByName.get(alias) ?? [];
        ids.push(sk.id);
        skillIdsByName.set(alias, ids);
      }
      if (sk.nameZh) skillOptByName.set(sk.nameZh, sk);
      if (sk.name) skillOptByName.set(sk.name, sk);
      if (sk.handle) skillOptByName.set(sk.handle, sk);
    }
    const norm = (h: string): string => h.toUpperCase().replace(/^EFST_/u, "").replace(/_/gu, "");
    for (const st of options?.statuses ?? []) {
      if (!st.handle) continue;
      if (st.nameZh) statusHandleByKey.set(st.nameZh, st.handle);
      if (st.name) statusHandleByKey.set(st.name.toLowerCase(), st.handle);
      statusHandleByKey.set(st.handle.toUpperCase(), st.handle);
      statusHandleByNorm.set(norm(st.handle), st.handle);
    }
    for (const m of options?.monsters ?? []) monsterById.set(m.id, m.name);
    for (const it of options?.items ?? []) itemById.set(it.id, it.name);
  }

  const selectorOf = (name: string): string => {
    const ids = skillIdsByName.get(name);
    if (ids && ids.length > 0) {
      // 优先用当前职业技能表里的 ID，避免把佣兵/怪物版同名技能写进配置。
      const own = new Set(options?.job_skills?.[state.job] ?? []);
      const hit = ids.find((id) => own.has(id));
      if (hit !== undefined) return String(hit);
      return String(ids[0]);
    }
    return name;
  };
  const skillMaxLv = (name: string): number => {
    // 狂蓄气在技能库里只有 1 级；表里查不到时也要按 1 级写。
    if (/狂蓄气/u.test(name)) return 1;
    return maxByName.get(name) ?? 10;
  };
  const statusHandleForSkill = (name: string): string | undefined => {
    const direct =
      statusHandleByKey.get(name) ??
      statusHandleByKey.get(name.toLowerCase()) ??
      statusHandleByKey.get(name.toUpperCase());
    if (direct) return direct;
    const sk = skillOptByName.get(name);
    if (!sk?.handle) return undefined;
    const norm = (h: string): string => h.toUpperCase().replace(/^EFST_/u, "").replace(/_/gu, "");
    return statusHandleByNorm.get(norm(sk.handle)) ?? statusHandleByNorm.get(norm(sk.handle.split("_").slice(1).join("_")));
  };

  const jobData = (): JobData =>
    JOBS[state.job] ?? {
      name: "未知职业", ranged: false, surv: "melee", mount: false, mountSkill: false, basic: false, atk: [], aux: [],
    };

  function attackSkills(): AtkSkill[] {
    return jobData().atk.map((name) => {
      const lv = skillMaxLv(name);
      const hint = SKILL_SPECIALS[name]?.hint;
      return { name, id: selectorOf(name), lv, elem: elemOf(name), ...(hint ? { hint } : {}) };
    });
  }
  function baseConds(cat: AuxCat, name: string): Cond[] {
    if (cat === "buff") {
      const handle = statusHandleForSkill(name);
      return handle
        ? [{ k: "whenStatusInactive", v: handle }, { k: "timeout", v: "10" }]
        : [{ k: "timeout", v: "10" }];
    }
    if (cat === "ground") return [{ k: "whenNotGround", v: name }, { k: "timeout", v: "3" }];
    if (cat === "heal") return [{ k: "hp", v: "< 70%" }, { k: "timeout", v: "1" }];
    return [{ k: "hp", v: "< 40%" }, { k: "aggressives", v: ">= 2" }];
  }
  function auxConditions(name: string, cat: AuxCat): Cond[] {
    const special = SKILL_SPECIALS[name];
    // 痊愈术要按状态拆成多个块，卡片上先展示第一组（真正的生成逻辑在 buildConfigDoc）。
    if (special?.selfConds) return special.selfConds;
    if (special?.selfStatusConds?.[0]) return special.selfStatusConds[0];
    const preset = presetOf(name);
    const scoped = preset?.scopes.self;
    if (scoped?.conds) {
      return scoped.conds.flatMap((cond): Cond[] => {
        const value = cond.v === "%NAME%" ? statusHandleForSkill(name) : cond.v;
        return value === undefined ? [] : [{ k: cond.k, v: value }];
      });
    }
    return baseConds(cat, name);
  }
  function buffSkills(): BuffSkill[] {
    return jobData().aux.map((a) => {
      const conds = auxConditions(a.n, a.c);
      const spirit = conds.find((c) => c.k === "spirit");
      const hp = conds.find((c) => c.k === "hp");
      const inactive = conds.find((c) => c.k === "whenStatusInactive");
      const ground = conds.find((c) => c.k === "whenNotGround");
      const timeout = conds.find((c) => c.k === "timeout");
      let hint = "状态消失就补";
      if (spirit) hint = `气少于 ${spirit.v.replace(/^<\s*/u, "")} 就补`;
      else if (hp) hint = `HP ${hp.v} 时用`;
      else if (inactive) hint = "状态消失就补";
      else if (ground) hint = "地面技能不在场就放";
      else if (timeout) hint = `每 ${timeout.v} 秒检查`;
      // 特殊技能的打法说明优先于通用条件文案（解毒/痊愈术/复活术等）。
      const specialHint = SKILL_SPECIALS[a.n]?.hint;
      if (specialHint) hint = specialHint;
      return { name: a.n, id: selectorOf(a.n), lv: skillMaxLv(a.n), cat: a.c, conds, hint };
    });
  }

  function mapEntry(): MapMobsEntry | null {
    return mapMobs?.maps[state.map] ?? null;
  }
  function uniqueNames(ids: number[], index: Map<number, string>, prefix: string): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const name = index.get(id) ?? `${prefix} ${id}`;
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }
  const mobNames = (): string[] => uniqueNames(mapEntry()?.mobs ?? [], monsterById, "怪物");
  const dropNames = (): string[] => uniqueNames(mapEntry()?.drops ?? [], itemById, "物品");
  const mapLabel = (): string =>
    mapNames[state.map] ? `${state.map} · ${mapNames[state.map]}` : state.map || "未选择";

  function ensureRules(): void {
    for (const name of dropNames()) {
      if (state.rules.has(name)) continue;
      const handle: HandleMode = SELF_USE_ITEMS.has(name) || /药水/u.test(name) ? "keep" : "store";
      state.rules.set(name, { pick: "yes", handle });
    }
  }

  function initSkillState(): void {
    const atks = attackSkills();
    state.atk.clear();
    state.buff.clear();
    state.scope.clear();
    state.picks.clear();
    // 所有技能默认都不勾选：用户自己在攻击/辅助列表里勾（勾完立即反映到生成的配置）。
    for (const s of atks) {
      state.scope.set(s.name, "all");
      state.picks.set(s.name, new Set());
    }
    state.adv.dist = jobData().ranged ? 9 : 1;
    state.on.basic = jobData().basic;
    const dist = $<HTMLInputElement>("#ksgDist");
    if (dist) dist.value = String(state.adv.dist);
    const count = $("#ksgJobCount");
    if (count && seriesList.length) count.textContent = String(seriesList.length);
  }

  function advNumber(sel: string, fallback: number): number {
    const value = Number(inputVal(sel));
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
  }
  function syncAdvanced(): void {
    state.adv.sp = advNumber("#ksgSp", 20);
    state.adv.dist = advNumber("#ksgDist", jobData().ranged ? 9 : 1);
    state.adv.potHp = advNumber("#ksgPotHp", 60);
    state.adv.tpHp = advNumber("#ksgTpHp", 25);
    state.adv.tpAggr = advNumber("#ksgTpAggr", 3);
    state.adv.sitLo = advNumber("#ksgSitLo", 40);
    state.adv.sitHi = advNumber("#ksgSitHi", 90);
    state.adv.sitSpLo = advNumber("#ksgSitSpLo", 15);
    state.adv.sitSpHi = advNumber("#ksgSitSpHi", 80);
    state.adv.townWeight = advNumber("#ksgTownWeight", 70);
    state.adv.sellNpc = inputVal("#ksgSellNpc") || "prontera 105 87";
    state.adv.storeNpc = inputVal("#ksgStoreNpc") || "prontera 146 89";
    state.adv.follow = $<HTMLInputElement>("#ksgFollow")?.checked ?? false;
    state.adv.followTarget = inputVal("#ksgFollowTarget");
  }

  /* ========== 渲染 ========== */

  function renderJobCard(): void {
    const job = jobData();
    const avatar = $("#ksgAvatar");
    if (avatar) avatar.textContent = job.name.slice(0, 1) || "?";
    const name = $("#ksgCharName");
    if (name) name.textContent = character?.char_name ?? "测试角色";
    const badge = $("#ksgCharBadge");
    if (badge) badge.textContent = demo ? "演示模式" : "已绑定";
    const meta = $("#ksgJobMeta");
    if (meta) {
      const cap = serverCapOf(character?.nid);
      const clamped = character?.job_id !== null && character?.job_id !== undefined
        ? clampJobForNid(character.job_id, character.nid)
        : null;
      const rawName = clamped ? JOBS[String(character?.job_id)]?.name ?? String(character?.job_id) : "";
      const serverTxt = cap.label ? ` · ${cap.label}` : "";
      const cutTxt = clamped?.capped ? ` · 已从 ${rawName} 截断` : "";
      meta.textContent = `${job.name}${serverTxt}${cutTxt} · 上次挂机 ${character?.map_name?.trim() || state.map || "—"} · 已按职业与当前地图预填`;
    }
    const fixed = $("#ksgJobName");
    if (fixed) fixed.textContent = job.name;
  }

  function renderMap(): void {
    const nameEl = $("#ksgMapName");
    if (nameEl) nameEl.textContent = mapLabel();
    const hint = $("#ksgMapHint");
    if (!hint) return;
    if (!mapMobs) {
      hint.textContent = "正在读取地图数据…";
      return;
    }
    const m = mapEntry();
    if (!m) {
      hint.innerHTML = `这张图没有怪物数据（城镇或副本）。<b>点上面的世界地图换一张有怪的地图。</b>`;
      return;
    }
    hint.innerHTML = `本图 <b>${mobNames().length}</b> 种怪、<b>${dropNames().length}</b> 种掉落；回城点固定普隆德拉，卖店 / 仓库 / 买药坐标用内置默认值。`;
  }

  function renderHunt(): void {
    for (const btn of $$("#ksgHuntSeg .ksg-seg-btn")) {
      btn.classList.toggle("on", btn.getAttribute("data-hunt") === state.hunt);
    }
    const wrap = $("#ksgTpWrap");
    if (wrap) {
      if (state.hunt === "walk") {
        wrap.innerHTML = "";
      } else {
        wrap.innerHTML = `<div class="ksg-seg-row">
          <p>瞬移方式</p>
          <div class="ksg-seg">
            <button class="ksg-seg-btn ${state.tpMode === "item" ? "on" : ""}" data-tp="item" type="button"><b>用道具</b><small>优先魔法苍蝇翅膀，没有就退回普通苍蝇翅膀</small></button>
            <button class="ksg-seg-btn ${state.tpMode === "skill" ? "on" : ""}" data-tp="skill" type="button"><b>用技能</b><small>瞬间移动，任何职业戴克瑞米卡片都能用</small></button>
          </div>
        </div>`;
      }
    }
    const hint = $("#ksgHuntHint");
    if (hint) {
      hint.textContent = state.hunt === "walk"
        ? "走路寻怪：随机走动覆盖全图，空闲不瞬移。"
        : state.tpMode === "item"
          ? "瞬移寻怪 · 用道具：背包里的魔法苍蝇翅膀先用，用光了再退回普通苍蝇翅膀。"
          : "瞬移寻怪 · 用技能：按瞬间移动技能飞，不按职业判断有没有这个技能。";
    }
  }

  function detailOf(key: SwitchKey): string {
    if (key === "attack") {
      const list = attackSkills().filter((s) => state.atk.get(s.name));
      return list.length ? `已勾选 <b>${list.length}</b> 条技能` : "未勾选技能 · 只用武器普攻";
    }
    if (key === "basic") {
      if (!state.on.attack) return "自动打怪关闭时不生效";
      return state.on.basic ? "打怪时用武器普攻补伤害" : "只放勾选的技能，不普攻";
    }
    if (key === "potion") return `HP &lt; <b>${state.adv.potHp}%</b> 时喝药，内置 <b>${POTIONS.length}</b> 种回血物品`;
    if (key === "wing") return `HP &lt; <b>${state.adv.tpHp}%</b> 或被 <b>${state.adv.tpAggr}</b> 只围攻时飞走`;
    if (key === "loot") return `负重 <b>${state.adv.townWeight}%</b> 回城，卖店 / 存仓在普隆德拉`;
    if (key === "mount") return "有坐骑缰绳就上马，没道具时自动跳过";
    return "";
  }

  function renderSwitches(): void {
    const grid = $("#ksgSwitches");
    if (!grid) return;
    grid.innerHTML = SWITCHES.map((sw) => {
      const on = state.on[sw.key];
      return `<label class="ksg-sw ${on ? "is-on" : "is-off"}" data-key="${sw.key}">
        <div class="ksg-sw-top">
          <span class="ksg-ic">${ICONS[sw.key]}</span>
          <span class="ksg-sw-name">${sw.name}</span>
          <span class="ksg-tgl"><input type="checkbox" ${on ? "checked" : ""}><span class="ksg-track"><span class="ksg-knob"></span></span></span>
        </div>
        <p class="ksg-sw-desc">${sw.desc}</p>
        <p class="ksg-sw-detail">${detailOf(sw.key)}</p>
      </label>`;
    }).join("");
    for (const input of $$("#ksgSwitches input[type=checkbox]")) {
      input.addEventListener("change", () => {
        const key = input.closest<HTMLElement>(".ksg-sw")?.getAttribute("data-key") as SwitchKey | null;
        if (!key) return;
        state.on[key] = (input as HTMLInputElement).checked;
        renderSwitches();
        renderOutput();
        if (!modal.hidden) renderCode();
      });
    }
  }

  function renderAtk(): void {
    const list = $("#ksgAtkList");
    if (!list) return;
    const skills = attackSkills();
    list.innerHTML = skills.length
      ? skills.map((sk) => `<div class="ksg-sk ${state.atk.get(sk.name) ? "on" : ""}" data-id="${esc(sk.name)}" tabindex="0" role="checkbox" aria-checked="${state.atk.get(sk.name) ? "true" : "false"}">
        <span class="ksg-box"></span>
        <span class="ksg-sk-main">
          <span class="ksg-sk-name">${esc(sk.name)}</span>
          <span class="ksg-sk-meta">Lv ${sk.lv}${isAoeSkill(sk.name) ? " · AOE · 围攻≥2" : ""}${sk.hint ? ` · ${esc(sk.hint)}` : ""}</span>
        </span>
        <span class="ksg-elem ksg-${sk.elem}">${ELEM_LABEL[sk.elem]}</span>
      </div>`).join("")
      : `<p class="ksg-hint" style="margin:0">该流派以武器普攻为主，不需要主动技能。</p>`;
    for (const row of $$("#ksgAtkList .ksg-sk")) {
      const toggle = (): void => {
        const id = row.getAttribute("data-id") ?? "";
        state.atk.set(id, !state.atk.get(id));
        renderAtk();
        renderElemPanel();
        renderOutput();
        if (!modal.hidden) renderCode();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    }
  }

  function renderElemPanel(): void {
    const panel = $("#ksgElemPanel");
    if (!panel) return;
    const selected = attackSkills().filter((s) => state.atk.get(s.name));
    if (!selected.length) {
      panel.innerHTML = "";
      return;
    }
    const mobs = mobNames();
    panel.innerHTML = `<div class="ksg-elem-panel">
      <b>按怪物分工（可选）</b>
      <p>不选就是所有怪都用；选中后只对下面点名的怪使用。怪名来自 ${esc(state.map)}。</p>
      ${selected.map((sk) => {
        const mode = state.scope.get(sk.name) ?? "all";
        const picked = state.picks.get(sk.name) ?? new Set<string>();
        return `<div class="ksg-elem-row">
          <span>${esc(sk.name)} <em>${ELEM_LABEL[sk.elem]}</em></span>
          <select data-id="${esc(sk.name)}" data-role="scope">
            <option value="all" ${mode === "all" ? "selected" : ""}>所有怪</option>
            <option value="pick" ${mode === "pick" ? "selected" : ""}>只打指定的怪</option>
          </select>
        </div>
        ${mode === "pick" ? `<div class="ksg-mob-chips">${mobs.map((n) => `<button class="ksg-mob-chip ${picked.has(n) ? "on" : ""}" data-id="${esc(sk.name)}" data-mob="${esc(n)}" type="button">${esc(n)}</button>`).join("")}</div>` : ""}`;
      }).join("")}
    </div>`;
    for (const sel of $$('#ksgElemPanel select[data-role=scope]')) {
      sel.addEventListener("change", () => {
        const id = sel.getAttribute("data-id") ?? "";
        state.scope.set(id, (sel as HTMLSelectElement).value as "all" | "pick");
        renderElemPanel();
        renderOutput();
        if (!modal.hidden) renderCode();
      });
    }
    for (const chip of $$("#ksgElemPanel .ksg-mob-chip")) {
      chip.addEventListener("click", () => {
        const id = chip.getAttribute("data-id") ?? "";
        const name = chip.getAttribute("data-mob") ?? "";
        const set = state.picks.get(id) ?? new Set<string>();
        state.picks.set(id, set);
        if (set.has(name)) set.delete(name);
        else set.add(name);
        renderElemPanel();
        renderOutput();
        if (!modal.hidden) renderCode();
      });
    }
  }

  function renderBuffs(): void {
    const list = $("#ksgBuffList");
    if (!list) return;
    const skills = buffSkills();
    list.innerHTML = skills.length
      ? skills.map((sk) => `<div class="ksg-sk ${state.buff.get(sk.name) ? "on" : ""}" data-id="${esc(sk.name)}" tabindex="0" role="checkbox" aria-checked="${state.buff.get(sk.name) ? "true" : "false"}">
        <span class="ksg-box"></span>
        <span class="ksg-sk-main">
          <span class="ksg-sk-name">${esc(sk.name)}</span>
          <span class="ksg-sk-meta">Lv ${sk.lv} · ${esc(sk.hint)}</span>
        </span>
        <span class="ksg-elem ksg-phys">${CAT_LABEL[sk.cat]}</span>
      </div>`).join("")
      : `<p class="ksg-hint" style="margin:0">该流派没有需要常驻的 buff。</p>`;
    for (const row of $$("#ksgBuffList .ksg-sk")) {
      const toggle = (): void => {
        const id = row.getAttribute("data-id") ?? "";
        state.buff.set(id, !state.buff.get(id));
        renderBuffs();
        renderOutput();
        if (!modal.hidden) renderCode();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    }
  }

  function itemEffect(rule: ItemRule): string {
    if (rule.pick === "no") return "不捡";
    if (rule.pick === "drop") return "不捡，进包就丢";
    if (rule.handle === "store") return "捡起，超量存仓";
    if (rule.handle === "sell") return "捡起，超量卖店";
    return "捡起，留在背包";
  }

  function renderItems(): void {
    ensureRules();
    const body = $("#ksgItemRows");
    if (!body) return;
    const drops = dropNames();
    const pickModes: [PickMode, string][] = [["yes", "拾取"], ["no", "不捡"], ["drop", "不捡并丢掉"]];
    const handleModes: [HandleMode, string][] = [["keep", "保留"], ["store", "存仓"], ["sell", "卖店"]];
    body.innerHTML = drops.map((name) => {
      const rule = state.rules.get(name) ?? { pick: "yes", handle: "store" };
      return `<tr>
        <td>${esc(name)}</td>
        <td><select data-item="${esc(name)}" data-role="pick">${pickModes.map(([k, v]) => `<option value="${k}" ${rule.pick === k ? "selected" : ""}>${v}</option>`).join("")}</select></td>
        <td><select data-item="${esc(name)}" data-role="handle" ${rule.pick === "no" || rule.pick === "drop" ? "disabled" : ""}>${handleModes.map(([k, v]) => `<option value="${k}" ${rule.handle === k ? "selected" : ""}>${v}</option>`).join("")}</select></td>
        <td class="ksg-effect">${itemEffect(rule)}</td>
      </tr>`;
    }).join("");
    const rest = $("#ksgItemRest");
    if (rest) {
      rest.textContent = drops.length === 0
        ? "这张图没有掉落数据。"
        : `共 ${drops.length} 种掉落（遍历本图所有怪物的全部常规掉落），全部列在上表；默认“捡 + 存仓”，可按需逐条调整。`;
    }
    for (const sel of $$("#ksgItemRows select")) {
      sel.addEventListener("change", () => {
        const name = sel.getAttribute("data-item") ?? "";
        const role = sel.getAttribute("data-role");
        const rule = state.rules.get(name) ?? { pick: "yes", handle: "store" };
        if (role === "pick") rule.pick = (sel as HTMLSelectElement).value as PickMode;
        else rule.handle = (sel as HTMLSelectElement).value as HandleMode;
        state.rules.set(name, rule);
        renderItems();
        renderOutput();
        if (!modal.hidden) renderCode();
      });
    }
  }

  function chip(label: string, value: string, on = true): string {
    return `<span class="ksg-chip ${on ? "" : "off"}"><span class="ksg-dot"></span>${label} <b>${esc(value)}</b></span>`;
  }

  function renderOutput(): void {
    const job = jobData();
    const atk = attackSkills().filter((s) => state.atk.get(s.name));
    const buffs = buffSkills().filter((s) => state.buff.get(s.name));
    const chips = [
      chip("寻怪", state.hunt === "walk" ? "走路" : state.tpMode === "item" ? "瞬移·道具" : "瞬移·技能", true),
      chip("攻击", state.on.attack ? "主动打怪" : "不打怪", state.on.attack),
      chip("攻击技能", `${atk.length} 条`, state.on.attack && atk.length > 0),
      chip("普攻", state.on.basic ? "使用武器" : "只用技能", state.on.attack && state.on.basic),
      chip("buff", `${buffs.length} 条`, buffs.length > 0),
      chip("喝药", `${POTIONS.length} 种`, state.on.potion),
      chip("瞬移", state.tpMode === "skill" ? "瞬间移动" : "苍蝇翅膀", state.on.wing),
      chip("坐骑", MOUNT_ITEM, state.on.mount),
      chip("拾取", `${dropNames().length} 种掉落`, state.on.loot),
      chip("回城", "普隆德拉 · 卖店 + 存仓", state.on.loot),
    ];
    if (job.ranged) chips.push(chip("买箭", `${ARROW_ITEM} 10000 支`, state.on.loot));
    const wrap = $("#ksgChips");
    if (wrap) wrap.innerHTML = chips.join("");
    const out = $("#ksgOutCount");
    if (out) out.textContent = `${chips.filter((c) => !c.includes("off")).length} 组配置 · 5 个文件`;
    const count = $("#ksgSkillCount");
    if (count) count.textContent = `攻击 ${atk.length} 条 · buff ${buffs.length} 条`;
    const modalJob = $("#ksgModalJob");
    if (modalJob) modalJob.textContent = `${job.name} · ${state.map}`;
  }

  /* ========== 配置生成 ========== */

  function buildConfigDoc(): ConfigDoc {
    const doc = defaultDoc();
    const s = doc.scalars;
    const job = jobData();
    const on = state.on;

    s["lockMap"] = state.map;
    s["saveMap"] = "prontera";
    s["route_randomWalk"] = state.hunt === "walk" ? "2" : "0";
    s["teleportAuto_idle"] = state.hunt === "walk" ? "0" : "1";
    s["attackAuto"] = on.attack ? "2" : "0";
    s["attackUseWeapon"] = on.attack && on.basic ? "1" : "0";
    s["attackDistance"] = String(state.adv.dist || (job.ranged ? 9 : 1));
    if (job.ranged) s["attackEquip_arrow"] = ARROW_ITEM;
    // 默认可以抢怪：antiKS 0 = 不避开别人正在打的怪（1 才是不抢怪）。
    s["antiKS"] = "0";

    s["teleportAuto_hp"] = on.wing ? String(state.adv.tpHp) : "0";
    s["teleportAuto_minAggressives"] = on.wing ? String(state.adv.tpAggr) : "0";
    s["teleportAuto_maxDmg"] = "0";
    // 物品瞬移 / 技能瞬移只由 teleportAuto_useSkill 决定（0=道具，非 0=技能）。
    // teleportAuto_item1 保持留空：KE 会按内置顺序自动挑道具（魔法苍蝇翅膀 → 苍蝇翅膀 …）。
    s["teleportAuto_useSkill"] = state.tpMode === "skill" ? "1" : "0";

    s["sitAuto_hp_lower"] = String(state.adv.sitLo);
    s["sitAuto_hp_upper"] = String(state.adv.sitHi);
    s["sitAuto_sp_lower"] = String(state.adv.sitSpLo);
    s["sitAuto_sp_upper"] = String(state.adv.sitSpHi);

    s["follow"] = state.adv.follow ? "1" : "0";
    s["attackAuto_followTarget"] = state.adv.follow ? "1" : "0";
    if (state.adv.follow && state.adv.followTarget) {
      s["followTarget"] = state.adv.followTarget;
      s["followDistanceMax"] = "6";
    }

    s["itemsTakeAuto"] = on.loot ? "2" : "0";
    s["itemsGatherAuto"] = "0";
    s["itemsTakeAuto_party"] = "0";
    s["itemsMaxWeight"] = "89";
    if (on.loot) {
      s["itemsMaxWeight_sellOrStore"] = String(state.adv.townWeight);
      s["sellAuto"] = "1";
      s["storageAuto"] = "1";
      s["sellAuto_npc"] = state.adv.sellNpc || "prontera 105 87";
      s["storageAuto_npc"] = state.adv.storeNpc || "prontera 146 89";
    } else {
      s["itemsMaxWeight_sellOrStore"] = "0";
      s["sellAuto"] = "0";
      s["storageAuto"] = "0";
    }

    const blocks: Record<string, BlockValue[]> = {};

    if (on.attack) {
      const atk: BlockValue[] = [];
      for (const sk of attackSkills()) {
        if (!state.atk.get(sk.name)) continue;
        const special = SKILL_SPECIALS[sk.name];
        // 特殊技能的固定字段（挑衅 maxUses 1、弹指神通 maxDist 9）与攻击技本身一起写死。
        const fields: Record<string, string> = { lvl: String(sk.lv), ...(special?.atkFields ?? {}) };
        const conditions: Record<string, string> = {};
        if (state.adv.sp > 0) conditions["sp"] = `> ${state.adv.sp}%`;
        // AOE 技能是被围住时的解围技：怪物 >= 2 才放；锐利射击等单体向技能不加。
        if (isAoeSkill(sk.name)) conditions["aggressives"] = ">= 2";
        // 特殊目标条件（天使之怒只要没标记的怪、弹指神通要气弹）。
        Object.assign(conditions, special?.atkConds ?? {});
        const mode = state.scope.get(sk.name) ?? "all";
        const picked = Array.from(state.picks.get(sk.name) ?? []);
        if (mode === "pick" && picked.length > 0) fields["monsters"] = picked.join(", ");
        atk.push({ selector: sk.id, fields, conditions });
      }
      if (atk.length) blocks["attackSkillSlot"] = atk;
    }

    const selfBlocks: BlockValue[] = [];
    const partyBlocks: BlockValue[] = [];
    for (const sk of buffSkills()) {
      if (!state.buff.get(sk.name)) continue;
      const special = SKILL_SPECIALS[sk.name];
      const fields = { lvl: String(sk.lv) };
      if (!special?.partyOnly) {
        if (special?.selfStatusConds?.length) {
          // KE 条件之间是「且」，痊愈术按可解除的状态拆成多个块。
          for (const conds of special.selfStatusConds) {
            const conditions: Record<string, string> = {};
            for (const c of conds) conditions[c.k] = c.v;
            selfBlocks.push({ selector: sk.id, fields, conditions });
          }
        } else {
          const conditions: Record<string, string> = {};
          for (const c of sk.conds) conditions[c.k] = c.v;
          selfBlocks.push({ selector: sk.id, fields, conditions });
        }
      }
      if (special?.partyConds) {
        // %NAME% 用技能自身的状态名；查不到状态就不生成队友块，避免无状态条件乱放。
        const needStatus = special.partyConds.some((c) => c.v === "%NAME%");
        const status = statusHandleForSkill(sk.name);
        if (needStatus && status === undefined) continue;
        const conditions: Record<string, string> = {};
        for (const c of special.partyConds) {
          conditions[c.k] = c.v === "%NAME%" ? (status as string) : c.v;
        }
        partyBlocks.push({ selector: sk.id, fields, conditions });
      }
    }
    if (selfBlocks.length) blocks["useSelf_skill"] = selfBlocks;
    if (partyBlocks.length) blocks["partySkill"] = partyBlocks;

    const itemBlocks: BlockValue[] = [];
    if (on.potion) {
      itemBlocks.push({
        selector: POTIONS.join(","),
        fields: {},
        conditions: { hp: `< ${state.adv.potHp}%` },
      });
    }
    if (on.mount) {
      // KE 没有 whenNotMounted；上马判断用坐骑状态 EFST_ALL_RIDING，2 秒冷却避免连续使用。
      itemBlocks.push({
        selector: MOUNT_ITEM,
        fields: {},
        conditions: { whenStatusInactive: "EFST_ALL_RIDING", timeout: "2" },
      });
    }
    if (job.ranged) {
      itemBlocks.push({
        selector: AMMO_BOX,
        fields: {},
        conditions: { inInventory: `${ARROW_ITEM} < 100` },
      });
    }
    if (itemBlocks.length) blocks["useSelf_item"] = itemBlocks;

    // 不自动买药：只给远程职业补箭矢（其余补给靠背包里现有的药水）。
    if (on.loot && job.ranged) {
      blocks["buyAuto"] = [{
        selector: ARROW_ITEM,
        fields: {
          npc: "prt_in 162 135",
          npc_steps: "r0",
          distance: "3",
          price: "1",
          minAmount: "0",
          maxAmount: "10000",
          batchSize: "10000",
        },
        conditions: {},
      }];
    }

    doc.blocks = blocks;
    return doc;
  }

  function buildControlDoc(): ControlDoc {
    const doc = defaultControlDoc();
    ensureRules();

    const monSchema = CONTROL_SCHEMAS.find((x) => x.file === "mon_control.txt")!;
    // MVP 不写具名行（否则 attack_auto 2 / teleport_auto 0 会盖过 all_mvp），交给 all_mvp 见到就飞；
    // 草类也不写攻击行，默认由 mon_control 预设里的「忽略」行处理。
    const mvpNames = new Set(mapEntry()?.mvp ? uniqueNames(mapEntry()!.mvp!, monsterById, "怪物") : []);
    const monRows: ControlRow[] = mobNames()
      .filter((name) => !GRASS_MOB_NAMES.includes(name) && !mvpNames.has(name))
      .map((name) => {
        const row = newControlRow(monSchema);
        row.name = controlSafeName(name);
        row.values["attack_auto"] = "2";
        return row;
      });
    doc["mon_control.txt"] = [...monRows, ...(doc["mon_control.txt"] ?? [])];

    const pickSchema = CONTROL_SCHEMAS.find((x) => x.file === "pickupitems.txt")!;
    const pickRows: ControlRow[] = dropNames().map((name) => {
      const rule = state.rules.get(name) ?? { pick: "yes" as PickMode, handle: "store" as HandleMode };
      const row = newControlRow(pickSchema);
      row.name = controlSafeName(name);
      row.values["flag"] = rule.pick === "no"
        ? "0"
        : rule.pick === "drop"
          ? "-1"
          : jobData().ranged && name === ARROW_ITEM
            ? "2"
            : "1";
      return row;
    });
    const pickBase = (doc["pickupitems.txt"] ?? []).filter((row) => row.name !== "all");
    const pickAll = (doc["pickupitems.txt"] ?? []).filter((row) => row.name === "all");
    doc["pickupitems.txt"] = [
      ...pickBase,
      ...pickRows,
      ...pickAll.map((row) => ({ ...row, values: { ...row.values, flag: "0" } })),
    ];

    const itemSchema = CONTROL_SCHEMAS.find((x) => x.file === "items_control.txt")!;
    const itemBase = (doc["items_control.txt"] ?? []).filter((row) => row.name !== "all");
    const itemAll = (doc["items_control.txt"] ?? []).filter((row) => row.name === "all");
    const merged = new Map<string, ControlRow>();
    for (const row of itemBase) merged.set(row.name, { ...row, values: { ...row.values } });
    const upsert = (name: string, patch: Record<string, string>): void => {
      let row = merged.get(name);
      if (!row) {
        row = newControlRow(itemSchema);
        row.name = name;
        merged.set(name, row);
      }
      Object.assign(row.values, patch);
    };
    // 消耗品（药水/水果）不能写大 keep：捡多了会一直占着负重却又因「未超出 keep」不存仓，
    // 回城存仓时反而卡住。keep 写 0，开存仓时 storage 写 1，让超出部分全部进仓库。
    // 存仓必须同时有 storage=1（KE 只对 store 规则且超出 keep 的物品存仓），
    // 否则具名行会盖掉 all 的存仓设置，超重问题依旧。
    const consumableStorage = state.on.loot ? "1" : "0";
    for (const name of POTIONS) upsert(name, { keep: "0", storage: consumableStorage, sell: "0" });
    // 坐骑缰绳、苍蝇翅膀、箭矢属于战斗自用品，保持原有保留数量。
    upsert(MOUNT_ITEM, { keep: "9999", storage: "0", sell: "0" });
    upsert(TELEPORT_ITEM, { keep: "9999", storage: "0", sell: "0" });
    if (jobData().ranged) upsert(ARROW_ITEM, { keep: "10000", storage: "0", sell: "0" });
    for (const name of dropNames()) {
      const rule = state.rules.get(name) ?? { pick: "yes" as PickMode, handle: "store" as HandleMode };
      const safeName = controlSafeName(name);
      if (rule.pick === "no" || rule.pick === "drop") {
        merged.delete(safeName);
        continue;
      }
      const consumable = POTIONS.includes(name) || /药水/u.test(name);
      upsert(safeName, rule.handle === "store"
        ? { keep: "0", storage: "1", sell: "0" }
        : rule.handle === "sell"
          ? { keep: "0", storage: "0", sell: "1" }
          : consumable
            ? { keep: "0", storage: consumableStorage, sell: "0" }
            : { keep: "999", storage: "0", sell: "0" });
    }
    doc["items_control.txt"] = [
      ...merged.values(),
      ...itemAll.map((row) => ({
        ...row,
        values: { ...row.values, keep: "0", storage: state.on.loot ? "1" : "0", sell: "0" },
      })),
    ];

    const timeoutKeys: { key: string; value: string }[] = options?.timeouts?.length
      ? options.timeouts
      : Object.keys(TIMEOUT_DEFAULT_OVERRIDES).map((key) => ({ key, value: TIMEOUT_DEFAULT_OVERRIDES[key] ?? "" }));
    doc["timeouts.txt"] = timeoutKeys.map((t) => ({
      name: t.key,
      values: { value: TIMEOUT_DEFAULT_OVERRIDES[t.key] ?? t.value },
    }));
    return doc;
  }

  function buildDocs(): { config: ConfigDoc; controls: ControlDoc } {
    return { config: buildConfigDoc(), controls: buildControlDoc() };
  }

  function controlText(doc: ControlDoc, file: string): string {
    const schema = CONTROL_SCHEMAS.find((x) => x.file === file)!;
    return stripConfigComments(serializeControl(schema, doc[file] ?? []));
  }

  function highlight(text: string): string {
    return text.split("\n").map((line) => {
      if (line.trim() === "") return "";
      if (line.trimStart().startsWith("#")) return `<span class="c">${esc(line)}</span>`;
      const match = /^(\s*)(\S+)(.*)$/u.exec(line);
      if (!match) return esc(line);
      const [, pad, key, rest] = match;
      return `${pad ?? ""}<span class="k">${esc(key ?? "")}</span><span class="v">${esc(rest ?? "")}</span>`;
    }).join("\n");
  }

  function renderCode(): void {
    const { config, controls } = buildDocs();
    const texts: Record<string, string> = {
      config: serializeConfig(config),
      mon: controlText(controls, "mon_control.txt"),
      pickup: controlText(controls, "pickupitems.txt"),
      items: controlText(controls, "items_control.txt"),
      timeouts: controlText(controls, "timeouts.txt"),
    };
    codeEl.innerHTML = highlight(texts[currentFile] ?? "");
    for (const tab of $$("#ksgTabs .ksg-tab")) {
      tab.classList.toggle("on", tab.getAttribute("data-file") === currentFile);
    }
  }

  function openPreview(): void {
    renderCode();
    modal.hidden = false;
    $<HTMLButtonElement>("#ksgModalClose")?.focus();
  }
  function closePreview(): void {
    modal.hidden = true;
  }

  /* ========== 保存 ========== */

  function showNotice(kind: "ok" | "err", html: string): void {
    stateEl.hidden = false;
    stateEl.className = `ksg-state ksg-state--${kind}`;
    stateEl.innerHTML = html;
  }

  function validateAll(): { config: ConfigDoc; controls: ControlDoc; errors: string[] } {
    const docs = buildDocs();
    ensureAllFallback(docs.controls);
    return {
      ...docs,
      errors: [...validateConfigDoc(docs.config), ...validateControlDoc(docs.controls)],
    };
  }

  /** 保存时自动生成方案名：职业 + 地图 + 时间戳，避免同名方案被后端拒绝。 */
  function autoProfileName(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return `${jobData().name}挂机 · ${state.map || "未命名地图"} · ${stamp}`;
  }

  async function save(): Promise<void> {
    if (saving || !character) return;
    const { config, controls, errors } = validateAll();
    if (errors.length > 0) {
      showNotice("err", `配置未通过校验：${errors.map((x) => esc(x)).join("；")}`);
      openPreview();
      return;
    }
    const name = autoProfileName();
    if (demo) {
      showNotice("ok", `方案「${esc(name)}」已生成并激活（演示模式，未写入云端）。`);
      return;
    }
    saving = true;
    const buttons = [$<HTMLButtonElement>("#ksgSaveBtn"), $<HTMLButtonElement>("#ksgModalSave")];
    for (const b of buttons) if (b) b.disabled = true;
    showNotice("ok", "正在保存并激活…");
    try {
      const payload = {
        aid: character.aid,
        cid: character.cid,
        nid: character.nid,
        name,
        config_text: stripConfigComments(serializeConfig(config)),
        mon_control: controlText(controls, "mon_control.txt"),
        pickupitems: controlText(controls, "pickupitems.txt"),
        items_control: controlText(controls, "items_control.txt"),
        timeouts: controlText(controls, "timeouts.txt"),
      };
      const { id } = await keFetch<{ id: number }>("/api/v1/ke/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      // 服务端新建方案一律 is_active=0，再调 activate 让新方案默认生效。
      await keFetch<void>(`/api/v1/ke/profiles/${id}/activate`, { method: "POST" });
      const c = character;
      showNotice(
        "ok",
        `方案「${esc(name)}」已保存并激活，进阶客户端下次同步即可生效。` +
          `<a href="/ke/my?aid=${c.aid}&cid=${c.cid}&nid=${c.nid}">前往工作台查看 →</a>`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const tip = msg.startsWith("AUTH:") ? "登录状态已失效，请重新登录后再保存。" : msg;
      showNotice("err", `保存失败：${esc(tip)}`);
    } finally {
      saving = false;
      for (const b of buttons) if (b) b.disabled = false;
    }
  }

  /* ========== 交互绑定 ========== */

  $<HTMLButtonElement>("#ksgMapPick")?.addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("#ksgMapPick");
    if (!btn) return;
    openWorldmapPicker(root, {
      title: "世界地图选图",
      value: state.map,
      trigger: btn,
      onSelect: (code) => {
        state.map = code;
        state.rules.clear();
        renderMap();
        renderItems();
        renderOutput();
        if (!modal.hidden) renderCode();
      },
    });
  });

  $("#ksgHuntSeg")?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-hunt]");
    if (!target) return;
    state.hunt = (target.getAttribute("data-hunt") as HuntMode | null) ?? "walk";
    renderHunt();
    renderOutput();
    if (!modal.hidden) renderCode();
  });

  $("#ksgTpWrap")?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tp]");
    if (!target) return;
    state.tpMode = (target.getAttribute("data-tp") as TpMode | null) ?? "item";
    renderHunt();
    renderOutput();
    if (!modal.hidden) renderCode();
  });

  $<HTMLSelectElement>("#ksgJobSelect")?.addEventListener("change", () => {
    const sel = $<HTMLSelectElement>("#ksgJobSelect");
    if (!sel) return;
    state.job = sel.value;
    initSkillState();
    renderJobCard();
    renderSwitches();
    renderAtk();
    renderElemPanel();
    renderBuffs();
    renderOutput();
    if (!modal.hidden) renderCode();
  });

  for (const id of ["#ksgSp", "#ksgDist", "#ksgPotHp", "#ksgTpHp", "#ksgTpAggr", "#ksgSitLo", "#ksgSitHi", "#ksgSitSpLo", "#ksgSitSpHi", "#ksgTownWeight", "#ksgSellNpc", "#ksgStoreNpc", "#ksgFollow", "#ksgFollowTarget"]) {
    const el = $(id);
    el?.addEventListener("input", () => {
      syncAdvanced();
      renderSwitches();
      renderOutput();
      if (!modal.hidden) renderCode();
    });
    el?.addEventListener("change", () => {
      syncAdvanced();
      renderSwitches();
      renderOutput();
      if (!modal.hidden) renderCode();
    });
  }

  $<HTMLButtonElement>("#ksgPreviewBtn")?.addEventListener("click", openPreview);
  $<HTMLButtonElement>("#ksgModalClose")?.addEventListener("click", closePreview);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closePreview();
  });
  for (const tab of $$("#ksgTabs .ksg-tab")) {
    tab.addEventListener("click", () => {
      currentFile = tab.getAttribute("data-file") ?? "config";
      renderCode();
    });
  }
  $<HTMLButtonElement>("#ksgSaveBtn")?.addEventListener("click", () => void save());
  $<HTMLButtonElement>("#ksgModalSave")?.addEventListener("click", () => void save());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closePreview();
  });

  /* ========== 启动 ========== */

  function renderJobGrid(): void {
    cardsEl.hidden = true;
    charCard.hidden = true;
    dock.hidden = true;
    jobGridEl.hidden = false;
    const nid = character?.nid ?? 3;
    const cap = serverCapOf(nid);
    jobGridEl.innerHTML = seriesList.map((opt) => {
      const job = JOBS[opt.jobId];
      if (!job) return "";
      const tier = cap.label ? ` · ${cap.label}最高` : "";
      return `<a class="ksg-jobcard" href="/ke/my/create/setup-guide?demo=1&nid=${encodeURIComponent(String(nid))}&job=${encodeURIComponent(opt.jobId)}">
        <span class="ksg-jobcard-avatar">${esc(job.name.slice(0, 1))}</span>
        <span class="ksg-jobcard-main"><b>${esc(opt.name)}</b><small>${esc(job.name)}${tier} · 攻击 ${job.atk.length} · buff ${job.aux.length}${job.ranged ? " · 远程" : ""}</small></span>
        <span class="ksg-map-go">配置 →</span>
      </a>`;
    }).join("");
  }

  async function boot(): Promise<void> {
    demo = isLocalDemoMode();
    const query = new URLSearchParams(window.location.search);
    let char: KeCharacter | null = null;
    if (demo) {
      const jobParam = query.get("job");
      const nidRaw = Number(query.get("nid"));
      const demoNid = Number.isFinite(nidRaw) && nidRaw > 0 ? nidRaw : 3;
      const rawJob = jobParam && Number.isFinite(Number(jobParam)) ? Number(jobParam) : 11;
      // demo 也按服务器档位截断：龙骑士在 nid=3 显示符文骑士、nid=5 骑士领主、nid=6 骑士。
      const clamp = clampJobForNid(rawJob, demoNid);
      char = {
        aid: 1000001, cid: 2000002, nid: demoNid,
        char_name: jobParam ? "测试角色" : "波利猎人",
        job_id: Number(clamp.jobId),
        map_name: "prt_fild08",
        last_seen_at: Date.now() - 3 * 60000,
      };
    } else {
      try {
        const body = await keFetch<{ characters: KeCharacter[] }>("/api/v1/ke/characters");
        if (body.characters.length === 0) {
          showNotice("err", "暂无已绑定角色。请先用进阶客户端登录角色，然后刷新本页。");
          return;
        }
        char =
          body.characters.find(
            (c) =>
              c.aid === Number(query.get("aid")) &&
              c.cid === Number(query.get("cid")) &&
              c.nid === Number(query.get("nid")),
          ) ?? body.characters[0]!;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("AUTH:")) {
          showNotice("err", '请先登录账号，再回到本页使用一键配置。<a href="/account">去登录 →</a>');
        } else {
          showNotice("err", error instanceof Error ? error.message : "加载失败，请刷新重试。");
        }
        return;
      }
    }

    stateEl.textContent = "正在加载职业与地图数据…";
    const [optData, mobData, kindData, nameData] = await Promise.all([
      fetch("/ke/options.json")
        .then((r) => (r.ok ? (r.json() as Promise<KeOptionsLite>) : null))
        .catch(() => null),
      fetch("/ke/map-mobs.json")
        .then((r) => (r.ok ? (r.json() as Promise<MapMobsData>) : null))
        .catch(() => null),
      fetch("/ke/skill-types.json")
        .then((r) => (r.ok ? (r.json() as Promise<SkillTypesFile>) : null))
        .catch(() => null),
      fetch("/ke/mapnames.json")
        .then((r) => (r.ok ? (r.json() as Promise<MapNamesFile>) : null))
        .catch(() => null),
    ]);
    options = optData;
    mapMobs = mobData;
    skillTypes = kindData;
    mapNames = nameData?.names ?? {};
    buildIndexes();

    const built = options ? buildJobsFromOptions(options, skillTypes?.skills ?? {}) : null;
    if (built) {
      JOBS = built.jobs;
      jobList = built.list;
    }
    character = char;
    // 按角色所在服务器截断职业：龙骑士在 nid=3 → 符文骑士、nid=5 → 骑士领主、nid=6 → 骑士。
    const rawJob = char.job_id !== null ? String(char.job_id) : "";
    const jobId = rawJob ? clampJobForNid(rawJob, char.nid).jobId : "";
    if (jobId && !JOBS[jobId]) {
      const jnEn = options?.jobs?.[jobId] ?? "";
      const jnZh = options?.jobs_zh?.[jobId] ?? jnEn;
      JOBS[jobId] = {
        name: jnZh || jnEn || `职业 ${jobId}`,
        ranged: false, surv: "melee", mount: false, mountSkill: false, basic: false, atk: [], aux: [],
      };
    }
    seriesList = listJobSeries(char.nid).filter((opt) => JOBS[opt.jobId]);
    if (seriesList.length === 0) {
      seriesList = jobList.map((id) => ({ key: id, name: JOBS[id]!.name, jobId: id, capped: false }));
    }
    state.job = jobId && JOBS[jobId] ? jobId : (seriesList[0]?.jobId ?? jobList[0] ?? Object.keys(JOBS)[0] ?? "11");
    state.map = char.map_name?.trim() || "prt_fild08";

    const jobCount = $("#ksgJobCount");
    if (jobCount && seriesList.length) jobCount.textContent = String(seriesList.length);

    const select = $<HTMLSelectElement>("#ksgJobSelect");
    if (select) {
      const inSeries = seriesList.some((opt) => opt.jobId === state.job);
      const current = JOBS[state.job];
      select.innerHTML = seriesList
        .map((opt) => {
          const job = JOBS[opt.jobId];
          const label = job && job.name !== opt.name ? `${opt.name}（${job.name}）` : opt.name;
          return `<option value="${esc(opt.jobId)}">${esc(label)}</option>`;
        })
        .join("") + (!inSeries && current ? `<option value="${esc(state.job)}">当前 · ${esc(current.name)}</option>` : "");
      select.value = state.job;
    }

    if (demo && query.get("jobs") === "1") {
      stateEl.hidden = true;
      renderJobGrid();
      return;
    }

    stateEl.hidden = true;
    jobSwitch.hidden = !demo;
    jobFixed.hidden = demo;
    initSkillState();
    syncAdvanced();
    renderJobCard();
    renderMap();
    renderHunt();
    renderSwitches();
    renderAtk();
    renderElemPanel();
    renderBuffs();
    renderItems();
    renderOutput();
  }

  void boot();
}
