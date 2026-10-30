// KE 萌新一键配置向导页（/ke/my/create/setup-guide）：四步向导（地图 → 战斗技能 → 生存 → 拾取），
// 交互移植自 ke-wizard-preview.html 原型；数据源改为真实接口（角色 /ke/options.json /ke/map-mobs.json），
// 保存经 ke-schema/ke-controls 序列化后 POST /api/v1/ke/profiles 真实落库。

import { keFetch } from "./ke-page";
import { openWorldmapPicker } from "./ke-worldmap";
import {
  CONDITION_KEYS,
  defaultDoc,
  serializeConfig,
  validateConfigDoc,
  type BlockValue,
  type ConfigDoc,
} from "./ke-schema";
import {
  CONTROL_SCHEMAS,
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
  CAT_ORDER,
  FALLBACK_JOBS,
  buildJobsFromOptions,
  presetOf,
  type AuxCat,
  type AuxSeed,
  type JobData,
  type SurvKind,
} from "./ke-jobs";
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
}
interface MapMobsData {
  maps: Record<string, MapMobsEntry>;
}

type ScopeKey = "self" | "other";

interface Cond {
  k: string;
  v: string;
}
interface ScopeState {
  on: boolean;
  names: string;
  conds: Cond[];
}
interface AuxSkill {
  id: string;
  name: string;
  cat: AuxCat;
  /** 角色实际学到的技能等级，写入 useSelf_skill / partySkill 的 lvl。 */
  lv: number;
  scopes: Record<ScopeKey, ScopeState>;
}
interface MobSkill {
  n: string;
  lvl: number;
  conds: Cond[];
  /** 每只怪最多使用几次（OpenKore maxUses）；不填=不限。 */
  maxUses?: number;
}
interface Mob {
  id: string;
  name: string;
  skills: MobSkill[];
  deleted?: boolean;
  pri?: boolean;
}
interface FbSkill {
  n: string;
  lv: number;
}
interface AtkPoolSkill {
  n: string;
  lv: number;
  maxUses?: number;
  conds: Cond[];
}
interface DragState {
  kind: "skill" | "fb" | "aux";
  name: string;
  el: HTMLElement;
  sx: number;
  sy: number;
  active: boolean;
}
interface SkillTypesFile {
  skills?: Record<string, string>;
}
interface WizardCtx {
  demo: boolean;
  character: KeCharacter;
  options: KeOptionsLite | null;
  mapMobs: MapMobsData | null;
  skillKinds: Record<string, string>;
}

const CAT_LABEL: Record<AuxCat, string> = {
  buff: "增益",
  ground: "地面",
  heal: "治疗",
  survival: "保命",
};
const SCOPE_ORDER: ScopeKey[] = ["self", "other"];
const SCOPE_LABEL: Record<ScopeKey, string> = { self: "自己", other: "其他人" };
const SCOPE_BLOCK: Record<ScopeKey, string> = {
  self: "useSelf_skill",
  other: "partySkill",
};
const TARGET_KEY: Record<string, string> = {
  hp: "target_hp",
  whenStatusInactive: "target_whenStatusInactive",
  whenStatusActive: "target_whenStatusActive",
  whenNotGround: "target_whenNotGround",
  whenGround: "target_whenGround",
  aggressives: "target_aggressives",
};
const SELF_KEY: Record<string, string> = {
  target_hp: "hp",
  target_whenStatusInactive: "whenStatusInactive",
  target_whenStatusActive: "whenStatusActive",
  target_whenNotGround: "whenNotGround",
  target_whenGround: "whenGround",
  target_aggressives: "aggressives",
};
const SKILL_STATUS: Record<string, string> = {
  加速术: "加速",
  祝福: "祝福",
  集中: "集中",
  天使之护: "天使之护",
  圣母之颂歌: "圣母之颂歌",
  剑术修炼: "剑术修炼",
  霸邪之障: "霸邪之障",
  伪装: "伪装",
  铁壁: "铁壁",
};
const AUX_POOL: AuxSeed[] = [
  { n: "加速术", c: "buff" }, { n: "祝福", c: "buff" }, { n: "集中", c: "buff" },
  { n: "天使之护", c: "buff" }, { n: "圣母之颂歌", c: "buff" },
  { n: "治愈术", c: "heal" }, { n: "药水投掷", c: "heal" },
  { n: "霸邪之障", c: "survival" }, { n: "伪装", c: "survival" }, { n: "铁壁", c: "survival" },
  { n: "火焰领域", c: "ground" }, { n: "暗之障壁", c: "ground" },
];
const COND_LABEL: Record<string, string> = {
  whenStatusInactive: "状态未生效",
  whenStatusActive: "状态生效时",
  whenNotGround: "地面技能不在场",
  hp: "HP 阈值",
  aggressives: "被围攻数",
  timeout: "冷却",
};
for (const k of Object.keys(TARGET_KEY)) {
  const tk = TARGET_KEY[k];
  if (tk && COND_LABEL[k]) COND_LABEL[tk] = `目标${COND_LABEL[k]}`;
}



// 生存设置按职业原型预设（applyJob 时套用为默认值，用户可改）
const SURV_PRESETS: Record<SurvKind, Record<string, string | number>> = {
  tank: { tp: 1, tpHp: "20", tpAggr: "6", tpDmg: "1500", sit: 1, sitHpLo: "40", sitHpHi: "85", sitSpLo: "15", sitSpHi: "60", potHp: 1, potHpPct: "55", potSp: 0, potSpPct: "30", townWeight: "50", buyHp: 1, buyHpMin: "10", buyHpNum: "80", buySp: 0, buySpMin: "0", buySpNum: "0", spfloor: 0, spFloor: "20", buyTp: 1, buyTpMin: "3", buyTpNum: "10" },
  healer: { tp: 1, tpHp: "30", tpAggr: "3", tpDmg: "800", sit: 1, sitHpLo: "30", sitHpHi: "90", sitSpLo: "40", sitSpHi: "90", potHp: 0, potHpPct: "40", potSp: 1, potSpPct: "35", townWeight: "60", buyHp: 0, buyHpMin: "0", buyHpNum: "0", buySp: 1, buySpMin: "10", buySpNum: "60", spfloor: 1, spFloor: "40", buyTp: 1, buyTpMin: "3", buyTpNum: "10" },
  ranged: { tp: 1, tpHp: "40", tpAggr: "2", tpDmg: "600", sit: 1, sitHpLo: "50", sitHpHi: "90", sitSpLo: "30", sitSpHi: "90", potHp: 1, potHpPct: "45", potSp: 0, potSpPct: "30", townWeight: "50", buyHp: 1, buyHpMin: "5", buyHpNum: "40", buySp: 0, buySpMin: "0", buySpNum: "0", spfloor: 1, spFloor: "20", buyTp: 1, buyTpMin: "3", buyTpNum: "10" },
  caster: { tp: 1, tpHp: "35", tpAggr: "2", tpDmg: "600", sit: 1, sitHpLo: "40", sitHpHi: "85", sitSpLo: "45", sitSpHi: "90", potHp: 1, potHpPct: "45", potSp: 1, potSpPct: "30", townWeight: "60", buyHp: 1, buyHpMin: "5", buyHpNum: "30", buySp: 1, buySpMin: "10", buySpNum: "50", spfloor: 1, spFloor: "40", buyTp: 1, buyTpMin: "3", buyTpNum: "10" },
  melee: { tp: 1, tpHp: "30", tpAggr: "4", tpDmg: "1000", sit: 1, sitHpLo: "50", sitHpHi: "90", sitSpLo: "15", sitSpHi: "80", potHp: 1, potHpPct: "50", potSp: 0, potSpPct: "30", townWeight: "50", buyHp: 1, buyHpMin: "5", buyHpNum: "50", buySp: 0, buySpMin: "0", buySpNum: "0", spfloor: 0, spFloor: "20", buyTp: 1, buyTpMin: "3", buyTpNum: "10" },
};

// 生存设置的道具下拉：瞬移道具 / HP 药水 / SP 药水（各取常用可用道具，玩家直接选）
const TELEPORT_ITEMS: readonly string[] = [
  "苍蝇翅膀", "魔法苍蝇翅膀", "轻量苍蝇翅膀", "超级苍蝇翅膀", "巨大的苍蝇翅膀",
  "无限巨大苍蝇翅膀", "新手专用苍蝇翅膀", "蝴蝶翅膀", "黄蝴蝶翅膀", "绿蝴蝶翅膀",
  "红蝴蝶翅膀", "蓝蝴蝶翅膀",
];
// 可替代道具完成瞬移的技能（KE 的 teleportAuto_useSkill 只认「瞬间移动」）
const TELEPORT_SKILLS: readonly string[] = ["瞬间移动"];
const isTeleportSkill = (name: string): boolean => TELEPORT_SKILLS.includes(name);
const HP_POTIONS: readonly string[] = [
  "红色药水", "赤色药水", "黄色药水", "白色药水",
  "红色纤细药水", "黄色纤细药水", "白色纤细药水",
  "轻盈红色药水", "轻盈赤色药水", "轻盈黄色药水", "轻盈白色药水",
  "浓缩白色药水", "净化药水", "初学者专用药水",
];
const SP_POTIONS: readonly string[] = [
  "蓝色药水", "轻盈蓝色药水", "浓缩蓝色糖浆药水", "初心者蓝色药水", "[非卖品]蓝色药水",
];
// 箭矢补给的道具下拉：只保留商店实际出售的箭矢，避免选到买不到的活动/装饰箭
const ARROW_ITEMS: readonly string[] = [
  "箭矢", "铁箭矢", "银箭矢", "火箭矢", "水灵箭矢", "风灵箭矢", "地灵箭矢", "无形箭矢", "影子箭矢", "铁锈箭矢",
];

function footerMarkup(): string {
  return `
    <footer class="site-footer kg-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/ke/guide">KE指南</a><a href="/ke/my">配置工作台</a><a href="/ke/hall">配置大厅</a><a href="/client">进阶客户端</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>`;
}

function wizardMarkup(demo: boolean): string {
  return `
  <div class="ke-wiz">
    <div class="wz-head">
      <div class="wz-match">
        <span class="wz-badge" id="wzJobBadge">…</span>
        <span class="wz-muted" id="wzMatchInfo">正在匹配职业预设…</span>
        <span class="wz-live" id="wzDemoLive"${demo ? "" : " hidden"}>演示模式 · 保存仅模拟</span>
      </div>
      <div class="wz-steps">
        <button class="wz-step" data-step="0"><i>1</i>挂机地图</button>
        <button class="wz-step" data-step="1"><i>2</i>战斗与技能</button>
        <button class="wz-step" data-step="2"><i>3</i>生存设置</button>
        <button class="wz-step" data-step="3"><i>4</i>拾取设置</button>
      </div>
    </div>
    <div class="wz-panels">
      <section class="wz-panel" data-panel="0">
        <div class="wz-sec-h"><h3>挂机地图</h3><span class="wz-faint">lockMap / saveMap</span></div>
        <div class="wz-row" style="align-items:flex-end">
          <div class="wz-mapfld">
            <span class="wz-mapfld-t">挂机地图</span>
            <span class="wz-mapfld-r">
              <input class="wz-in" id="lockMapIn" value="" placeholder="搜索地图名或代码…">
              <button class="wz-btn" type="button" data-pickmap="lock">选择地图</button>
            </span>
          </div>
          <div class="wz-mapfld">
            <span class="wz-mapfld-t">回城地图</span>
            <span class="wz-mapfld-r">
              <input class="wz-in" id="saveMapIn" value="prontera" placeholder="搜索地图名或代码…">
              <button class="wz-btn" type="button" data-pickmap="save">选择地图</button>
            </span>
          </div>
        </div>
        <p class="wz-note">选定地图后，第 2 步自动带出该图怪物、第 4 步带出该图掉落物；换图时旧图条目整体作废，不会被带到新图。</p>
      </section>

      <section class="wz-panel" data-panel="1">
        <div class="wz-sec-h"><h3>基础攻击</h3><span class="wz-faint">attackAuto / attackUseWeapon / attackDistance / attackEquip_arrow</span></div>
        <div class="wz-row">
          <label class="wz-fl" data-flag="weapon" data-combat-only><input type="checkbox" checked>武器普攻</label>
          <label class="wz-fld">打怪方式
            <select class="wz-in" id="attackAuto" style="padding:2px 4px">
              <option value="2">主动打怪</option>
              <option value="1">只打主动攻击我的</option>
              <option value="0">不打怪（纯辅助）</option>
            </select>
          </label>
          <label class="wz-fl" data-flag="snipe" data-combat-only><input type="checkbox" checked>定点打怪</label>
          <label class="wz-fl" data-flag="kite" data-ranged-only data-combat-only><input type="checkbox">远程风筝</label>
          <label class="wz-fld" data-ranged-only data-combat-only>攻击距离<input class="wz-in wz-num" id="atkDist" value="9"></label>
        </div>
        <div class="wz-alert" data-arrow-warn data-combat-only hidden>箭矢为空：弓类普攻与箭技都无法射出，请先在下方装备区或第 4 步箭矢补给填上箭矢。</div>
        <p class="wz-note" data-snipe-note data-combat-only>定点打怪：怪进入射程就原地出手，不追怪；捡物、回城补给仍会正常移动。</p>
        <p class="wz-note" data-ranged-only data-combat-only>远程风筝：怪贴近时自动后撤拉开距离再打；与定点打怪同开 = 原地打、贴脸才退。</p>
        <p class="wz-note" id="aaOffNote" style="display:none">纯辅助模式：打怪配置（武器普攻 / 定点打怪 / 技能绑定 / 优先攻击 / 骑乘战斗）已灰掉不会生效；辅助技能、跟随、坐骑赶路不受影响。</p>
        <details class="wz-eq" data-ranged-only data-combat-only>
          <summary>自动装备 · attackEquip_arrow（开打前换箭矢）</summary>
          <div class="wz-eq-grid">
            <label class="wz-fld">箭矢<select class="wz-in" id="eqArrow" style="padding:2px 4px;width:140px"></select></label>
          </div>
        </details>

        <div data-mount-sec style="display:none">
          <div class="wz-sec-h"><h3>坐骑</h3><span class="wz-faint">useSelf_skill 骑乘术 / useSelf_item 坐骑道具</span></div>
          <div class="wz-row">
            <label class="wz-fl" data-flag="automount"><input type="checkbox" checked>自动坐骑</label>
            <label class="wz-fl" data-flag="mountcombat" data-mount-combat data-combat-only><input type="checkbox" checked>骑乘战斗</label>
            <label class="wz-fld" data-mount-item style="display:none">坐骑道具<select class="wz-in" id="mountItem" style="padding:2px 4px;width:170px"></select></label>
          </div>
          <p class="wz-note">自动坐骑：打完怪赶路、移动时自动上坐骑。</p>
          <p class="wz-note" data-mount-combat-note data-combat-only>骑乘战斗：乘骑攻击职业专用，保持坐骑状态攻击、不下马。</p>
          <p class="wz-note" data-mount-item-note style="display:none">本职业没有骑乘术，用坐骑道具上坐骑（缰绳需在背包内）：序列化为 useSelf_item（whenNotMounted）；不选则关闭自动坐骑。</p>
        </div>

        <div>
          <div class="wz-sec-h"><h3>跟随</h3><span class="wz-faint">follow / followTarget / followDistanceMax</span></div>
          <div class="wz-row">
            <label class="wz-fl" data-flag="follow"><input type="checkbox">跟随打怪</label>
            <label class="wz-fld" data-follow-target style="display:none">跟随谁<input class="wz-in" id="followTarget" placeholder="玩家名字"></label>
            <label class="wz-fld" data-follow-opt style="display:none">跟丢距离<input class="wz-in wz-num" id="followDist" value="6"> 格</label>
          </div>
          <p class="wz-note">跟随打怪：跟着指定玩家移动并攻击他的目标，适合服事、诗人等辅助职业组主队挂机。名字必须与游戏内完全一致，写错则原地不动。</p>
        </div>

        <div class="wz-row" data-combat-only style="margin-bottom:var(--sp-3)">
          <label class="wz-fl" data-flag="spfloor"><input type="checkbox">技能用蓝保底</label>
          <label class="wz-fld">SP 低于<input class="wz-in wz-num" id="spFloor" value="20"> % 不再放攻击技能</label>
          <span class="wz-faint">序列化为每条 attackSkillSlot 加 sp &gt; N% 条件，把蓝留给瞬移/治疗/增益</span>
        </div>

        <div class="wz-split" data-combat-only>
          <div class="wz-box">
            <div class="wz-box-t">技能卡池</div>
            <div class="wz-cap"><span>精确技能</span><span class="rule"></span><span class="wz-cap-r" id="dataSrc"></span><span class="wz-cap-r">职业 <b id="jobLabel">…</b></span><span class="wz-cap-r">拖到怪物卡</span><span class="wz-cap-r" id="skillCount">已绑定 0 / 共 0</span></div>
            <div class="wz-cards" id="skillPool"></div>
            <div id="skillPoolEditor"></div>
            <div class="wz-cap"><span>兜底技能</span><span class="rule"></span><span class="wz-cap-r">区内排序</span></div>
            <div class="wz-fblist" id="fbList"></div>
            <p class="wz-note">精确技能拖到怪物卡即绑定，拖入下方兜底区则对所有未绑定怪生效；兜底卡可在区内排序、点 × 移出（普通攻击常驻兜底）</p>
          </div>
          <div class="wz-box">
            <div class="wz-cap" style="margin-top:0"><span>本图怪物</span><span class="rule"></span><span class="wz-cap-r">★ 优先打 · × 不打</span><span class="wz-cap-r" id="mobCount">0 / 0 在打</span></div>
            <div class="wz-mobs" id="mobGrid"></div>
            <p class="wz-note" data-nomap-note hidden>该图暂无怪物数据，可手动继续配置；换成有数据的地图后会自动带出怪物。</p>
            <div class="wz-removed" id="removedBar" hidden></div>
          </div>
        </div>

        <div class="wz-cap"><span>执行顺序</span><span class="rule"></span><span class="wz-cap-r">首条匹配即执行 · 兜底排最后</span></div>
        <div id="orderList"></div>

        <div class="wz-aux-head">
          <h3 style="margin:0;font-size:15px">辅助技能</h3>
          <span class="wz-faint">从上到下匹配 · 首条满足即执行</span>
          <button class="wz-mini" id="addAux" style="margin-left:auto">+ 添加辅助技能</button>
        </div>
        <div class="wz-aux-hint">按住卡片拖动即可改顺序；点条件气泡编辑条件。</div>
        <div class="wz-aux-grid" id="auxGrid"></div>
        <div class="wz-picker" id="auxPicker" hidden>
          <div class="wz-picker-h">选择辅助技能（已添加的置灰）</div>
          <div id="pickerBody"></div>
        </div>
        <div class="wz-warnbox" id="auxWarn" hidden></div>
        <p class="wz-note">条件跟技能类别走、不跟职业走：增益 → 状态未生效补状态；地面技 → 用「地面技能不在场」判断；治疗 → HP 阈值 + 冷却；保命 → 血线或被围数。切类别时，如果条件仍是旧类别的默认值，会自动换成新类别的默认值；你改过的条件会保留。</p>
      </section>

      <section class="wz-panel" data-panel="2">
        <div class="wz-sec-h"><h3>生存设置</h3><span class="wz-faint">teleportAuto / sitAuto / useSelf_item</span></div>

        <div class="wz-sec-h"><h3>濒死瞬移</h3><span class="wz-faint">teleportAuto_hp / minAggressives / maxDmg / useSkill</span></div>
        <div class="wz-row">
          <label class="wz-fl" data-flag="tp"><input type="checkbox" checked>启用瞬移</label>
          <label class="wz-fld">HP 低于<input class="wz-in wz-num" id="tpHp" value="30"> % 飞</label>
          <label class="wz-fld">被围 ≥<input class="wz-in wz-num" id="tpAggr" value="3"> 只飞</label>
          <label class="wz-fld">单次伤害超过<input class="wz-in wz-num" id="tpDmg" value="600"> 飞</label>
          <label class="wz-fld">瞬移道具或技能<select class="wz-in" id="tpItem" style="padding:2px 4px;width:150px"></select></label>
        </div>
        <p class="wz-note">选道具时需背包内有该道具才会飞；选技能则用「瞬间移动」瞬移（需已学会），第 2 步辅助技能里同名的规则不再重复写入。</p>

        <div class="wz-sec-h" style="margin-top:var(--sp-4)"><h3>坐下回复</h3><span class="wz-faint">sitAuto_hp_lower/upper · sitAuto_sp_lower/upper</span></div>
        <div class="wz-row">
          <label class="wz-fl" data-flag="sit"><input type="checkbox" checked>启用坐下回复</label>
          <label class="wz-fld">HP 低于<input class="wz-in wz-num" id="sitHpLo" value="50"> % 坐下</label>
          <label class="wz-fld">回到<input class="wz-in wz-num" id="sitHpHi" value="90"> % 起身</label>
          <label class="wz-fld">SP 低于<input class="wz-in wz-num" id="sitSpLo" value="30"> % 坐下</label>
          <label class="wz-fld">回到<input class="wz-in wz-num" id="sitSpHi" value="90"> % 起身</label>
        </div>
        <p class="wz-note">坐下时不攻击不移动，起身阈值必须高于坐下阈值。</p>

        <div class="wz-sec-h" style="margin-top:var(--sp-4)"><h3>药水回复</h3><span class="wz-faint">useSelf_item（hp / sp 条件）</span></div>
        <div class="wz-row">
          <label class="wz-fl" data-flag="potHp"><input type="checkbox" checked>HP 药水</label>
          <label class="wz-fld">道具<select class="wz-in" id="potHpItem" style="padding:2px 4px;width:150px"></select></label>
          <label class="wz-fld">HP 低于<input class="wz-in wz-num" id="potHpPct" value="40"> % 喝</label>
        </div>
        <div class="wz-row">
          <label class="wz-fl" data-flag="potSp"><input type="checkbox">SP 药水</label>
          <label class="wz-fld">道具<select class="wz-in" id="potSpItem" style="padding:2px 4px;width:150px"></select></label>
          <label class="wz-fld">SP 低于<input class="wz-in wz-num" id="potSpPct" value="30"> % 喝</label>
        </div>
        <p class="wz-note">药水需在背包内才会喝；不需要喝时关掉对应勾选即可。优先级：先喝药，血量仍跌破瞬移线才飞。</p>
      </section>

      <section class="wz-panel" data-panel="3">
        <div class="wz-sec-h"><h3>拾取参数</h3><span class="wz-faint">pickupitems.txt</span></div>
        <div class="wz-banner" id="dropBanner"></div>
        <div class="wz-row">
          <label class="wz-fl" data-flag="pickup"><input type="checkbox" checked>自动拾取</label>
          <label class="wz-fl" data-flag="own"><input type="checkbox" checked>只捡自己打的</label>
          <label class="wz-fld">负重超过停捡<input class="wz-in wz-num" id="weightIn" value="90"> %</label>
        </div>
        <div class="wz-sec-h" style="margin-top:var(--sp-4)">
          <h3>本图掉落物</h3><span class="wz-faint" data-drop-hint>已选 0 / 0</span>
          <button class="wz-mini ghost" id="dropAll" style="margin-left:auto">全选</button>
        </div>
        <div class="wz-drop-grid" id="dropGrid"></div>
        <p class="wz-note" data-nomap-note hidden>该图暂无掉落数据，可手动继续配置；卖店/存仓清单与本图掉落物同源。</p>
        <p class="wz-note">写入 pickupitems.txt：勾选 → 1 拾取／带「优先」标的物品 → 2 出现立刻捡／未勾 → 0 不捡。全部显式写入，未勾的也要落盘，才能盖过 <code>all 1</code> 兜底。</p>

        <div class="wz-sec-h" style="margin-top:var(--sp-4)"><h3>回城补给</h3><span class="wz-faint">itemsMaxWeight / sellAuto / storageAuto / buyAuto</span></div>
        <div class="wz-row">
          <label class="wz-fl" data-flag="town"><input type="checkbox" checked>启用回城补给</label>
          <label class="wz-fld">负重 ≥<input class="wz-in wz-num" id="townWeight" value="50"> % 回城</label>
        </div>
        <div class="wz-row">
          <label class="wz-fl" data-flag="sell"><input type="checkbox" checked>卖垃圾</label>
          <span class="wz-faint">回城时把勾选的道具卖店（sellAuto），清单来自上方本图掉落物</span>
        </div>
        <div class="wz-drop-grid" id="sellGrid"></div>
        <div class="wz-row" style="margin-top:var(--sp-2)">
          <label class="wz-fl" data-flag="storage"><input type="checkbox" checked>存仓</label>
          <span class="wz-faint">回城时把勾选的道具存进仓库（storageAuto）</span>
        </div>
        <div class="wz-drop-grid" id="storeGrid"></div>
        <div class="wz-row" style="margin-top:var(--sp-2)">
          <label class="wz-fld">卖店 NPC<input class="wz-in" id="sellNpcIn" value="prontera 105 87" placeholder="地图 x y" style="width:150px"></label>
          <label class="wz-fld">仓库 NPC<input class="wz-in" id="storageNpcIn" value="prontera 146 89" placeholder="地图 x y" style="width:150px"></label>
          <label class="wz-fld">药水 NPC<input class="wz-in" id="potNpcIn" value="prt_in 126 76" placeholder="地图 x y" style="width:150px"></label>
          <label class="wz-fld">补给道具 NPC<input class="wz-in" id="supplyNpcIn" value="prt_in 126 76" placeholder="地图 x y" style="width:150px"></label>
        </div>
        <p class="wz-note">NPC 坐标格式「地图 x y」，默认普隆德拉。药水在「药水 NPC」买（HP/SP 药），苍蝇翅膀和箭矢在「补给道具 NPC」买；药水和箭矢通常不是同一个商人，按实际商店填。第 1 步把回城点（saveMap）改到别的城市时，这里要同步改成该城的卖店/卡普拉/商人。</p>
        <div class="wz-row wz-buy">
          <label class="wz-fl" data-flag="buyHp"><input type="checkbox" checked>买 HP 药</label>
          <label class="wz-fld">道具<select class="wz-in" id="buyHpItem" style="padding:2px 4px;width:140px"></select></label>
          <label class="wz-fld">低于<input class="wz-in wz-num" id="buyHpMin" value="5"> 瓶回城</label>
          <label class="wz-fld">买满到<input class="wz-in wz-num" id="buyHpNum" value="50"> 瓶</label>
        </div>
        <div class="wz-row wz-buy">
          <label class="wz-fl" data-flag="buySp"><input type="checkbox">买 SP 药</label>
          <label class="wz-fld">道具<select class="wz-in" id="buySpItem" style="padding:2px 4px;width:140px"></select></label>
          <label class="wz-fld">低于<input class="wz-in wz-num" id="buySpMin" value="10"> 瓶回城</label>
          <label class="wz-fld">买满到<input class="wz-in wz-num" id="buySpNum" value="30"> 瓶</label>
        </div>
        <div class="wz-row wz-buy">
          <label class="wz-fl" data-flag="buyTp"><input type="checkbox" checked>瞬移道具</label>
          <label class="wz-fld">道具<select class="wz-in" id="buyTpItem" style="padding:2px 4px;width:140px"></select></label>
          <label class="wz-fld">低于<input class="wz-in wz-num" id="buyTpMin" value="3"> 个回城</label>
          <label class="wz-fld">买满到<input class="wz-in wz-num" id="buyTpNum" value="10"> 个</label>
        </div>
        <div class="wz-row wz-buy" data-ranged-only>
          <label class="wz-fl" data-flag="ammo"><input type="checkbox" checked>箭矢补给</label>
          <label class="wz-fld">道具<select class="wz-in" id="attArrow" style="padding:2px 4px;width:140px"></select></label>
          <label class="wz-fld">低于<input class="wz-in wz-num" id="ammoMin" value="50"> 支回城</label>
          <label class="wz-fld">从仓库取到<input class="wz-in wz-num" id="ammoKeep" value="500"> 支</label>
        </div>
        <div class="wz-ammostat" id="ammoNote" data-ranged-only></div>
        <p class="wz-note">回城点 = 第 1 步的 saveMap；卖、存、买完自动返回挂机图。负重阈值与买药种类已按职业原型预设，可改。</p>
      </section>
    </div>

    <div class="wz-foot">
      <button class="wz-btn" id="backBtn">上一步</button>
      <button class="wz-btn primary" id="saveBtn">保存并激活</button>
    </div>

    <div class="wz-modal" id="saveModal" hidden>
      <div class="wz-modal-box">
        <div class="wz-modal-h">
          <h3 id="saveTitle">保存并激活</h3>
          <button class="wz-modal-x" type="button" data-close="saveModal">×</button>
        </div>
        <div class="wz-modal-b" id="saveBody"></div>
        <div class="wz-modal-f" id="saveFoot">
          <button class="wz-btn" type="button" data-close="saveModal">取消</button>
          <button class="wz-btn primary" type="button" id="saveConfirm">确认保存</button>
        </div>
      </div>
    </div>
  </div>`;
}

export function mountKeSetupGuidePage(root: HTMLElement): void {
  document.title = "萌新一键配置 · 露天商店.Ro";
  root.innerHTML = `
    <header class="site-header kg-header">
      <div class="topbar page-width">
        <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
        ${siteNavMarkup("guide")}
      </div>
    </header>
    <main class="kw-main page-width">
      <div class="kw-intro">
        <h1>萌新一键配置</h1>
        <p>四步配出一套能用的挂机方案：选地图 → 拖技能 → 定生存 → 勾拾取，保存即生效。更细的规则以后随时可到「配置工作台」继续调整。</p>
      </div>
      <p class="kw-state" id="kw-state" role="status" aria-live="polite">正在加载角色与配置数据…</p>
      <div id="kw-wiz"></div>
    </main>
    ${footerMarkup()}
  `;
  mountSiteNav(root);
  injectLegalLinksIntoFooters(root);

  const stateEl = root.querySelector<HTMLElement>("#kw-state")!;
  const wizWrap = root.querySelector<HTMLElement>("#kw-wiz")!;

  function showState(message: string, linkHref?: string, linkLabel?: string): void {
    stateEl.hidden = false;
    stateEl.textContent = message;
    if (linkHref) {
      const a = document.createElement("a");
      a.href = linkHref;
      a.textContent = linkLabel ?? "前往";
      a.style.marginLeft = "6px";
      stateEl.appendChild(a);
    }
  }

  async function boot(): Promise<void> {
    const demo = isLocalDemoMode();
    const query = new URLSearchParams(window.location.search);
    let character: KeCharacter | null = null;
    if (demo) {
      // 本地测试可带 ?job=<job_id> 指定职业，默认仍是演示猎人。
      const jobParam = query.get("job");
      const jobId = jobParam && Number.isFinite(Number(jobParam)) ? Number(jobParam) : 11;
      character = {
        aid: 1000001, cid: 2000002, nid: 3000003,
        char_name: jobParam ? "测试角色" : "波利猎人", job_id: jobId, map_name: "prt_fild08",
        last_seen_at: Date.now() - 3 * 60000,
      };
    } else {
      try {
        const body = await keFetch<{ characters: KeCharacter[] }>("/api/v1/ke/characters");
        if (body.characters.length === 0) {
          showState("暂无已绑定角色。请先用进阶客户端登录角色，然后刷新本页。");
          return;
        }
        character =
          body.characters.find(
            (c) =>
              c.aid === Number(query.get("aid")) &&
              c.cid === Number(query.get("cid")) &&
              c.nid === Number(query.get("nid")),
          ) ?? body.characters[0]!;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("AUTH:")) {
          showState("请先登录账号，再回到本页使用一键配置。", "/account", "去登录 →");
        } else {
          showState(error instanceof Error ? error.message : "加载失败，请刷新重试。");
        }
        return;
      }
    }
    stateEl.textContent = "正在加载职业与地图数据…";
    const [options, mapMobs, skillTypes] = await Promise.all([
      fetch("/ke/options.json")
        .then((r) => (r.ok ? (r.json() as Promise<KeOptionsLite>) : null))
        .catch(() => null),
      fetch("/ke/map-mobs.json")
        .then((r) => (r.ok ? (r.json() as Promise<MapMobsData>) : null))
        .catch(() => null),
      fetch("/ke/skill-types.json")
        .then((r) => (r.ok ? (r.json() as Promise<SkillTypesFile>) : null))
        .catch(() => null),
    ]);
    // 本地全职业卡片预览：?demo=1&jobs=1
    if (demo && query.get("jobs") === "1") {
      await renderJobCardGrid(wizWrap, options);
      stateEl.hidden = true;
      return;
    }
    wizWrap.innerHTML = wizardMarkup(demo);
    const wiz = wizWrap.querySelector<HTMLElement>(".ke-wiz");
    if (!wiz) return;
    stateEl.hidden = true;
    initWizard(wiz, { demo, character, options, mapMobs, skillKinds: skillTypes?.skills ?? {} });
  }

  void boot();
}

// 本地测试用：把 options.json 里所有带技能的职业渲染成卡片，点进去按卡片职业预填技能。
async function renderJobCardGrid(container: HTMLElement, options: KeOptionsLite | null): Promise<void> {
  const ids = options
    ? [...new Set([...Object.keys(options.job_skill_groups ?? {}), ...Object.keys(options.job_skills ?? {})])]
    : [];
  if (ids.length === 0) {
    container.innerHTML = `<p class="kw-state">options.json 未加载，无法生成职业卡片。请确认 /ke/options.json 可访问。</p>`;
    return;
  }
  const escHtml = (s: string): string =>
    s.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  let iconMap: Record<string, string> = {};
  try {
    const r = await fetch("/ui/pticons/pticon-map.json", { cache: "force-cache" });
    if (r.ok) iconMap = (await r.json()) as Record<string, string>;
  } catch {
    /* 图标不可用就退回首字 */
  }
  const cards = ids
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => {
      const name = options?.jobs_zh?.[id] ?? options?.jobs?.[id] ?? `职业 ${id}`;
      const en = options?.jobs?.[id] ?? "";
      const icon = iconMap[id] ?? null;
      const iconHtml = icon
        ? `<img src="${escHtml(icon)}" alt="" width="36" height="36" loading="lazy" />`
        : `<i class="kw-job-card-letter">${escHtml(name.slice(0, 1))}</i>`;
      return `
        <a class="kw-job-card" href="/ke/my/create/setup-guide?demo=1&amp;job=${encodeURIComponent(id)}" title="点击按「${escHtml(name)}」读取技能">
          <span class="kw-job-card-icon">${iconHtml}</span>
          <span class="kw-job-card-meta">
            <b>${escHtml(name)}</b>
            <small>#${escHtml(id)}${en ? ` · ${escHtml(en)}` : ""}</small>
          </span>
        </a>`;
    })
    .join("");
  container.innerHTML = `
    <section class="kw-jobs">
      <header class="kw-jobs-head">
        <div>
          <h2>全职业卡片预览</h2>
          <p>共 ${ids.length} 个带技能的职业 ID（同名转生/变体也会各列一张）。点击任意卡片进入一键配置，确认该职业自动读取的攻击/辅助技能。</p>
        </div>
        <a class="kw-link-btn" href="/ke/my?demo=1">返回配置工作台</a>
      </header>
      <div class="kw-jobs-grid">${cards}</div>
    </section>`;
}

function initWizard(wiz: HTMLElement, ctx: WizardCtx): void {
  const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
    wiz.querySelector<T>(sel);
  const qa = <T extends HTMLElement = HTMLElement>(sel: string): T[] =>
    Array.from(wiz.querySelectorAll<T>(sel));
  const esc = (s: string): string =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const flagEl = (name: string): HTMLElement | null => q(`[data-flag="${name}"]`);
  const flagOn = (name: string): boolean => {
    const f = flagEl(name);
    if (!f) return false;
    const on = f.getAttribute("data-on");
    if (on !== null) return on === "1";
    return f.querySelector("input")?.checked ?? false;
  };
  const setFlag = (name: string, on: unknown): void => {
    const f = flagEl(name);
    const cb = f?.querySelector("input");
    if (f && cb) {
      cb.checked = !!on;
      f.setAttribute("data-on", on ? "1" : "0");
    }
  };
  const inputVal = (sel: string): string =>
    q<HTMLInputElement>(sel)?.value.trim() ?? "";

  // —— options.json 索引：技能 id→条目、名字→id；怪物/物品 id→中文名 ——
  const skillByName = new Map<string, number>();
  const skillOptByName = new Map<string, SkillOpt>();
  for (const sk of ctx.options?.skills ?? []) {
    if (sk.nameZh) skillByName.set(sk.nameZh, sk.id);
    if (sk.name && !skillByName.has(sk.name)) skillByName.set(sk.name, sk.id);
    if (sk.handle && !skillByName.has(sk.handle)) skillByName.set(sk.handle, sk.id);
    if (sk.nameZh) skillOptByName.set(sk.nameZh, sk);
    if (sk.name) skillOptByName.set(sk.name, sk);
    if (sk.handle) skillOptByName.set(sk.handle, sk);
  }
  // —— 状态表索引：写 config.txt 的状态条件统一用 EFST_ 句柄（与完整配置页一致），
  // 中文名只用于界面展示，避免依赖 KE 是否认中文状态名。 ——
  const normHandle = (h: string): string => h.toUpperCase().replace(/^EFST_/u, "").replace(/_/gu, "");
  const statusHandleByKey = new Map<string, string>();
  const statusZhByHandle = new Map<string, string>();
  const statusHandleByNorm = new Map<string, string>();
  for (const st of ctx.options?.statuses ?? []) {
    if (!st.handle) continue;
    if (st.nameZh) statusHandleByKey.set(st.nameZh, st.handle);
    if (st.name) statusHandleByKey.set(st.name.toLowerCase(), st.handle);
    statusHandleByKey.set(st.handle.toUpperCase(), st.handle);
    statusZhByHandle.set(st.handle.toUpperCase(), st.nameZh ?? st.name ?? st.handle);
    statusHandleByNorm.set(normHandle(st.handle), st.handle);
  }
  const statusHandleOf = (v: string): string =>
    statusHandleByKey.get(v) ??
    statusHandleByKey.get(v.toLowerCase()) ??
    statusHandleByKey.get(v.toUpperCase()) ??
    v;
  const monsterById = new Map<number, string>();
  for (const m of ctx.options?.monsters ?? []) monsterById.set(m.id, m.name);
  const itemById = new Map<number, string>();
  for (const it of ctx.options?.items ?? []) itemById.set(it.id, it.name);
  // —— 坐骑道具下拉：从图鉴筛出可用坐骑（坐骑/缰绳/骑乘字样，排除箱子、礼包等包装道具） ——
  ((): void => {
    const sel = q<HTMLSelectElement>("#mountItem");
    if (!sel) return;
    const mountRe = /坐骑|缰绳|骑乘/;
    const wrapRe = /箱子|礼盒|礼包|转蛋|兑换券|卷轴/;
    const seen = new Set<string>();
    const names: string[] = [];
    for (const it of ctx.options?.items ?? []) {
      if (!mountRe.test(it.name) || wrapRe.test(it.name) || seen.has(it.name)) continue;
      seen.add(it.name);
      names.push(it.name);
    }
    if (names.length === 0) names.push("坐骑用缰绳");
    const keep = sel.value;
    sel.innerHTML = `<option value="">不使用（关闭自动坐骑）</option>${names
      .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
      .join("")}`;
    if (keep) sel.value = keep;
  })();
  // 生存设置三个道具下拉：HP 药水 / SP 药水；瞬移下拉另由 fillTpSelect 按职业重建（道具 + 技能）
  const setSelectValue = (sel: HTMLSelectElement | null, value: string): void => {
    if (!sel) return;
    if (value && !Array.from(sel.options).some((o) => o.value === value)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      sel.appendChild(opt);
    }
    sel.value = value;
  };
  const fillItemSelect = (selector: string, names: readonly string[], fallback: string): void => {
    const sel = q<HTMLSelectElement>(selector);
    if (sel) sel.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    setSelectValue(sel, fallback);
  };
  // 瞬移下拉随职业重建：本职业拥有的瞬移技能放到「技能」分组，其余仍是道具
  const fillTpSelect = (keep: string): void => {
    const sel = q<HTMLSelectElement>("#tpItem");
    if (!sel) return;
    const ownNames = [...JOB_DATA.atk, ...JOB_DATA.aux.map((a) => a.n)];
    const skills = TELEPORT_SKILLS.filter((n) => ownNames.includes(n));
    const items = TELEPORT_ITEMS.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.innerHTML =
      `<optgroup label="道具">${items}</optgroup>` +
      (skills.length ? `<optgroup label="技能">${skills.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : "");
    sel.value = keep && Array.from(sel.options).some((o) => o.value === keep) ? keep : "苍蝇翅膀";
  };
  fillItemSelect("#potHpItem", HP_POTIONS, "红色药水");
  fillItemSelect("#potSpItem", SP_POTIONS, "蓝色药水");
  // 第 4 步回城补给的购买道具：与对应补给项同一份清单
  fillItemSelect("#buyHpItem", HP_POTIONS, "红色药水");
  fillItemSelect("#buySpItem", SP_POTIONS, "蓝色药水");
  fillItemSelect("#buyTpItem", TELEPORT_ITEMS, "苍蝇翅膀");
  fillItemSelect("#attArrow", ARROW_ITEMS, "铁箭矢");
  fillItemSelect("#eqArrow", ARROW_ITEMS, "铁箭矢");
  const skillSelector = (name: string): string => {
    const id = skillByName.get(name);
    return id !== undefined ? String(id) : name;
  };

  // —— 职业表：优先 options.json 实时构建，失败回退内置 4 职业 ——
  let JOBS: Record<string, JobData> = FALLBACK_JOBS;
  let JOB_LIST: string[] = Object.keys(FALLBACK_JOBS);
  let usingOptions = false;

  // —— 向导状态 ——
  let JOB = "3";
  let JOB_DATA: JobData = FALLBACK_JOBS["3"]!;
  let RANGED = true;
  let ATTACK_SKILLS: AtkPoolSkill[] = [];
  let JOB_ATK_TOTAL = 0;
  let AUX: AuxSkill[] = [];
  let MOBS: Mob[] = [];
  let FALLBACK: FbSkill[] = [{ n: "普通攻击", lv: 0 }];
  let hasMapData = false;
  let uid = 0;
  let openId: string | null = null;
  let openAtk: string | null = null;
  let openSkill: string | null = null;
  let sortDrag: { mobId: string; name: string } | null = null;
  let lastSortAt = 0;
  let current = 0;
  let drag: DragState | null = null;
  let hoverMobId: string | null = null;
  let hoverFb = false;
  let dropRefEl: Element | null = null;

  // 技能 → 真实状态名：先按状态表中文名精确匹配，再用技能 handle 反查状态句柄
  // （AL_INCAGI ↔ EFST_INC_AGI，PR_KYRIE ↔ EFST_KYRIE）；查不到就沿用技能名。
  const statusNameOfSkill = (name: string): string | undefined => {
    const direct = statusHandleOf(name);
    if (direct !== name) return direct;
    const sk = skillOptByName.get(name);
    if (!sk?.handle) return undefined;
    const full = normHandle(sk.handle);
    const hit = statusHandleByNorm.get(full) ?? statusHandleByNorm.get(normHandle(sk.handle.split("_").slice(1).join("_")));
    return hit;
  };
  /** 技能对应的状态名；查不到状态（被动/造物类技能）返回 undefined。 */
  const statusOf = (name: string): string | undefined => {
    const h = statusNameOfSkill(name);
    if (h) return statusZhByHandle.get(h.toUpperCase()) ?? name;
    // 旧映射只在其目标确实是真实状态名时才保留，避免写出 KE 不认识的名字
    const legacy = SKILL_STATUS[name];
    if (legacy && statusHandleByKey.has(legacy)) return legacy;
    return undefined;
  };
  function baseConds(cat: AuxCat, name: string): Cond[] {
    if (cat === "buff") {
      // 查不到状态（如 天使之泪 这类造物/被动技能）就不写状态条件，避免写出 KE 不认识的状态
      const st = statusOf(name);
      return st ? [{ k: "whenStatusInactive", v: st }, { k: "timeout", v: "10" }] : [{ k: "timeout", v: "10" }];
    }
    if (cat === "ground") return [{ k: "whenNotGround", v: name }, { k: "timeout", v: "3" }];
    if (cat === "heal") return [{ k: "hp", v: "< 60%" }, { k: "timeout", v: "1" }];
    return [{ k: "hp", v: "< 40%" }, { k: "aggressives", v: ">= 2" }];
  }
  const mapKeys = (list: Cond[], toTarget: boolean): Cond[] =>
    list.map((c) => ({
      k: toTarget ? (TARGET_KEY[c.k] ?? c.k) : (SELF_KEY[c.k] ?? c.k),
      v: c.v,
    }));
  const scopeDefaults = (sk: ScopeKey, cat: AuxCat, name: string): Cond[] => {
    const base = baseConds(cat, name);
    return sk === "self" ? base : mapKeys(base, true);
  };
  function mk(n: string, c: AuxCat): AuxSkill {
    const p = presetOf(n);
    const cat = p?.cat ?? c;
    uid += 1;
    const scopes = {} as Record<ScopeKey, ScopeState>;
    for (const sk of SCOPE_ORDER) {
      const g: ScopeState = { on: sk === "self", names: "", conds: scopeDefaults(sk, cat, n) };
      const o = p?.scopes[sk];
      if (o) {
        if (o.on != null) g.on = o.on;
        if (o.conds) {
          // %NAME% 无法解析成真实状态时丢掉该条件（仍保留 timeout 等其余条件）
          g.conds = o.conds.flatMap((cc): Cond[] => {
            const v = cc.v === "%NAME%" ? statusOf(n) : cc.v;
            return v === undefined ? [] : [{ k: cc.k, v }];
          });
        }
      }
      scopes[sk] = g;
    }
    return { id: `a${uid}`, name: n, cat, lv: 10, scopes };
  }
  const namesOf = (g: ScopeState): string[] =>
    g.names.split(/[,，;；\s]+/).filter((s) => s !== "");
  const blockCountOf = (sk: ScopeKey, g: ScopeState): number =>
    sk === "self" ? 1 : namesOf(g).length || 1;
  const findAux = (id: string): AuxSkill | undefined => AUX.find((a) => a.id === id);
  const indexOfId = (id: string): number => AUX.findIndex((a) => a.id === id);
  const findMob = (id: string): Mob | undefined => MOBS.find((m) => m.id === id);
  const findMobSkill = (mob: Mob, name: string): MobSkill | undefined =>
    mob.skills.find((s) => s.n === name);
  const poolSkillOf = (name: string): AtkPoolSkill | undefined =>
    ATTACK_SKILLS.find((s) => s.n === name);
  // 卡池里配置好的规则（等级/每只怪次数/条件）在拖到怪身上时整体复制一份
  const mobSkillOf = (name: string): MobSkill => {
    const p = poolSkillOf(name);
    return {
      n: name,
      lvl: p?.lv ?? 10,
      conds: p ? p.conds.map((c) => ({ ...c })) : [],
      ...(p?.maxUses ? { maxUses: p.maxUses } : {}),
    };
  };
  // 卡池规则改动后，同步到所有已绑定该技能的怪
  const syncPoolRule = (name: string): void => {
    const p = poolSkillOf(name);
    if (!p) return;
    for (const m of MOBS) {
      for (const sk of m.skills) {
        if (sk.n !== name) continue;
        sk.lvl = p.lv;
        if (p.maxUses) sk.maxUses = p.maxUses;
        else delete sk.maxUses;
        sk.conds = p.conds.map((c) => ({ ...c }));
      }
    }
  };

  function applySurvPreset(): void {
    const p = SURV_PRESETS[JOB_DATA.surv] ?? SURV_PRESETS.melee;
    setFlag("tp", p.tp); setFlag("sit", p.sit); setFlag("potHp", p.potHp); setFlag("potSp", p.potSp);
    setFlag("town", 1); setFlag("sell", 1); setFlag("storage", 1);
    setFlag("buyHp", p.buyHp); setFlag("buySp", p.buySp);
    setFlag("spfloor", p.spfloor); setFlag("buyTp", p.buyTp);
    const ids = ["tpHp", "tpAggr", "tpDmg", "sitHpLo", "sitHpHi", "sitSpLo", "sitSpHi", "potHpPct", "potSpPct", "townWeight", "buyHpMin", "buyHpNum", "buySpMin", "buySpNum", "spFloor", "buyTpMin", "buyTpNum"];
    for (const id of ids) {
      const el = q<HTMLInputElement>(`#${id}`);
      const v = p[id];
      if (el && v !== undefined) el.value = String(v);
    }
  }

  function applyRangedVisibility(): void {
    for (const el of qa('[data-flag="snipe"],[data-snipe-note],[data-ranged-only]'))
      el.style.display = RANGED ? "" : "none";
  }
  function applyAttackAuto(): void {
    const off = (q<HTMLSelectElement>("#attackAuto")?.value ?? "2") === "0";
    for (const el of qa("[data-combat-only]")) {
      el.style.opacity = off ? ".45" : "";
      el.style.pointerEvents = off ? "none" : "";
      // 灰化同时禁用表单控件：仅靠 opacity + pointer-events 仍可被键盘 Tab 聚焦和修改。
      for (const ctrl of el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
        "input, select, textarea, button",
      ))
        ctrl.disabled = off;
    }
    const n = q("#aaOffNote");
    if (n) n.style.display = off ? "" : "none";
    updateArrowWarn();
  }
  function applyMountVisibility(): void {
    const sec = q("[data-mount-sec]");
    if (sec) sec.style.display = "";
    const combat = JOB_DATA.mount === "combat";
    for (const el of qa("[data-mount-combat],[data-mount-combat-note]"))
      el.style.display = combat ? "" : "none";
    const useItem = !JOB_DATA.mountSkill;
    for (const el of qa("[data-mount-item],[data-mount-item-note]"))
      el.style.display = useItem ? "" : "none";
  }

  // 默认绑定：前 4 只怪绑技能（奇偶交替取第 1/2 技能），其余走兜底；兜底 = 第 1 技能 + 普通攻击
  function applyDefaultBindings(): void {
    MOBS.forEach((m, i) => {
      m.skills = [];
      const first = JOB_DATA.atk[Math.min(i % 2, JOB_DATA.atk.length - 1)];
      if (JOB_DATA.atk.length && i < 4 && first)
        m.skills.push(mobSkillOf(first));
    });
    const firstAtk = JOB_DATA.atk[0];
    FALLBACK = firstAtk
      ? [{ n: firstAtk, lv: 10 }, { n: "普通攻击", lv: 0 }]
      : [{ n: "普通攻击", lv: 0 }];
  }

  function applyJob(id: string): void {
    JOB = id;
    JOB_DATA = JOBS[JOB] ?? {
      name: "未知职业", ranged: false, surv: "melee", mount: false, mountSkill: false, atk: [], aux: [],
    };
    RANGED = JOB_DATA.ranged === true;
    ATTACK_SKILLS = JOB_DATA.atk.map((n) => ({
      n,
      lv: 10,
      conds: [],
      ...(/偷窃|偷钱/.test(n) ? { maxUses: 1 } : {}),
    }));
    JOB_ATK_TOTAL = JOB_DATA.atk.length;
    AUX = JOB_DATA.aux.map((a) => mk(a.n, a.c));
    fillTpSelect(q<HTMLSelectElement>("#tpItem")?.value ?? "");
    openAtk = null;
    openSkill = null;
    openId = null;
    const badge = q("#wzJobBadge");
    if (badge) badge.textContent = JOB_DATA.name;
    const jobLabel = q("#jobLabel");
    if (jobLabel) jobLabel.textContent = JOB_DATA.name;
    applyRangedVisibility();
    applyMountVisibility();
    applySurvPreset();
    applyDefaultBindings();
    q("#sellGrid")?.classList.toggle("wz-off", !flagOn("sell"));
    q("#storeGrid")?.classList.toggle("wz-off", !flagOn("storage"));
    renderMobs();
    renderFb();
    renderAux();
    renderPicker();
    updateArrowWarn();
  }

  // —— 地图数据：锁定地图 → 怪物卡 + 掉落格 + 卖店/存仓格 ——
  function rebuildMapData(): void {
    const map = inputVal("#lockMapIn");
    const entry = ctx.mapMobs?.maps[map] ?? null;
    hasMapData = !!entry;
    for (const el of qa("[data-nomap-note]")) (el as HTMLElement).hidden = !!entry;
    MOBS = entry
      ? entry.mobs.map((id) => ({
          id: `m${id}`,
          name: monsterById.get(id) ?? `怪物 ${id}`,
          skills: [],
        }))
      : [];
    applyDefaultBindings();
    buildDropGrid(entry?.drops ?? []);
    buildTownGrids();
    renderMobs();
    renderFb();
    updateDrops();
    updateAmmo();
    updateArrowWarn();
  }

  function buildDropGrid(dropIds: number[]): void {
    const grid = q("#dropGrid");
    if (!grid) return;
    const arrow = inputVal("#attArrow");
    // 客户端数据里有同名不同 id 的道具（如木锤 1501/1502）；配置按名称写入，
    // 同名只保留一条，避免掉落/卖店/存仓里出现重复行。
    const names = [...new Set(dropIds.map((id) => itemById.get(id) ?? `物品 ${id}`))];
    grid.innerHTML = names
      .map((name) => {
        const tag = RANGED && arrow !== "" && name === arrow ? '<span class="tag">优先</span>' : "";
        return `<label class="wz-drop" data-item="${esc(name)}" data-on="1"><input type="checkbox" checked>${esc(name)}${tag}</label>`;
      })
      .join("");
  }

  // 卖店/存仓清单与本图掉落物同源。首跑默认勾选规则：卡片 / 强化金属 / 矿石 /
  // 装备类默认存仓，其余普通掉落默认卖店，药水 / 翅膀 / 箭矢等自用品两边都不勾；
  // 用户点击勾选才记入 townUserPick，之后换图重建时同名条目沿用其点击结果，
  // 系统按自用品规则强制取消的勾选不会混入用户意图，药名改回去后可恢复默认。
  const TOWN_STORE_RE =
    /卡片|金属|矿石|原石|宝石|钢铁|铝|剑|刀|斧|锤|矛|枪|弓|杖|棍|盾|甲|袍|披风|斗篷|鞋|靴|头盔|帽|发箍|眼镜|手套|拳套|拳刃|制服|围巾|指环|衣服|鞭|琴|书|指虎|耳环|戒指|项链|坠子|翅膀/;
  const townUserPick = new Map<string, { sell?: boolean; store?: boolean }>();

  function buildTownGrids(): void {
    const items = qa("#dropGrid .wz-drop").map((d) => d.getAttribute("data-item") ?? "");
    const selfUse = new Set(
      ["#buyHpItem", "#buySpItem", "#tpItem", "#buyTpItem", "#attArrow", "#eqArrow"]
        .map((sel) => inputVal(sel))
        .filter((x) => x !== ""),
    );
    const defaults = (name: string): { sell: boolean; store: boolean } => {
      if (selfUse.has(name)) return { sell: false, store: false };
      const store = TOWN_STORE_RE.test(name);
      return { sell: !store, store };
    };
    const fill = (gid: string, key: "sell" | "store"): void => {
      const grid = q(gid);
      if (!grid) return;
      grid.innerHTML = "";
      for (const it of items) {
        // 自用品排除优先级最高：道具被改成药水/翅膀/箭矢后强制两边不勾，避免卖掉自己的补给
        const on = selfUse.has(it) ? false : (townUserPick.get(it)?.[key] ?? defaults(it)[key]);
        const l = document.createElement("label");
        l.className = "wz-drop";
        l.setAttribute("data-item", it);
        l.setAttribute("data-on", on ? "1" : "0");
        l.innerHTML = `<input type="checkbox"${on ? " checked" : ""}>${esc(it)}`;
        grid.appendChild(l);
      }
    };
    fill("#sellGrid", "sell");
    fill("#storeGrid", "store");
    q("#sellGrid")?.classList.toggle("wz-off", !flagOn("sell"));
    q("#storeGrid")?.classList.toggle("wz-off", !flagOn("storage"));
  }

  // 箭矢「优先」标跟随当前箭矢道具名移动
  function syncArrowTag(): void {
    const arrow = inputVal("#attArrow");
    for (const d of qa("#dropGrid .wz-drop")) {
      const isArrow = RANGED && arrow !== "" && d.getAttribute("data-item") === arrow;
      const existing = d.querySelector(".tag");
      if (isArrow && !existing) {
        const t = document.createElement("span");
        t.className = "tag";
        t.textContent = "优先";
        d.appendChild(t);
      } else if (!isArrow && existing) {
        existing.remove();
      }
    }
  }

  function updateDrops(): void {
    const drops = qa("#dropGrid .wz-drop");
    let picked = 0;
    let priority = 0;
    for (const d of drops) {
      const cb = d.querySelector("input");
      const on = cb?.checked ?? false;
      d.setAttribute("data-on", on ? "1" : "0");
      if (on) {
        picked += 1;
        if (d.querySelector(".tag")) priority += 1;
      }
    }
    const hint = q("[data-drop-hint]");
    if (hint) hint.textContent = `已选 ${picked} / ${drops.length}`;
    const banner = q("#dropBanner");
    if (banner)
      banner.textContent =
        `已勾选 ${picked} / ${drops.length} 种（其中 ${priority} 种标记优先）` +
        ` · 自动拾取${flagOn("pickup") ? "开" : "关"}` +
        (flagOn("own") ? " · 只捡自己打的" : " · 队友/路人打落的也捡") +
        ` · 负重 ${inputVal("#weightIn") || "90"}% 停捡`;
  }

  function updateAmmo(): void {
    const name = inputVal("#attArrow") || "箭矢";
    const min = inputVal("#ammoMin") || "0";
    const keep = inputVal("#ammoKeep") || "0";
    const note = q("#ammoNote");
    if (note)
      note.textContent = flagOn("ammo")
        ? `写入 items_control.txt：${name} 身上保留 ${keep} 支，多余存仓；getAuto：身上低于 ${min} 支回城，从仓库取到 ${keep} 支（仓库不足时 buyAuto 直接买，不断箭）。`
        : `已关闭自动补给：只写 items_control.txt（${name} 保留 ${keep} 支），箭用完后不会回城取。`;
  }

  function updateArrowWarn(): void {
    const warn = q("[data-arrow-warn]");
    if (warn)
      warn.hidden = !(
        RANGED &&
        (q<HTMLSelectElement>("#attackAuto")?.value ?? "2") !== "0" &&
        !inputVal("#eqArrow")
      );
  }

  /* ========== 渲染 ========== */

  // 攻击技能条件编辑器：完整复用 KE 的自身/怪物条件定义
  const ATK_COND_DEFS = [...CONDITION_KEYS.self, ...CONDITION_KEYS.monster];
  const ATK_MONSTER_KEYS = new Set(CONDITION_KEYS.monster.map((d) => d.key));
  ATK_MONSTER_KEYS.add("dist");
  const ATK_COND_DEF = new Map(ATK_COND_DEFS.map((d) => [d.key, d] as const));
  const ATK_COND_LABEL: Record<string, string> = Object.fromEntries(
    ATK_COND_DEFS.map((d) => [d.key, d.label]),
  );
  ATK_COND_LABEL.dist = "目标距离(格)";
  const condDefOf = (k: string) => ATK_COND_DEF.get(k === "dist" ? "target_dist" : k) ?? ATK_COND_DEF.get(k);
  const condHint = (k: string): string => {
    const def = condDefOf(k);
    switch (def?.widget) {
      case "comparisonPercent":
        return "如 < 30%";
      case "comparisonNum":
        return "如 < 5";
      case "status":
        return "状态名，如 心神凝聚（写盘自动转 EFST 句柄）";
      case "monsters":
        return "怪物名，逗号分隔";
      case "itemAmount":
        return "如 红色药水 > 1";
      case "itemAmountId":
        return "如 501 > 1";
      case "map":
        return "地图名，如 prontera";
      case "skill":
        return "技能名或 ID";
      case "bool":
        return "1=是，0=否";
      case "enum":
        return "0 / 1 / 2";
      case "job":
        return "职业英文名";
      default:
        return def?.hint ?? "值";
    }
  };
  const condOptionHtml = (): string =>
    `<optgroup label="自身条件">${CONDITION_KEYS.self
      .map((d) => `<option value="${d.key}">${d.label}</option>`)
      .join("")}</optgroup>` +
    `<optgroup label="怪物条件">${CONDITION_KEYS.monster
      .map((d) => `<option value="${d.key}">${d.label}</option>`)
      .join("")}</optgroup>`;
  const condInputHtml = (c: Cond, ci: number, attr: string): string => {
    const def = condDefOf(c.k);
    if (def?.widget === "bool") {
      return `<select class="wz-cond-val" data-${attr}="${ci}">
        <option value="">未设置</option>
        <option value="1"${c.v === "1" ? " selected" : ""}>是</option>
        <option value="0"${c.v === "0" ? " selected" : ""}>否</option>
      </select>`;
    }
    if (def?.widget === "enum" && def.options?.length) {
      return `<select class="wz-cond-val" data-${attr}="${ci}">
        <option value="">未设置</option>
        ${def.options
          .map((o) => `<option value="${esc(o.value)}"${c.v === o.value ? " selected" : ""}>${esc(o.label)}</option>`)
          .join("")}
      </select>`;
    }
    return `<input data-${attr}="${ci}" value="${esc(c.v)}" placeholder="${esc(condHint(c.k))}">`;
  };
  const condRowHtml = (c: Cond, ci: number, delAttr: string, valAttr: string): string => {
    const def = condDefOf(c.k);
    return `<div class="wz-crow">
      <span class="wz-cond-tag">${ATK_MONSTER_KEYS.has(c.k) ? "怪" : "自"}</span>
      <span style="flex:1" title="${esc(def?.help ?? "")}">${esc(condLabel(c.k))}</span>
      ${condInputHtml(c, ci, valAttr)}
      <button class="wz-mini ghost" data-${delAttr}="${ci}">×</button>
    </div>`;
  };
  // 辅助技能条件编辑器可用的条件 key（other 作用域保存时映射为 target_*）
  const AUX_COND_KEYS = ["whenStatusInactive", "whenStatusActive", "whenNotGround", "hp", "sp", "aggressives", "timeout"] as const;
  const condLabel = (k: string): string => ATK_COND_LABEL[k] ?? COND_LABEL[k] ?? k;
  const CAT_CYCLE: AuxCat[] = ["buff", "ground", "heal", "survival"];

  function poolEditorHtml(s: AtkPoolSkill): string {
    const lvOpts = Array.from({ length: 10 }, (_, i) => i + 1)
      .map((l) => `<option value="${l}"${s.lv === l ? " selected" : ""}>Lv.${l}</option>`)
      .join("");
    const rows = s.conds.map((c, ci) => condRowHtml(c, ci, "sedel", "secv")).join("");
    return `<div class="wz-atkedit" data-pooledit>
      <div class="wz-crow">
        <span>技能</span>
        <b>${esc(s.n)}</b>
        <span class="wz-faint" style="flex:1">以下规则拖到怪时整份套用</span>
        <button class="wz-mini ghost" data-sclose>收起</button>
      </div>
      <div class="wz-crow">
        <span>等级</span>
        <select class="wz-atk-lvl" data-slvl>${lvOpts}</select>
      </div>
      <div class="wz-crow">
        <span>每只怪最多</span>
        <input class="wz-max-num" type="number" min="1" step="1" data-smax value="${s.maxUses ?? ""}" placeholder="不限">
        <span class="wz-faint">次（留空=不限，偷窃建议 1）</span>
      </div>
      ${rows}
      <div class="wz-crow">
        <select data-snk>${condOptionHtml()}</select>
        <input data-snv placeholder="${esc(condHint("hp"))}">
        <button class="wz-mini" data-snadd>＋条件</button>
      </div>
    </div>`;
  }

  function renderSkills(): void {
    const pool = q("#skillPool");
    if (!pool) return;
    pool.innerHTML =
      ATTACK_SKILLS.map(
        (s) => `<div class="wz-skill" data-skill="${esc(s.n)}">
          <span class="wz-grip2">⠿</span>
          <span class="wz-sk-n">${esc(s.n)}</span>
          <span class="wz-lv">Lv.${s.lv}</span>
          ${s.maxUses ? `<span class="wz-rulex">×${s.maxUses}</span>` : ""}
          ${s.conds.length ? `<span class="wz-rulex">${s.conds.length}条件</span>` : ""}
          <button class="wz-mini ghost wz-poolset" data-poolset="${esc(s.n)}" title="设置技能规则">规则</button>
          <span class="wz-cnt" data-cnt="${esc(s.n)}">0</span>
        </div>`,
      ).join("") || '<span class="wz-faint">本职业无攻击技能</span>';
    const editor = q("#skillPoolEditor");
    const open = openSkill ? poolSkillOf(openSkill) : undefined;
    if (editor) editor.innerHTML = open ? poolEditorHtml(open) : "";
    updateSkillCount();
  }

  function updateSkillCount(): void {
    const used: Record<string, number> = {};
    let bound = 0;
    for (const m of MOBS) {
      if (m.deleted) continue;
      for (const sk of m.skills) {
        used[sk.n] = (used[sk.n] ?? 0) + 1;
        bound += 1;
      }
    }
    for (const f of FALLBACK) if (f.n !== "普通攻击") used[f.n] = (used[f.n] ?? 0) + 1;
    for (const el of qa("[data-cnt]")) el.textContent = String(used[el.getAttribute("data-cnt") ?? ""] ?? 0);
    const sc = q("#skillCount");
    if (sc) sc.textContent = `已绑定 ${bound} / 共 ${JOB_ATK_TOTAL}`;
  }

  function atkEditorHtml(m: Mob, sk: MobSkill): string {
    const lvOpts = Array.from({ length: 10 }, (_, i) => i + 1)
      .map((l) => `<option value="${l}"${sk.lvl === l ? " selected" : ""}>Lv.${l}</option>`)
      .join("");
    const rows = sk.conds.map((c, ci) => condRowHtml(c, ci, "edel", "ecv")).join("");
    return `<div class="wz-atkedit" data-atkedit>
      <div class="wz-crow">
        <span>等级</span>
        <select class="wz-atk-lvl" data-atklvl>${lvOpts}</select>
        <span class="wz-faint">对「${esc(m.name)}」· attackSkillSlot（monsters=${esc(m.name)}）</span>
      </div>
      <div class="wz-crow">
        <span>每只怪最多</span>
        <input class="wz-max-num" type="number" min="1" step="1" data-emax value="${sk.maxUses ?? ""}" placeholder="不限" style="flex:1">
        <span class="wz-faint">次（留空=不限，偷窃建议 1）</span>
      </div>
      ${rows}
      <div class="wz-crow">
        <select data-nk>${condOptionHtml()}</select>
        <input data-nv placeholder="${esc(condHint("hp"))}">
        <button class="wz-mini" data-nadd>＋条件</button>
      </div>
    </div>`;
  }

  function renderMobs(): void {
    const grid = q("#mobGrid");
    if (grid) {
      grid.innerHTML = MOBS.filter((m) => !m.deleted)
        .map((m) => {
          const binds = m.skills
            .map((sk, i) => {
              const key = `${m.id}|${sk.n}`;
              return `<span class="wz-bind${sk.conds.length ? " has-cond" : ""}${openAtk === key ? " is-open" : ""}" data-bind="${esc(key)}" data-sortmob="${esc(m.id)}" data-sortname="${esc(sk.n)}" draggable="true" title="点击编辑；拖动可调整顺序"><b>${i + 1}</b>${esc(sk.n)}<i class="wz-bind-lv">Lv.${sk.lvl}${sk.maxUses ? ` · ${sk.maxUses}次` : ""}</i><em data-unbind="${esc(key)}" title="解绑">×</em></span>`;
            })
            .join("");
          const openSk = openAtk?.startsWith(m.id + "|")
            ? m.skills.find((s) => `${m.id}|${s.n}` === openAtk)
            : undefined;
          return `<div class="wz-mob" data-mob="${m.id}">
            <div class="wz-mob-h">
              <span class="wz-mob-n">${esc(m.name)}</span>
              <span class="wz-mob-lv">${m.skills.length ? `${m.skills.length} 技` : ""}</span>
              <button class="wz-mx" data-pri="${m.id}" title="优先击杀"${m.pri ? ' style="color:#c69445"' : ""}>${m.pri ? "★" : "☆"}</button>
              <button class="wz-mx" data-del="${m.id}" title="不打这只怪">×</button>
            </div>
            <div class="wz-mob-b">${binds || '<span class="wz-mob-none">拖技能到这里绑定</span>'}</div>
            ${openSk ? atkEditorHtml(m, openSk) : ""}
          </div>`;
        })
        .join("");
    }
    renderRemoved();
    const alive = MOBS.filter((m) => !m.deleted).length;
    const mc = q("#mobCount");
    if (mc) mc.textContent = `${alive} / ${MOBS.length} 在打`;
    renderOrder();
  }

  function renderRemoved(): void {
    const bar = q("#removedBar");
    if (!bar) return;
    const removed = MOBS.filter((m) => m.deleted);
    bar.hidden = removed.length === 0;
    bar.innerHTML = removed.length
      ? "已删除：" +
        removed.map((m) => `<span class="wz-restore" data-restore="${m.id}">${esc(m.name)} ↩</span>`).join(" ") +
        '<span class="wz-restore-all" data-restoreall>全部恢复</span>'
      : "";
  }

  function renderFb(): void {
    const el = q("#fbList");
    if (!el) return;
    el.innerHTML = FALLBACK.map(
      (f, i) => `<div class="wz-fb" data-fb="${esc(f.n)}">
        <span class="wz-grip2">⠿</span>
        <span class="wz-sk-n">${esc(f.n)}</span>
        ${f.lv > 0 ? `<span class="wz-lv">Lv.${f.lv}</span>` : ""}
        <span class="wz-rank">兜底 ${i + 1}</span>
        ${f.n === "普通攻击" ? "" : `<button class="wz-fb-del" data-fbdel="${esc(f.n)}" title="移出兜底">×</button>`}
      </div>`,
    ).join("");
    renderOrder();
  }

  function renderOrder(): void {
    const el = q("#orderList");
    if (!el) return;
    const rows: string[] = [];
    let i = 0;
    for (const m of MOBS) {
      if (m.deleted) continue;
      for (const sk of m.skills) {
        i += 1;
        const conds = sk.conds.length
          ? sk.conds.map((c) => `${condLabel(c.k)} ${c.v}`).join("；")
          : "无条件";
        rows.push(`<div class="wz-ord"><b>${i}</b><span class="wz-ord-n">${esc(sk.n)}<i>Lv.${sk.lvl}${sk.maxUses ? ` · ${sk.maxUses}次` : ""}</i></span><span class="wz-ord-t">attackSkillSlot</span><span class="wz-ord-s">${esc(m.name)} · ${esc(conds)}</span></div>`);
      }
    }
    for (const f of FALLBACK) {
      i += 1;
      rows.push(`<div class="wz-ord"><b>${i}</b><span class="wz-ord-n">${esc(f.n)}${f.lv > 0 ? `<i>Lv.${f.lv}</i>` : ""}</span><span class="wz-ord-t">兜底</span><span class="wz-ord-s">所有未绑定怪</span></div>`);
    }
    el.innerHTML = rows.join("") || '<div class="wz-ord"><span class="wz-faint">尚无攻击技能</span></div>';
  }

  function condEditorHtml(a: AuxSkill, sk: ScopeKey): string {
    const g = a.scopes[sk];
    const rows = g.conds
      .map(
        (c, ci) => `<div class="wz-crow">
        <span style="flex:1">${esc(condLabel(c.k))}</span>
        <input data-acv="${ci}" value="${esc(c.v)}">
        <button class="wz-mini ghost" data-acdel="${ci}">×</button>
      </div>`,
      )
      .join("");
    return `<div class="wz-condedit" data-condediting="${a.id}:${sk}">
      ${rows}
      <div class="wz-crow">
        <select data-ank>${AUX_COND_KEYS.map((k) => `<option value="${k}">${COND_LABEL[k] ?? k}</option>`).join("")}</select>
        <input data-anv placeholder="如 &lt; 30%">
        <button class="wz-mini" data-anadd>＋条件</button>
      </div>
      <div class="wz-crow-actions"><span class="wz-faint">作用于「${SCOPE_LABEL[sk]}」· 写入 ${SCOPE_BLOCK[sk]}</span></div>
    </div>`;
  }

  function renderAux(): void {
    const grid = q("#auxGrid");
    if (!grid) return;
    grid.innerHTML =
      AUX.map((a, idx) => {
        const scopeBtns = SCOPE_ORDER.map(
          (sk) =>
            `<button class="wz-scp${a.scopes[sk].on ? " on" : ""}" data-scope="${a.id}:${sk}">${SCOPE_LABEL[sk]}</button>`,
        ).join("");
        const groups = SCOPE_ORDER.filter((sk) => a.scopes[sk].on)
          .map((sk) => {
            const g = a.scopes[sk];
            const chips = g.conds.length
              ? g.conds
                  .map(
                    (c) =>
                      `<button class="wz-chip" data-condedit="${a.id}:${sk}" title="点击编辑条件">${esc(condLabel(c.k))} ${esc(c.v)}</button>`,
                  )
                  .join("")
              : `<button class="wz-chip wz-chip-empty" data-condedit="${a.id}:${sk}">＋条件</button>`;
            const names =
              sk === "other"
                ? `<input class="wz-tname wz-tname-wide" data-names="${a.id}" value="${esc(g.names)}" placeholder="队友名，逗号分隔；留空=任意队友">`
                : "";
            const editor = openId === `${a.id}:${sk}` ? condEditorHtml(a, sk) : "";
            return `<div class="wz-scopeg">
              <div class="wz-scopeg-h"><span>${SCOPE_LABEL[sk]}</span><code class="wz-blk">${SCOPE_BLOCK[sk]}</code>${names}<span class="wz-faint" data-bcount>${blockCountOf(sk, g)} 条</span></div>
              <div class="wz-chips">${chips}</div>
              ${editor}
            </div>`;
          })
          .join("");
        return `<div class="wz-aux${openId?.startsWith(a.id + ":") ? " is-open" : ""}" data-aux="${a.id}">
          <div class="wz-aux-h">
            <span class="wz-grip">⠿</span>
            <span class="wz-idx">${idx + 1}</span>
            <strong>${esc(a.name)}</strong>
            <select class="wz-cat wz-cat-sel t-${a.cat}" data-cat="${a.id}" title="选择技能类别（仍是旧类别默认值的条件会跟随换新）">${CAT_CYCLE.map((c) => `<option value="${c}"${c === a.cat ? " selected" : ""}>${CAT_LABEL[c]}</option>`).join("")}</select>
            <select class="wz-aux-lv" data-auxlv="${a.id}" title="按角色实际学到的等级选择，写入 useSelf_skill / partySkill 的 lvl">${Array.from({ length: 10 }, (_, i) => i + 1).map((l) => `<option value="${l}"${a.lv === l ? " selected" : ""}>Lv.${l}</option>`).join("")}</select>
            <button class="wz-x" data-auxrm="${a.id}" title="移除">×</button>
          </div>
          <div class="wz-scopes">${scopeBtns}</div>
          ${groups}
        </div>`;
      })
      .join("") || '<div class="wz-faint">尚未添加辅助技能，点上方「+ 添加辅助技能」。</div>';
    renderAuxWarn();
    renderPicker();
  }

  function renderAuxWarn(): void {
    const box = q("#auxWarn");
    if (!box) return;
    const msgs: string[] = [];
    if (!AUX.length) msgs.push("还没有辅助技能：增益/治疗/保命类技能建议在「+ 添加辅助技能」里挑几个。");
    for (const a of AUX) {
      for (const sk of SCOPE_ORDER) {
        const g = a.scopes[sk];
        if (g.on && !g.conds.length) msgs.push(`「${a.name}」（${SCOPE_LABEL[sk]}）未设条件，冷却一好就放`);
      }
    }
    box.hidden = msgs.length === 0;
    box.innerHTML = msgs
      .slice(0, 6)
      .map((m) => `<p class="w"><span class="dot"></span>${esc(m)}</p>`)
      .join("");
  }

  function renderPicker(): void {
    const body = q("#pickerBody");
    if (!body) return;
    const pool: AuxSeed[] = usingOptions ? JOB_DATA.aux : AUX_POOL;
    const cats = (Object.keys(CAT_ORDER) as AuxCat[]).sort((x, y) => CAT_ORDER[x] - CAT_ORDER[y]);
    body.innerHTML =
      cats
        .map((cat) => {
          const items = pool.filter((s) => s.c === cat);
          if (!items.length) return "";
          const btns = items
            .map((s) => {
              const added = AUX.some((a) => a.name === s.n);
              return `<button class="wz-pitem" data-addaux="${esc(s.n)}"${added ? " disabled" : ""}>${esc(s.n)}</button>`;
            })
            .join("");
          return `<div class="wz-pgroup"><span class="wz-faint">${CAT_LABEL[cat]}</span><div>${btns}</div></div>`;
        })
        .join("") || '<span class="wz-faint">没有可添加的技能</span>';
  }

  function setCat(id: string, next: AuxCat): void {
    const a = findAux(id);
    if (!a || a.cat === next) return;
    for (const sk of SCOPE_ORDER) {
      const g = a.scopes[sk];
      const def = scopeDefaults(sk, a.cat, a.name);
      const same =
        g.conds.length === def.length &&
        g.conds.every((c, i) => c.k === def[i]!.k && c.v === def[i]!.v);
      if (same) g.conds = scopeDefaults(sk, next, a.name);
    }
    a.cat = next;
    renderAux();
  }

  function goto(n: number): void {
    current = n;
    for (const p of qa(".wz-panel")) p.classList.toggle("is-on", p.getAttribute("data-panel") === String(n));
    for (const s of qa(".wz-step")) s.classList.toggle("is-on", s.getAttribute("data-step") === String(n));
    const back = q<HTMLButtonElement>("#backBtn");
    if (back) back.disabled = n === 0;
    const save = q("#saveBtn");
    if (save) save.textContent = n === 3 ? "保存并激活" : "下一步 →";
  }

  /* ========== 拖拽（Pointer Events） ========== */

  function clearMarks(): void {
    for (const x of qa(".wz-mob.drop-target")) x.classList.remove("drop-target");
    q("#fbList")?.classList.remove("drop-target");
    for (const x of qa(".wz-fb.drop-before")) x.classList.remove("drop-before");
    for (const x of qa(".wz-aux.drop-before")) x.classList.remove("drop-before");
    hoverMobId = null;
    hoverFb = false;
    dropRefEl = null;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("select,button,input,textarea,.wz-condedit,.wz-atkedit")) return;
    const skillEl = t.closest<HTMLElement>(".wz-skill");
    const fbEl = t.closest<HTMLElement>(".wz-fb");
    const auxEl = t.closest<HTMLElement>(".wz-aux");
    if (skillEl?.dataset["skill"]) {
      drag = { kind: "skill", name: skillEl.dataset["skill"] ?? "", el: skillEl, sx: e.clientX, sy: e.clientY, active: false };
    } else if (fbEl?.dataset["fb"]) {
      drag = { kind: "fb", name: fbEl.dataset["fb"] ?? "", el: fbEl, sx: e.clientX, sy: e.clientY, active: false };
    } else if (auxEl?.dataset["aux"]) {
      drag = { kind: "aux", name: auxEl.dataset["aux"] ?? "", el: auxEl, sx: e.clientX, sy: e.clientY, active: false };
    }
    if (!drag) return;
    e.preventDefault();
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);
    try {
      drag.el.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略不支持 pointer capture 的环境 */
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.active = true;
      drag.el.classList.add("is-dragging");
    }
    e.preventDefault();
    // 让卡片跟着指针走，产生真实的“拖动卡片”效果
    drag.el.style.transform = `translate(${dx}px, ${dy}px)`;
    clearMarks();
    // 被拖卡片本身在指针下面，用 elementsFromPoint 跳过它及子元素
    const under = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((x) => !drag?.el.contains(x)) ?? null;
    if (drag.kind === "skill") {
      const fb = under?.closest("#fbList");
      const mob = under?.closest<HTMLElement>(".wz-mob");
      if (fb) {
        fb.classList.add("drop-target");
        hoverFb = true;
      } else if (mob?.dataset["mob"]) {
        mob.classList.add("drop-target");
        hoverMobId = mob.dataset["mob"] ?? null;
      }
    } else if (drag.kind === "fb") {
      const chip = under?.closest<HTMLElement>(".wz-fb");
      if (chip && chip !== drag.el) {
        chip.classList.add("drop-before");
        dropRefEl = chip;
      }
    } else if (drag.kind === "aux") {
      const card = under?.closest<HTMLElement>(".wz-aux");
      if (card && card !== drag.el) {
        card.classList.add("drop-before");
        dropRefEl = card;
      }
    }
  }

  function endDrag(): void {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", endDrag);
    document.removeEventListener("pointercancel", endDrag);
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.style.transform = "";
    d.el.classList.remove("is-dragging");
    if (d.active) {
      if (d.kind === "skill") {
        if (hoverMobId) {
          const m = findMob(hoverMobId);
          if (m && !m.deleted) {
            const exist = findMobSkill(m, d.name);
            if (exist) {
              m.skills = m.skills.filter((s) => s.n !== d.name);
              m.skills.unshift(exist);
            } else {
              m.skills.unshift(mobSkillOf(d.name));
            }
            openAtk = null;
            renderMobs();
            updateSkillCount();
          }
        } else if (hoverFb) {
          if (!FALLBACK.some((f) => f.n === d.name)) FALLBACK.push({ n: d.name, lv: poolSkillOf(d.name)?.lv ?? 10 });
          renderFb();
          updateSkillCount();
        }
      } else if (d.kind === "fb" && dropRefEl) {
        const from = FALLBACK.findIndex((f) => f.n === d.name);
        const to = FALLBACK.findIndex((f) => f.n === dropRefEl?.getAttribute("data-fb"));
        if (from >= 0 && to >= 0 && from !== to) {
          const item = FALLBACK.splice(from, 1)[0]!;
          FALLBACK.splice(to, 0, item);
          renderFb();
        }
      } else if (d.kind === "aux" && dropRefEl) {
        const from = indexOfId(d.name);
        const to = indexOfId(dropRefEl.getAttribute("data-aux") ?? "");
        if (from >= 0 && to >= 0 && from !== to) {
          const item = AUX.splice(from, 1)[0]!;
          AUX.splice(to, 0, item);
          renderAux();
        }
      }
    }
    clearMarks();
  }

  wiz.addEventListener("pointerdown", onPointerDown);

  /* ========== 点击 / 表单事件 ========== */

  const parseOpenAtk = (): { m: Mob; sk: MobSkill } | null => {
    if (!openAtk) return null;
    const [mid, ...rest] = openAtk.split("|");
    const m = mid ? findMob(mid) : undefined;
    const sk = m?.skills.find((s) => s.n === rest.join("|"));
    return m && sk ? { m, sk } : null;
  };

  wiz.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    const stepBtn = t.closest("[data-step]");
    if (stepBtn) {
      goto(Number(stepBtn.getAttribute("data-step")));
      return;
    }

    const pri = t.closest("[data-pri]");
    if (pri) {
      const m = findMob(pri.getAttribute("data-pri") ?? "");
      if (m) {
        m.pri = !m.pri;
        renderMobs();
      }
      return;
    }

    const del = t.closest("[data-del]");
    if (del) {
      const m = findMob(del.getAttribute("data-del") ?? "");
      if (m) {
        m.deleted = true;
        if (openAtk?.startsWith(m.id + "|")) openAtk = null;
        renderMobs();
        updateSkillCount();
      }
      return;
    }

    const restore = t.closest("[data-restore]");
    if (restore) {
      const m = findMob(restore.getAttribute("data-restore") ?? "");
      if (m) {
        m.deleted = false;
        renderMobs();
        updateSkillCount();
      }
      return;
    }

    if (t.closest("[data-restoreall]")) {
      for (const m of MOBS) m.deleted = false;
      renderMobs();
      updateSkillCount();
      return;
    }

    const poolset = t.closest("[data-poolset]");
    if (poolset) {
      const name = poolset.getAttribute("data-poolset") ?? "";
      openSkill = openSkill === name ? null : name;
      renderSkills();
      return;
    }

    if (t.closest("[data-sclose]")) {
      openSkill = null;
      renderSkills();
      return;
    }

    const sedel = t.closest("[data-sedel]");
    if (sedel) {
      const s = openSkill ? poolSkillOf(openSkill) : undefined;
      if (s) {
        s.conds.splice(Number(sedel.getAttribute("data-sedel")), 1);
        syncPoolRule(s.n);
        renderSkills();
        renderMobs();
      }
      return;
    }

    const snadd = t.closest("[data-snadd]");
    if (snadd) {
      const holder = snadd.closest("[data-pooledit]");
      const keyEl = holder?.querySelector<HTMLSelectElement>("[data-snk]");
      const valEl = holder?.querySelector<HTMLInputElement>("[data-snv]");
      const s = openSkill ? poolSkillOf(openSkill) : undefined;
      const v = valEl?.value.trim() ?? "";
      if (s && keyEl && v) {
        s.conds.push({ k: keyEl.value, v });
        syncPoolRule(s.n);
        renderSkills();
        renderMobs();
      }
      return;
    }

    const unbind = t.closest("[data-unbind]");
    if (unbind) {
      const key = unbind.getAttribute("data-unbind") ?? "";
      const [mid, ...rest] = key.split("|");
      const m = mid ? findMob(mid) : undefined;
      const name = rest.join("|");
      if (m) {
        m.skills = m.skills.filter((s) => s.n !== name);
        if (openAtk === key) openAtk = null;
        renderMobs();
        updateSkillCount();
      }
      return;
    }

    const bind = t.closest("[data-bind]");
    if (bind) {
      if (Date.now() - lastSortAt < 400) return;
      const key = bind.getAttribute("data-bind") ?? "";
      openAtk = openAtk === key ? null : key;
      renderMobs();
      return;
    }

    const fbdel = t.closest("[data-fbdel]");
    if (fbdel) {
      FALLBACK = FALLBACK.filter((f) => f.n !== (fbdel.getAttribute("data-fbdel") ?? ""));
      renderFb();
      updateSkillCount();
      return;
    }

    const scopeBtn = t.closest("[data-scope]");
    if (scopeBtn) {
      const [aid, sk] = (scopeBtn.getAttribute("data-scope") ?? "").split(":");
      const a = findAux(aid ?? "");
      if (a && (sk === "self" || sk === "other")) {
        a.scopes[sk].on = !a.scopes[sk].on;
        if (!a.scopes[sk].on && openId === `${a.id}:${sk}`) openId = null;
        renderAux();
      }
      return;
    }

    const auxrm = t.closest("[data-auxrm]");
    if (auxrm) {
      const id = auxrm.getAttribute("data-auxrm") ?? "";
      AUX = AUX.filter((a) => a.id !== id);
      if (openId?.startsWith(id + ":")) openId = null;
      renderAux();
      return;
    }

    const condedit = t.closest("[data-condedit]");
    if (condedit) {
      const key = condedit.getAttribute("data-condedit") ?? "";
      openId = openId === key ? null : key;
      renderAux();
      return;
    }

    const acdel = t.closest("[data-acdel]");
    if (acdel) {
      const [aid, sk] = (openId ?? "").split(":");
      const a = findAux(aid ?? "");
      if (a && (sk === "self" || sk === "other")) {
        a.scopes[sk].conds.splice(Number(acdel.getAttribute("data-acdel")), 1);
        renderAux();
      }
      return;
    }

    const anadd = t.closest("[data-anadd]");
    if (anadd) {
      const holder = anadd.closest("[data-condediting]");
      const [aid, sk] = (holder?.getAttribute("data-condediting") ?? "").split(":");
      const a = findAux(aid ?? "");
      const keyEl = holder?.querySelector<HTMLSelectElement>("[data-ank]");
      const valEl = holder?.querySelector<HTMLInputElement>("[data-anv]");
      const v = valEl?.value.trim() ?? "";
      if (a && (sk === "self" || sk === "other") && keyEl && v) {
        const k = sk === "other" ? (TARGET_KEY[keyEl.value] ?? keyEl.value) : keyEl.value;
        a.scopes[sk].conds.push({ k, v });
        renderAux();
      }
      return;
    }

    const edel = t.closest("[data-edel]");
    if (edel) {
      const found = parseOpenAtk();
      if (found) {
        found.sk.conds.splice(Number(edel.getAttribute("data-edel")), 1);
        renderMobs();
      }
      return;
    }

    const nadd = t.closest("[data-nadd]");
    if (nadd) {
      const holder = nadd.closest("[data-atkedit]");
      const keyEl = holder?.querySelector<HTMLSelectElement>("[data-nk]");
      const valEl = holder?.querySelector<HTMLInputElement>("[data-nv]");
      const found = parseOpenAtk();
      const v = valEl?.value.trim() ?? "";
      if (found && keyEl && v) {
        found.sk.conds.push({ k: keyEl.value, v });
        renderMobs();
      }
      return;
    }

    if (t.closest("#addAux")) {
      const p = q("#auxPicker");
      if (p) p.hidden = !p.hidden;
      return;
    }

    const addaux = t.closest("[data-addaux]");
    if (addaux) {
      const name = addaux.getAttribute("data-addaux") ?? "";
      const pool: AuxSeed[] = usingOptions ? JOB_DATA.aux : AUX_POOL;
      const seed = pool.find((s) => s.n === name);
      if (seed && !AUX.some((a) => a.name === seed.n)) {
        AUX.push(mk(seed.n, seed.c));
        renderAux();
      }
      return;
    }

    const pickmap = t.closest<HTMLElement>("[data-pickmap]");
    if (pickmap) {
      const field = pickmap.getAttribute("data-pickmap") === "save" ? "save" : "lock";
      const input = q<HTMLInputElement>(field === "lock" ? "#lockMapIn" : "#saveMapIn");
      openWorldmapPicker(wiz, {
        title: field === "lock" ? "挂机地图" : "回城地图",
        value: input?.value.trim() ?? "",
        trigger: pickmap,
        onSelect: (code) => {
          if (!input) return;
          input.value = code;
          if (field === "lock") rebuildMapData();
        },
      });
      return;
    }

    const closeBtn = t.closest("[data-close]");
    if (closeBtn) {
      const modal = q("#" + (closeBtn.getAttribute("data-close") ?? ""));
      if (modal === saveModal) closeSaveModal();
      else if (modal) modal.hidden = true;
      return;
    }

    if (t.closest("#dropAll")) {
      // 与原型一致：全选 → 全不选，否则 → 全选
      const boxes = qa<HTMLInputElement>("#dropGrid .wz-drop input");
      const allOn = boxes.every((b) => b.checked);
      for (const b of boxes) b.checked = !allOn;
      updateDrops();
      return;
    }
  });

  wiz.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    const flagLabel = t.closest("[data-flag]");
    if (flagLabel && t instanceof HTMLInputElement && t.type === "checkbox") {
      const name = flagLabel.getAttribute("data-flag") ?? "";
      flagLabel.setAttribute("data-on", t.checked ? "1" : "0");
      if (name === "follow") syncFollow();
      if (name === "sell") q("#sellGrid")?.classList.toggle("wz-off", !t.checked);
      if (name === "storage") q("#storeGrid")?.classList.toggle("wz-off", !t.checked);
      if (name === "pickup" || name === "own") updateDrops();
      if (name === "ammo") {
        syncArrowTag();
        updateAmmo();
        updateDrops();
      }
      return;
    }

    if (t instanceof HTMLSelectElement && t.hasAttribute("data-cat")) {
      const next = t.value as AuxCat;
      if (next in CAT_LABEL) setCat(t.getAttribute("data-cat") ?? "", next);
      return;
    }

    if (t instanceof HTMLSelectElement && t.hasAttribute("data-auxlv")) {
      const a = findAux(t.getAttribute("data-auxlv") ?? "");
      const lv = Number(t.value);
      if (a && lv >= 1) a.lv = lv;
      renderAux();
      return;
    }

    if (t.hasAttribute("data-snk") || t.hasAttribute("data-nk")) {
      const holder = t.closest("[data-pooledit], [data-atkedit]");
      const inp = holder?.querySelector<HTMLInputElement>("[data-snv], [data-nv]");
      if (inp) inp.placeholder = condHint((t as HTMLSelectElement).value);
      return;
    }
    if (t.hasAttribute("data-slvl")) {
      const s = openSkill ? poolSkillOf(openSkill) : undefined;
      if (s) {
        s.lv = Number((t as HTMLSelectElement).value);
        syncPoolRule(s.n);
        renderMobs();
        renderSkills();
      }
      return;
    }
    if (t.hasAttribute("data-smax")) {
      const s = openSkill ? poolSkillOf(openSkill) : undefined;
      const n = Math.floor(Number((t as HTMLInputElement).value.trim()));
      if (s) {
        if (Number.isFinite(n) && n > 0) s.maxUses = n;
        else delete s.maxUses;
        syncPoolRule(s.n);
        renderMobs();
        renderSkills();
      }
      return;
    }
    if (t.hasAttribute("data-emax")) {
      const found = parseOpenAtk();
      const val = (t as HTMLInputElement).value.trim();
      if (found) {
        const n = Math.floor(Number(val));
        if (Number.isFinite(n) && n > 0) found.sk.maxUses = n;
        else delete found.sk.maxUses;
        renderMobs();
      }
      return;
    }
    if (t.id === "attackAuto") {
      applyAttackAuto();
      return;
    }
    if (t.id === "lockMapIn") {
      rebuildMapData();
      return;
    }
    if (t.id === "buyHpItem" || t.id === "buySpItem") {
      // 药水改名即时重建卖/存清单：把清单里已勾的道具改成自用品后立刻取消勾选
      buildTownGrids();
      return;
    }
    if (t.id === "eqArrow" || t.id === "attArrow") {
      const value = (t as HTMLInputElement | HTMLSelectElement).value;
      const other = q(t.id === "eqArrow" ? "#attArrow" : "#eqArrow");
      if (other instanceof HTMLSelectElement) setSelectValue(other, value);
      else if (other) (other as HTMLInputElement).value = value;
      syncArrowTag();
      updateAmmo();
      updateDrops();
      updateArrowWarn();
      buildTownGrids();
      return;
    }
    if (t.id === "tpItem" || t.id === "buyTpItem") {
      const value = (t as HTMLInputElement | HTMLSelectElement).value;
      buildTownGrids();
      // 瞬移选的是技能时不回填补给道具：回城补给只买真实道具
      if (t.id === "tpItem" && isTeleportSkill(value)) return;
      const other = q(t.id === "tpItem" ? "#buyTpItem" : "#tpItem");
      if (other instanceof HTMLSelectElement) setSelectValue(other, value);
      else if (other) (other as HTMLInputElement).value = value;
      return;
    }
    if (t.hasAttribute("data-atklvl")) {
      const found = parseOpenAtk();
      if (found) {
        found.sk.lvl = Number((t as HTMLSelectElement).value);
        renderMobs();
      }
      return;
    }
    if (t.hasAttribute("data-secv")) {
      const s = openSkill ? poolSkillOf(openSkill) : undefined;
      const ci = Number(t.getAttribute("data-secv"));
      const c = s?.conds[ci];
      if (s && c) {
        c.v = (t as HTMLInputElement).value;
        syncPoolRule(s.n);
      }
      return;
    }
    if (t.hasAttribute("data-ecv")) {
      const found = parseOpenAtk();
      const ci = Number(t.getAttribute("data-ecv"));
      const c = found?.sk.conds[ci];
      if (c) c.v = (t as HTMLInputElement).value;
      return;
    }
    if (t.hasAttribute("data-acv")) {
      const [aid, sk] = (openId ?? "").split(":");
      const a = findAux(aid ?? "");
      const ci = Number(t.getAttribute("data-acv"));
      const c = a && (sk === "self" || sk === "other") ? a.scopes[sk].conds[ci] : undefined;
      if (c) c.v = (t as HTMLInputElement).value;
      return;
    }
    const dropLbl = t.closest(".wz-drop");
    if (dropLbl && t instanceof HTMLInputElement && t.type === "checkbox") {
      dropLbl.setAttribute("data-on", t.checked ? "1" : "0");
      const pid = dropLbl.parentElement?.id;
      if (pid === "dropGrid") updateDrops();
      // 只记录用户点击的勾选，作为跨换图/重建的用户意图；程序重建产生的状态不记录
      if (pid === "sellGrid" || pid === "storeGrid") {
        const name = dropLbl.getAttribute("data-item") ?? "";
        if (name) {
          const rec = townUserPick.get(name) ?? {};
          const key = pid === "sellGrid" ? "sell" : "store";
          rec[key] = t.checked;
          townUserPick.set(name, rec);
          // 卖店/存仓互斥：勾选一边时，取消同名道具另一边的勾选并同步用户意图
          if (t.checked) {
            const otherGrid = pid === "sellGrid" ? "#storeGrid" : "#sellGrid";
            const otherKey = pid === "sellGrid" ? "store" : "sell";
            for (const s of qa(`${otherGrid} .wz-drop`)) {
              if (s.getAttribute("data-item") !== name) continue;
              const cb = s.querySelector("input");
              if (cb?.checked) {
                cb.checked = false;
                s.setAttribute("data-on", "0");
                rec[otherKey] = false;
              }
              break;
            }
          }
        }
      }
    }
  });

  wiz.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === "weightIn") {
      updateDrops();
      return;
    }
    if (t.id === "ammoMin" || t.id === "ammoKeep") {
      updateAmmo();
      return;
    }
    if (t.hasAttribute("data-names")) {
      const a = findAux(t.getAttribute("data-names") ?? "");
      if (a) {
        a.scopes.other.names = (t as HTMLInputElement).value;
        const span = t.closest(".wz-scopeg-h")?.querySelector("[data-bcount]");
        if (span) span.textContent = `${blockCountOf("other", a.scopes.other)} 条`;
      }
    }
  });

  const clearSortMarks = (): void => {
    for (const el of qa(".wz-bind.drop-before,.wz-bind.drop-after,.wz-mob-b.drop-end")) {
      el.classList.remove("drop-before", "drop-after", "drop-end");
    }
  };

  wiz.addEventListener("dragstart", (e) => {
    const el = (e.target as Element | null)?.closest?.("[data-sortmob]");
    if (!el) return;
    sortDrag = {
      mobId: el.getAttribute("data-sortmob") ?? "",
      name: el.getAttribute("data-sortname") ?? "",
    };
    el.classList.add("is-dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", sortDrag.name);
    }
  });

  wiz.addEventListener("dragover", (e) => {
    if (!sortDrag) return;
    const el = (e.target as Element | null)?.closest?.(".wz-bind, .wz-mob-b");
    if (!el) {
      clearSortMarks();
      return;
    }
    const mobEl = el.closest("[data-mob]");
    if (!mobEl || mobEl.getAttribute("data-mob") !== sortDrag.mobId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearSortMarks();
    if (el.classList.contains("wz-bind")) {
      const r = el.getBoundingClientRect();
      el.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
    } else {
      el.classList.add("drop-end");
    }
  });

  wiz.addEventListener("drop", (e) => {
    if (!sortDrag) return;
    const el = (e.target as Element | null)?.closest?.(".wz-bind, .wz-mob-b");
    if (!el) return;
    const mobEl = el.closest("[data-mob]");
    if (!mobEl || mobEl.getAttribute("data-mob") !== sortDrag.mobId) return;
    e.preventDefault();
    const m = MOBS.find((x) => x.id === sortDrag?.mobId);
    const from = m ? m.skills.findIndex((s) => s.n === sortDrag?.name) : -1;
    if (!m || from < 0) {
      sortDrag = null;
      clearSortMarks();
      return;
    }
    let to = m.skills.length;
    if (el.classList.contains("wz-bind")) {
      const idx = m.skills.findIndex((s) => s.n === el.getAttribute("data-sortname"));
      if (idx >= 0) {
        const r = el.getBoundingClientRect();
        to = e.clientX < r.left + r.width / 2 ? idx : idx + 1;
      }
    }
    const moved = m.skills.splice(from, 1)[0];
    if (!moved) {
      sortDrag = null;
      clearSortMarks();
      return;
    }
    if (to > from) to -= 1;
    m.skills.splice(to, 0, moved);
    lastSortAt = Date.now();
    sortDrag = null;
    clearSortMarks();
    renderMobs();
  });

  wiz.addEventListener("dragend", () => {
    sortDrag = null;
    for (const el of qa(".wz-bind.is-dragging")) el.classList.remove("is-dragging");
    clearSortMarks();
  });

  function syncFollow(): void {
    const on = flagOn("follow");
    for (const el of qa("[data-follow-target],[data-follow-opt]")) el.style.display = on ? "" : "none";
  }

  /* ========== 保存弹窗 ========== */

  const saveModal = q<HTMLElement>("#saveModal");
  let saveReturnFocus: HTMLElement | null = null;

  const saveModalFocusables = (): HTMLElement[] =>
    saveModal
      ? Array.from(
          saveModal.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null)
      : [];

  function openSaveModal(): void {
    if (!saveModal || !saveModal.hidden) return;
    saveReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    saveModal.hidden = false;
    // 优先聚焦方案名输入框；校验未通过时没有输入框，则聚焦弹窗内第一个可聚焦元素。
    const nameInput = q<HTMLElement>("#saveNameIn");
    (nameInput ?? saveModalFocusables()[0])?.focus();
  }

  function closeSaveModal(): void {
    if (!saveModal) return;
    saveModal.hidden = true;
    saveReturnFocus?.focus();
    saveReturnFocus = null;
  }

  // 焦点圈在弹窗内：Tab/Shift+Tab 在首尾可聚焦元素间循环，避免键盘用户穿出到背景页面。
  saveModal?.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || saveModal.hidden) return;
    const list = saveModalFocusables();
    if (list.length === 0) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !saveModal.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !saveModal.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  });

  saveModal?.addEventListener("click", (e) => {
    if (e.target === saveModal) closeSaveModal();
  });

  /* ========== 校验 ========== */

  const gridChecked = (sel: string): string[] =>
    qa(`${sel} .wz-drop`)
      .filter((d) => d.querySelector("input")?.checked)
      .map((d) => d.getAttribute("data-item") ?? "")
      .filter((x) => x !== "");

  interface Issues {
    errs: string[];
    warns: string[];
  }

  function collectIssues(): Issues {
    const errs: string[] = [];
    const warns: string[] = [];
    const numVal = (sel: string): number => Number.parseInt(inputVal(sel), 10);
    const attackOff = (q<HTMLSelectElement>("#attackAuto")?.value ?? "2") === "0";
    const followOn = flagOn("follow");

    if (!inputVal("#lockMapIn")) {
      if (followOn) warns.push("挂机地图（lockMap）未填：跟随模式下它作为跟丢后的回收点，建议填上。");
      else errs.push("还没选挂机地图：lockMap 为空时 KE 不会进图挂机。");
    }
    if (RANGED && !attackOff && !inputVal("#eqArrow"))
      errs.push("箭矢为空：弓类普攻与箭技都无法射出，需在第 2 步装备区或第 4 步箭矢补给填上。");
    if (followOn && !inputVal("#followTarget"))
      errs.push("跟随打怪开着但没填跟随谁：写错名字角色会原地不动，需在第 2 步跟随区填上玩家名字。");
    if (attackOff && !followOn) warns.push("打怪方式为「不打怪」且未开跟随：角色只做辅助，不会攻击。");
    if (!flagOn("weapon") && !ATTACK_SKILLS.length && !followOn)
      warns.push("武器普攻关闭且本职业无攻击技能、未开跟随：角色不会打怪，纯辅助号建议开跟随。");
    if (
      flagOn("automount") &&
      !JOB_DATA.mountSkill &&
      JOB_DATA.mount !== "combat" &&
      !inputVal("#mountItem")
    )
      warns.push("自动坐骑开着但未选坐骑道具：道具流未选道具时坐骑功能自动关闭。");
    if (flagOn("tp") && !inputVal("#tpItem")) warns.push("瞬移开着但瞬移道具或技能为空：序列化后濒死也不会飞。");
    if (flagOn("potHp") && !inputVal("#potHpItem")) warns.push("HP 药水开着但道具名为空：不会喝药。");
    if (flagOn("potSp") && !inputVal("#potSpItem")) warns.push("SP 药水开着但道具名为空：不会喝蓝。");
    if (flagOn("tp") && flagOn("potHp")) {
      const tpH = numVal("#tpHp");
      const potH = numVal("#potHpPct");
      if (!isNaN(tpH) && !isNaN(potH) && potH <= tpH)
        warns.push(`喝药线（HP<${potH}%）不高于瞬移线（HP<${tpH}%）：会先飞不喝药，药水形同虚设，建议喝药线高于瞬移线。`);
    }
    if (flagOn("sit")) {
      const sLo = numVal("#sitHpLo");
      const sHi = numVal("#sitHpHi");
      if (!isNaN(sLo) && !isNaN(sHi) && sLo >= sHi)
        errs.push("坐下回复阈值反了：起身阈值必须高于坐下阈值。");
      const pLo = numVal("#sitSpLo");
      const pHi = numVal("#sitSpHi");
      if (!isNaN(pLo) && !isNaN(pHi) && pLo >= pHi)
        errs.push("SP 坐下回复阈值反了：起身阈值必须高于坐下阈值。");
    }
    if (flagOn("town")) {
      if (!inputVal("#saveMapIn")) errs.push("回城补给开着但回城地图（saveMap）为空：回城没有落点。");
      for (const id of ["#sellNpcIn", "#storageNpcIn", "#potNpcIn", "#supplyNpcIn"])
        if (!inputVal(id)) errs.push("回城补给开着但卖店/仓库/药水/补给道具 NPC 坐标为空：回城后找不到 NPC。");
      const saveTown = inputVal("#saveMapIn").trim().split(/\s+/)[0] ?? "";
      for (const [id, label] of [["#sellNpcIn", "卖店"], ["#storageNpcIn", "仓库"]] as const) {
        const npcTown = (inputVal(id).trim().split(/\s+/)[0] ?? "");
        if (saveTown && npcTown && npcTown !== saveTown)
          warns.push(`回城点是 ${saveTown}，但${label} NPC 写的是 ${npcTown}：回城后会跨图找 NPC，建议改成回城点所在城市的坐标。`);
      }
      const tw = numVal("#townWeight");
      const wl = numVal("#weightIn");
      if (!isNaN(tw) && !isNaN(wl) && tw >= wl)
        warns.push(`回城负重（${tw}%）≥ 停捡负重（${wl}%）：会先停捡再回城，中间掉落全丢，建议回城负重低于停捡负重。`);
      if (flagOn("sell") && gridChecked("#sellGrid").length === 0)
        warns.push("卖垃圾开着但没勾选任何要卖的道具：回城后什么也不卖。");
      if (flagOn("storage") && gridChecked("#storeGrid").length === 0)
        warns.push("存仓开着但没勾选任何要存的道具：回城后什么也不存。");
      if (flagOn("buyHp") && !inputVal("#buyHpItem"))
        warns.push("回城买 HP 药开着但道具名为空：回城后买不到药。");
      if (flagOn("buySp") && !inputVal("#buySpItem"))
        warns.push("回城买 SP 药开着但道具名为空：回城后买不到药。");
      const hMin = numVal("#buyHpMin");
      const hMax = numVal("#buyHpNum");
      if (flagOn("buyHp") && !isNaN(hMin) && !isNaN(hMax) && hMin >= hMax)
        errs.push("HP 药补给阈值反了：「低于 N 瓶回城」必须小于「买满到 M 瓶」。");
      const sMin = numVal("#buySpMin");
      const sMax = numVal("#buySpNum");
      if (flagOn("buySp") && !isNaN(sMin) && !isNaN(sMax) && sMin >= sMax)
        errs.push("SP 药补给阈值反了：「低于 N 瓶回城」必须小于「买满到 M 瓶」。");
      if (flagOn("buyTp")) {
        if (!inputVal("#buyTpItem"))
          warns.push("瞬移道具补给开着但道具名为空：翅膀耗尽后濒死也不会飞。");
        const tMin = numVal("#buyTpMin");
        const tMax = numVal("#buyTpNum");
        if (!isNaN(tMin) && !isNaN(tMax) && tMin >= tMax)
          errs.push("瞬移道具补给阈值反了：「低于 N 个回城」必须小于「买满到 M 个」。");
      }
      if (RANGED && flagOn("ammo")) {
        if (!inputVal("#attArrow")) warns.push("箭矢补给开着但道具名为空：回城后取不到箭。");
        const aMin = numVal("#ammoMin");
        const aMax = numVal("#ammoKeep");
        if (!isNaN(aMin) && !isNaN(aMax) && aMin >= aMax)
          errs.push("箭矢补给阈值反了：「低于 N 支回城」必须小于「取到 M 支」。");
      }
    }
    // 拾取了但既没勾卖也没勾存的道具：只进不出，慢性塞满负重（自用品：药/箭矢/瞬移道具除外）
    const selfUse = [inputVal("#buyHpItem"), inputVal("#buySpItem"), inputVal("#attArrow"), inputVal("#tpItem")];
    const sellSet = gridChecked("#sellGrid");
    const storeSet = gridChecked("#storeGrid");
    const orphan = gridChecked("#dropGrid").filter(
      (it) => !sellSet.includes(it) && !storeSet.includes(it) && !selfUse.includes(it),
    );
    if (orphan.length)
      warns.push(`拾取了但既没勾卖也没勾存：${orphan.join("、")}——只进不出会塞满负重，请归置到卖店或存仓清单。`);
    if (flagOn("spfloor")) {
      const spfV = numVal("#spFloor");
      if (isNaN(spfV) || spfV <= 0 || spfV >= 100)
        warns.push("技能用蓝保底开着但百分比无效（需 1-99）。");
    }
    if (hasMapData) {
      const alive = MOBS.filter((m) => !m.deleted);
      if (!alive.length) errs.push("本图怪物全被拿掉了，没有可打的目标。");
      const bound = alive.filter((m) => m.skills.length > 0).length;
      if (!bound && alive.length)
        warns.push(`没有任何怪绑定精确技能，${alive.length} 只怪都会走兜底。`);
      else if (alive.length && bound < alive.length)
        warns.push(`${alive.length - bound} 只怪没有精确技能，将走兜底「${FALLBACK[0]?.n ?? ""}」。`);
    }
    const w = numVal("#weightIn");
    if (isNaN(w) || w < 1 || w > 100)
      errs.push(`负重停捡阈值应在 1-100 之间，当前是「${inputVal("#weightIn")}」。`);
    let firstSurv = -1;
    let firstOther = -1;
    AUX.forEach((a, i) => {
      if (a.cat === "survival" && firstSurv < 0) firstSurv = i;
      if (a.cat !== "survival" && firstOther < 0) firstOther = i;
    });
    if (firstSurv >= 0 && firstOther >= 0 && firstSurv > firstOther)
      warns.push("保命技能排在增益/治疗之后：血线触发前可能先被回蓝占掉一个循环，建议把保命拖到最前。");
    return { errs, warns };
  }

  /* ========== 保存 ========== */

  function buildConfigDoc(): ConfigDoc {
    const doc = defaultDoc();
    const s = doc.scalars;
    const attackOff = (q<HTMLSelectElement>("#attackAuto")?.value ?? "2") === "0";

    const lockMap = inputVal("#lockMapIn");
    const saveMap = inputVal("#saveMapIn");
    if (lockMap) s["lockMap"] = lockMap;
    if (saveMap) s["saveMap"] = saveMap;

    s["attackAuto"] = q<HTMLSelectElement>("#attackAuto")?.value ?? "2";
    s["attackUseWeapon"] = flagOn("weapon") ? "1" : "0";
    if (RANGED) {
      s["attackCanSnipe"] = flagOn("kite") || flagOn("snipe") ? "1" : "0";
      s["attackDistance"] = inputVal("#atkDist") || "9";
      const arrow = inputVal("#eqArrow") || inputVal("#attArrow");
      if (arrow) s["attackEquip_arrow"] = arrow;
    }

    const tpPickName = inputVal("#tpItem");
    if (flagOn("tp")) {
      s["teleportAuto_hp"] = inputVal("#tpHp") || "30";
      s["teleportAuto_minAggressives"] = inputVal("#tpAggr") || "3";
      s["teleportAuto_maxDmg"] = inputVal("#tpDmg") || "0";
      // 选技能走 teleportAuto_useSkill；选道具则显式关闭技能瞬移并把道具名写进 item1
      if (isTeleportSkill(tpPickName)) {
        s["teleportAuto_useSkill"] = "1";
      } else if (tpPickName) {
        s["teleportAuto_useSkill"] = "0";
        s["teleportAuto_item1"] = tpPickName;
      }
    } else {
      s["teleportAuto_hp"] = "0";
      s["teleportAuto_minAggressives"] = "0";
      s["teleportAuto_maxDmg"] = "0";
    }

    if (flagOn("sit")) {
      s["sitAuto_hp_lower"] = inputVal("#sitHpLo") || "50";
      s["sitAuto_hp_upper"] = inputVal("#sitHpHi") || "90";
      s["sitAuto_sp_lower"] = inputVal("#sitSpLo") || "30";
      s["sitAuto_sp_upper"] = inputVal("#sitSpHi") || "90";
    } else {
      s["sitAuto_hp_lower"] = "0";
      s["sitAuto_hp_upper"] = "0";
      s["sitAuto_sp_lower"] = "0";
      s["sitAuto_sp_upper"] = "0";
    }

    if (flagOn("follow")) {
      s["follow"] = "1";
      const target = inputVal("#followTarget");
      if (target) s["followTarget"] = target;
      s["followDistanceMax"] = inputVal("#followDist") || "6";
    } else {
      s["follow"] = "0";
    }

    s["itemsTakeAuto"] = flagOn("pickup") ? "2" : "0";
    s["itemsGatherAuto"] = flagOn("own") ? "0" : "2";
    s["itemsTakeAuto_party"] = flagOn("own") ? "0" : "1";
    s["itemsMaxWeight"] = inputVal("#weightIn") || "90";

    if (flagOn("town")) {
      s["itemsMaxWeight_sellOrStore"] = inputVal("#townWeight") || "50";
      s["sellAuto"] = flagOn("sell") ? "1" : "0";
      s["storageAuto"] = flagOn("storage") ? "1" : "0";
      s["sellAuto_npc"] = inputVal("#sellNpcIn") || "prontera 105 87";
      s["storageAuto_npc"] = inputVal("#storageNpcIn") || "prontera 146 89";
    } else {
      s["sellAuto"] = "0";
      s["storageAuto"] = "0";
    }

    const spFloorOn = flagOn("spfloor");
    const spFloor = inputVal("#spFloor");
    const blocks: Record<string, BlockValue[]> = {};

    if (!attackOff) {
      const atk: BlockValue[] = [];
      for (const m of MOBS) {
        if (m.deleted) continue;
        for (const sk of m.skills) {
          const conditions: Record<string, string> = {};
          let hasSp = false;
          for (const c of sk.conds) {
            const key = c.k === "dist" ? "target_dist" : c.k;
            if (key === "sp") hasSp = true;
            conditions[key] = c.v;
          }
          if (spFloorOn && spFloor && !hasSp) conditions["sp"] = `> ${spFloor}%`;
          atk.push({
            selector: skillSelector(sk.n),
            fields: {
              lvl: String(sk.lvl),
              monsters: m.name,
              ...(sk.maxUses ? { maxUses: String(sk.maxUses) } : {}),
            },
            conditions,
          });
        }
      }
      for (const f of FALLBACK) {
        if (f.n === "普通攻击") continue;
        const conditions: Record<string, string> = {};
        if (spFloorOn && spFloor) conditions["sp"] = `> ${spFloor}%`;
        atk.push({ selector: skillSelector(f.n), fields: { lvl: String(f.lv) }, conditions });
      }
      if (atk.length) blocks["attackSkillSlot"] = atk;
    }

    // 瞬移已改由 teleportAuto_useSkill 驱动时，跳过辅助技能里同名的规则，避免重复瞬移
    const tpBySkill = flagOn("tp") && isTeleportSkill(tpPickName);
    const selfBlocks: BlockValue[] = [];
    if (flagOn("automount") && JOB_DATA.mount === "combat" && JOB_DATA.mountSkill) {
      selfBlocks.push({ selector: skillSelector("骑乘术"), fields: { lvl: "1" }, conditions: { whenNotMounted: "1", timeout: "5" } });
    }
    for (const a of AUX) {
      if (tpBySkill && a.name === tpPickName) continue;
      const g = a.scopes.self;
      if (!g.on) continue;
      const conditions: Record<string, string> = {};
      for (const c of g.conds) conditions[c.k] = c.v;
      selfBlocks.push({ selector: skillSelector(a.name), fields: { lvl: String(a.lv) }, conditions });
    }
    if (selfBlocks.length) blocks["useSelf_skill"] = selfBlocks;

    const partyBlocks: BlockValue[] = [];
    for (const a of AUX) {
      if (tpBySkill && a.name === tpPickName) continue;
      const g = a.scopes.other;
      if (!g.on) continue;
      const conditions: Record<string, string> = {};
      for (const c of g.conds) conditions[c.k] = c.v;
      const names = namesOf(g);
      if (names.length) {
        for (const n of names)
          partyBlocks.push({ selector: skillSelector(a.name), fields: { lvl: String(a.lv), target: n }, conditions });
      } else {
        partyBlocks.push({ selector: skillSelector(a.name), fields: { lvl: String(a.lv) }, conditions });
      }
    }
    if (partyBlocks.length) blocks["partySkill"] = partyBlocks;

    const itemBlocks: BlockValue[] = [];
    if (flagOn("potHp") && inputVal("#potHpItem"))
      itemBlocks.push({ selector: inputVal("#potHpItem"), fields: {}, conditions: { hp: `< ${inputVal("#potHpPct") || "40"}%` } });
    if (flagOn("potSp") && inputVal("#potSpItem"))
      itemBlocks.push({ selector: inputVal("#potSpItem"), fields: {}, conditions: { sp: `< ${inputVal("#potSpPct") || "30"}%` } });
    if (flagOn("automount") && !JOB_DATA.mountSkill && inputVal("#mountItem")) {
      itemBlocks.push({ selector: inputVal("#mountItem"), fields: {}, conditions: { whenNotMounted: "1", timeout: "5" } });
    }
    if (itemBlocks.length) blocks["useSelf_item"] = itemBlocks;

    if (flagOn("town")) {
      const buy: BlockValue[] = [];
      const potNpc = inputVal("#potNpcIn") || "prt_in 126 76";
      const supplyNpc = inputVal("#supplyNpcIn") || "prt_in 126 76";
      const addBuy = (on: boolean, item: string, minV: string, maxV: string, npc: string): void => {
        if (!on || !item) return;
        buy.push({
          selector: item,
          fields: { npc, npc_steps: "b", distance: "3", minAmount: minV || "0", maxAmount: maxV || "10" },
          conditions: { zeny: "> 25000" },
        });
      };
      addBuy(flagOn("buyHp"), inputVal("#buyHpItem"), inputVal("#buyHpMin"), inputVal("#buyHpNum"), potNpc);
      addBuy(flagOn("buySp"), inputVal("#buySpItem"), inputVal("#buySpMin"), inputVal("#buySpNum"), potNpc);
      addBuy(flagOn("buyTp"), inputVal("#buyTpItem"), inputVal("#buyTpMin"), inputVal("#buyTpNum"), supplyNpc);
      const arrow = inputVal("#attArrow");
      if (RANGED && flagOn("ammo") && arrow) {
        addBuy(true, arrow, inputVal("#ammoMin"), inputVal("#ammoKeep"), supplyNpc);
        blocks["getAuto"] = [
          { selector: arrow, fields: { minAmount: inputVal("#ammoMin") || "50", maxAmount: inputVal("#ammoKeep") || "500" }, conditions: {} },
        ];
      }
      if (buy.length) blocks["buyAuto"] = buy;
    }

    // 状态条件统一写成 EFST_ 句柄（与完整配置页一致）：界面仍显示中文状态名，
    // 落库的 config.txt 不依赖 KE 是否识别中文状态名。
    const STATUS_KEYS = new Set(["whenStatusActive", "whenStatusInactive", "target_whenStatusActive", "target_whenStatusInactive"]);
    for (const list of Object.values(blocks)) {
      for (const b of list) {
        for (const k of Object.keys(b.conditions)) {
          if (!STATUS_KEYS.has(k)) continue;
          b.conditions[k] = b.conditions[k]!
            .split(/[,，;]/u)
            .map((s) => s.trim())
            .filter((s) => s !== "")
            .map((s) => statusHandleOf(s))
            .join(", ");
        }
      }
    }

    doc.blocks = blocks;
    return doc;
  }

  function buildControlDoc(): ControlDoc {
    const doc = defaultControlDoc();

    const monSchema = CONTROL_SCHEMAS.find((x) => x.file === "mon_control.txt")!;
    const monRows: ControlRow[] = MOBS.map((m) => {
      const row = newControlRow(monSchema);
      row.name = m.name;
      // 默认「打坐也攻击」：坐下回复时被这些怪打，也会起身追打，不会坐着挨打
      row.values["attack_auto"] = m.deleted ? "0" : "2";
      return row;
    });
    doc["mon_control.txt"] = [...monRows, ...(doc["mon_control.txt"] ?? [])];

    const arrow = inputVal("#attArrow");
    const pickExisting = doc["pickupitems.txt"] ?? [];
    const pickAll = pickExisting.filter((r) => r.name === "all");
    const pickPreset = pickExisting.filter((r) => r.name !== "all");
    const dropRows: ControlRow[] = qa("#dropGrid .wz-drop")
      .map((d) => {
        const name = d.getAttribute("data-item") ?? "";
        const on = d.querySelector("input")?.checked ?? false;
        let flag = on ? "1" : "0";
        if (on && RANGED && flagOn("ammo") && arrow !== "" && name === arrow) flag = "2";
        return { name, values: { flag } };
      })
      .filter((r) => r.name !== "");
    doc["pickupitems.txt"] = [...pickPreset, ...dropRows, ...pickAll];

    const itemExisting = doc["items_control.txt"] ?? [];
    const itemAll = itemExisting.filter((r) => r.name === "all");
    const itemPreset = itemExisting.filter((r) => r.name !== "all");
    const merged = new Map<string, ControlRow>();
    const mergeRow = (name: string, patch: Record<string, string>): void => {
      if (!name) return;
      let row = merged.get(name);
      if (!row) {
        row = { name, values: { keep: "0", storage: "0", sell: "0", cart_add: "0", cart_get: "0" } };
        merged.set(name, row);
      }
      Object.assign(row.values, patch);
    };
    // 箭矢始终写 items_control（保留上限）；只有开启自动补给才额外置 storage=1 触发多余存仓
    if (RANGED && arrow)
      mergeRow(
        arrow,
        flagOn("ammo")
          ? { keep: inputVal("#ammoKeep") || "500", storage: "1" }
          : { keep: inputVal("#ammoKeep") || "500" },
      );
    // 回城补给用的自用品必须显式“保留”，否则会被下面的 all 兜底存仓/卖掉
    for (const id of ["#buyHpItem", "#buySpItem", "#buyTpItem", "#mountItem"])
      mergeRow(inputVal(id), { keep: "9999" });
    for (const n of gridChecked("#sellGrid")) mergeRow(n, { sell: "1" });
    for (const n of gridChecked("#storeGrid")) mergeRow(n, { storage: "1" });
    // 未列出的物品别再留在包里（默认只会越背越重，回城后卖/存不掉又回城）；
    // 有存仓就存仓，没存仓但开了卖店才卖掉，两者都关就保持不动。
    const allRule = flagOn("storage") ? { storage: "1" } : flagOn("sell") ? { sell: "1" } : {};
    const itemAllOut = itemAll.map((r) => ({ ...r, values: { ...r.values, ...allRule } }));
    const mergedNames = new Set(merged.keys());
    doc["items_control.txt"] = [
      ...itemPreset.filter((r) => !mergedNames.has(r.name)),
      ...merged.values(),
      ...itemAllOut,
    ];
    // 向导不编辑 timeouts.txt：写入全局默认值（KE 默认 + LastRO 覆盖），保证五份文件齐全。
    const timeoutKeys: { key: string; value: string }[] = ctx.options?.timeouts?.length
      ? ctx.options.timeouts
      : Object.keys(TIMEOUT_DEFAULT_OVERRIDES).map((key) => ({ key, value: TIMEOUT_DEFAULT_OVERRIDES[key] ?? "" }));
    doc["timeouts.txt"] = timeoutKeys.map((t) => ({
      name: t.key,
      values: { value: TIMEOUT_DEFAULT_OVERRIDES[t.key] ?? t.value },
    }));
    return doc;
  }

  function previewHtml(): string {
    const doc = buildConfigDoc();
    const controls = buildControlDoc();
    ensureAllFallback(controls);
    const b = doc.blocks;
    const arrow = inputVal("#attArrow") || "箭矢";
    const keep = inputVal("#ammoKeep") || "0";
    const ammoMinV = inputVal("#ammoMin") || "0";
    const ammoOn = flagOn("ammo");
    const itemsRows = (controls["items_control.txt"] ?? []).length;
    const summary: [string, string][] = [
      [
        "config.txt",
        `参数 ${Object.keys(doc.scalars).length} 项 · attackSkillSlot ${b["attackSkillSlot"]?.length ?? 0} · useSelf_skill ${b["useSelf_skill"]?.length ?? 0} · partySkill ${b["partySkill"]?.length ?? 0} · useSelf_item ${b["useSelf_item"]?.length ?? 0} · buyAuto ${b["buyAuto"]?.length ?? 0}${b["getAuto"] ? ` · getAuto ${b["getAuto"]!.length}` : ""}`,
      ],
      ["mon_control.txt", `${(controls["mon_control.txt"] ?? []).length} 行（含兜底）`],
      ["pickupitems.txt", `${(controls["pickupitems.txt"] ?? []).length} 行`],
      [
        "items_control.txt",
        RANGED
          ? `${itemsRows} 行 · ${ammoOn ? `${arrow} 保留 ${keep} 支，多余存仓；低于 ${ammoMinV} 支回城取/买` : `仅写 ${arrow} 保留 ${keep} 支（关闭自动补给）`}`
          : `${itemsRows} 行（本职业无箭矢消耗）`,
      ],
      ["timeouts.txt", `${(controls["timeouts.txt"] ?? []).length} 项（沿用全局默认）`],
    ];
    const sumHtml = `<div class="wz-placeholder" style="margin-top:8px">${summary
      .map(([f, t]) => `<div class="wz-ph-row"><b>${f}</b><span>${esc(t)}</span></div>`)
      .join("")}</div>`;
    const mobLines = MOBS.filter((m) => !m.deleted)
      .map(
        (m) =>
          `<div class="wz-save-l"><code>${m.pri ? "★ " : ""}${esc(m.name)}</code><span>${esc(
            m.skills.map((x) => `${x.n} Lv.${x.lvl}`).join(" → ") || "（走兜底）",
          )}</span></div>`,
      )
      .join("");
    const auxLines = AUX.flatMap((a) =>
      SCOPE_ORDER.filter((sk) => a.scopes[sk].on).map((sk) => {
        const g = a.scopes[sk];
        const conds = g.conds.map((c) => `${condLabel(c.k)} ${c.v}`).join("；") || "无条件";
        const tgt = sk === "other" ? namesOf(g).join("、") || "任意队友" : "自己";
        return `<div class="wz-save-l"><code>${esc(a.name)}</code><span>${esc(`${SCOPE_BLOCK[sk]} · ${tgt} · ${conds}`)}</span></div>`;
      }),
    ).join("");
    return (
      sumHtml +
      (mobLines ? `<div style="margin-top:10px">${mobLines}</div>` : "") +
      (auxLines ? `<div style="margin-top:6px">${auxLines}</div>` : "")
    );
  }

  function openSave(): void {
    const body = q("#saveBody");
    const confirmBtn = q<HTMLButtonElement>("#saveConfirm");
    const modal = q("#saveModal");
    if (!body || !confirmBtn || !modal) return;
    const { errs, warns } = collectIssues();
    if (errs.length) {
      body.innerHTML = errs.map((x) => `<div class="wz-issue err">✕ ${esc(x)}</div>`).join("");
      confirmBtn.style.display = "none";
    } else {
      const nameDef = `${JOB_DATA.name}挂机 · ${inputVal("#lockMapIn") || "未命名地图"}`;
      body.innerHTML =
        `<label class="wz-save-name">方案名称<input class="wz-in" id="saveNameIn" value="${esc(nameDef)}"></label>` +
        warns.map((w) => `<div class="wz-issue warn">⚠ ${esc(w)}</div>`).join("") +
        '<div class="wz-issue ok">✓ 校验通过，保存后写入以下 5 个配置文件</div>' +
        previewHtml();
      confirmBtn.style.display = "";
      confirmBtn.disabled = false;
      confirmBtn.textContent = "确认保存";
    }
    openSaveModal();
  }

  function renderSaveSuccess(name: string, simulated: boolean): void {
    const body = q("#saveBody");
    const confirmBtn = q<HTMLButtonElement>("#saveConfirm");
    if (!body || !confirmBtn) return;
    const c = ctx.character;
    body.innerHTML =
      `<div class="wz-issue ok">✓ 方案「${esc(name)}」${simulated ? "已生成（演示模式，未写入云端）" : "已保存并激活，进阶客户端下次同步即可生效"}</div>` +
      `<div style="margin-top:10px"><a class="kw-btn-primary" href="/ke/my?aid=${c.aid}&cid=${c.cid}&nid=${c.nid}">前往工作台查看 →</a></div>`;
    confirmBtn.style.display = "none";
    body.querySelector<HTMLElement>("a")?.focus();
  }

  function doSave(): void {
    const body = q("#saveBody");
    const confirmBtn = q<HTMLButtonElement>("#saveConfirm");
    if (!body || !confirmBtn) return;
    const { errs } = collectIssues();
    if (errs.length) {
      openSave();
      return;
    }
    const name = inputVal("#saveNameIn") || `${JOB_DATA.name}挂机 · ${inputVal("#lockMapIn")}`;
    const doc = buildConfigDoc();
    const controls = buildControlDoc();
    ensureAllFallback(controls);
    const allErrs = [...validateConfigDoc(doc), ...validateControlDoc(controls)];
    if (allErrs.length) {
      body.innerHTML = allErrs.map((x) => `<div class="wz-issue err">✕ ${esc(x)}</div>`).join("");
      confirmBtn.style.display = "none";
      return;
    }
    if (ctx.demo) {
      renderSaveSuccess(name, true);
      return;
    }
    const serializeByFile = (file: string): string => {
      const schema = CONTROL_SCHEMAS.find((x) => x.file === file)!;
      return serializeControl(schema, controls[file] ?? []).trim();
    };
    confirmBtn.disabled = true;
    confirmBtn.textContent = "保存中…";
    void keFetch<{ id: number }>("/api/v1/ke/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aid: ctx.character.aid,
        cid: ctx.character.cid,
        nid: ctx.character.nid,
        name,
        config_text: serializeConfig(doc),
        mon_control: serializeByFile("mon_control.txt"),
        pickupitems: serializeByFile("pickupitems.txt"),
        items_control: serializeByFile("items_control.txt"),
        // timeouts.txt 向导不改，提交全局默认值，保证客户端五份文件齐全
        timeouts: serializeByFile("timeouts.txt"),
      }),
    })
      // 服务端新建方案一律 is_active=0，需再调 activate 才完成「保存并激活」
      .then(({ id }) =>
        keFetch<void>(`/api/v1/ke/profiles/${id}/activate`, { method: "POST" }),
      )
      .then(() => {
        renderSaveSuccess(name, false);
      })
      .catch((err: unknown) => {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "确认保存";
        const msg = err instanceof Error ? err.message : String(err);
        const tip = msg.startsWith("AUTH:") ? "登录状态已失效，请重新登录后再保存。" : msg;
        body.insertAdjacentHTML("afterbegin", `<div class="wz-issue err">✕ 保存失败：${esc(tip)}</div>`);
      });
  }

  q("#backBtn")?.addEventListener("click", () => {
    if (current > 0) goto(current - 1);
  });
  q("#saveBtn")?.addEventListener("click", () => {
    if (current < 3) goto(current + 1);
    else openSave();
  });
  q("#saveConfirm")?.addEventListener("click", doSave);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && saveModal && !saveModal.hidden) closeSaveModal();
  });

  /* ========== 初始化 ========== */

  // flag 的 data-on 与复选框初始状态同步
  for (const f of qa("[data-flag]")) {
    const cb = f.querySelector("input");
    if (cb) f.setAttribute("data-on", cb.checked ? "1" : "0");
  }
  syncFollow();

  const built = ctx.options ? buildJobsFromOptions(ctx.options, ctx.skillKinds) : null;
  if (built) {
    JOBS = built.jobs;
    JOB_LIST = built.list;
    usingOptions = true;
    const ds = q("#dataSrc");
    if (ds) ds.textContent = `options.json 实时数据（${JOB_LIST.length} 职业）`;
  } else {
    const ds = q("#dataSrc");
    if (ds) ds.textContent = "内置演示数据（4 职业）";
  }

  // 职业完全跟随角色卡（KE 上报的 job_id），不再提供手动下拉；
  // 卡片职业若不在技能表里（如未收录职业），仍按卡片职业名展示，技能池为空。
  const charJob = ctx.character.job_id !== null ? String(ctx.character.job_id) : "";
  if (charJob) {
    if (!JOBS[charJob]) {
      const jnEn = ctx.options?.jobs?.[charJob] ?? "";
      const jnZh = ctx.options?.jobs_zh?.[charJob] ?? jnEn;
      JOBS[charJob] = {
        name: jnZh || jnEn || `职业 ${charJob}`,
        ranged: false, surv: "melee", mount: false, mountSkill: false, atk: [], aux: [],
      };
    }
    JOB = charJob;
  } else {
    JOB = JOB_LIST[0]!;
  }

  const lockInput = q<HTMLInputElement>("#lockMapIn");
  if (lockInput) lockInput.value = ctx.character.map_name?.trim() || "prt_fild08";

  applyJob(JOB);
  const matchInfo = q("#wzMatchInfo");
  if (matchInfo)
    matchInfo.textContent = `${ctx.character.char_name} · ${JOB_DATA.name} · 已按职业与当前地图预填`;
  applyAttackAuto();
  rebuildMapData();
  renderSkills();
  updateDrops();
  updateAmmo();
  updateArrowWarn();
  goto(0);
}
