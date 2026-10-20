// KoreEngine 配置工作台：角色卡 + Profile 卡片网格 + 三栏编辑器（分区导航 / 表单 / 状态与预览）。
// 设计要点：枚举开关用分段按钮；字段带 ? 帮助提示（hover + 键盘可达）；技能规则按类型分节、卡片可折叠；
// 规则表行化、低频列收进「高级」；未保存更改在编辑头与右栏双处提示，切换前需确认。仅通过 /ke 访问，站内不挂入口。

import {
  BLOCK_DEFS,
  CONFIG_SCALARS,
  conditionGroupLabel,
  conditionKeysOf,
  defaultDoc,
  emptyDoc,
  parseConfig,
  serializeConfig,
  validateConfigDoc,
  type BlockDef,
  type BlockFieldDef,
  type BlockValue,
  type ConditionGroup,
  type ConfigDoc,
  type ScalarDef,
} from "./ke-schema";
import {
  CONTROL_SCHEMAS,
  TIMEOUT_DEFAULT_OVERRIDES,
  allFallbackRows,
  defaultControlDoc,
  emptyControlDoc,
  ensureAllFallback,
  parseControl,
  serializeControl,
  type ControlColumn,
  type ControlRow,
  type ControlSchema,
} from "./ke-controls";

interface KeCharacter {
  aid: number;
  cid: number;
  nid: number;
  char_name: string;
  job_id: number | null;
  map_name: string | null;
  last_seen_at: number;
}

interface ProfileSummary {
  id: number;
  name: string;
  is_active: boolean;
}

interface ProfileDetail extends ProfileSummary {
  config_text: string;
  mon_control: string | null;
  pickupitems: string | null;
  items_control: string | null;
  timeouts: string | null;
}

interface SkillOption {
  id: number;
  name?: string;
  nameZh?: string;
  handle?: string;
}
interface StatusOption {
  id: number;
  handle: string;
  name?: string;
  nameZh?: string;
}
interface NameOption {
  id: number;
  name: string;
}
interface TimeoutOption {
  key: string;
  value: string;
  desc: string;
  range: string;
}
interface MapOption {
  code: string;
}
interface KeOptions {
  jobs: Record<string, string>;
  jobs_zh?: Record<string, string>;
  skills: SkillOption[];
  statuses: StatusOption[];
  monsters: NameOption[];
  items: NameOption[];
  maps: MapOption[];
  timeouts: TimeoutOption[];
  job_skills?: Record<string, number[]>;
  job_skill_groups?: Record<string, Record<string, number[]>>;
  skill_groups?: Record<string, string>;
}

interface PickerOption {
  label: string;
  value: string;
  group?: string;
}

interface NavEntry {
  id: string;
  label: string;
  group: string;
  icon: string;
  title: string;
  sub: string;
  kind: "scalars" | "skills" | "controls";
  groups?: string[];
  file?: string;
  /** kind 为 skills 时，本 tab 渲染哪些 block 类型（默认全部）。 */
  blockTypes?: string[];
}

const KE_FETCH_CACHE = "no-store";

const ICONS: Record<string, string> = {
  route:
    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h7a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h8"/>',
  combat:
    '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  survival: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  pickup:
    '<path d="M6 13c2 4 5 6 6 6s4-2 6-6"/><path d="M12 19V9a3 3 0 1 1 3-3"/>',
  follow:
    '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.3c2.9.4 5 2.8 5 5.7"/>',
  supply:
    '<path d="M5 8h14l-1.2 12H6.2z"/><path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2"/>',
  skills: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  mon_control:
    '<circle cx="12" cy="13" r="6"/><path d="M9 12h.01M15 12h.01M9.5 16c.7.7 4.3.7 5 0M7 7L5 5M17 7l2-2"/>',
  pickupitems: '<path d="M4 8h16l-1 12H5z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  items_control:
    '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  timeouts: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 3"/>',
};

const NAV: NavEntry[] = [
  {
    id: "route",
    label: "基础",
    group: "行为配置",
    icon: "route",
    title: "基础 · 路线",
    sub: "决定角色在哪张图挂机、怎么赶路",
    kind: "scalars",
    groups: ["路线"],
  },
  {
    id: "combat",
    label: "战斗",
    group: "行为配置",
    icon: "combat",
    title: "战斗 · 攻击策略",
    sub: "决定打什么、打多远、装备怎么切",
    kind: "scalars",
    groups: ["攻击"],
  },
  {
    id: "survival",
    label: "生存",
    group: "行为配置",
    icon: "survival",
    title: "生存 · 传送与坐下",
    sub: "保命阈值和回血节奏",
    kind: "scalars",
    groups: ["传送", "坐下"],
  },
  {
    id: "pickup",
    label: "拾取",
    group: "行为配置",
    icon: "pickup",
    title: "拾取 · 掉落策略",
    sub: "捡什么、捡多远、何时停手",
    kind: "scalars",
    groups: ["拾取"],
  },
  {
    id: "follow",
    label: "跟随",
    group: "行为配置",
    icon: "follow",
    title: "跟随 · 组队跟随",
    sub: "让角色跟着某位玩家行动",
    kind: "scalars",
    groups: ["跟随"],
  },
  {
    id: "supply",
    label: "补给",
    group: "行为配置",
    icon: "supply",
    title: "补给 · 修理与商店",
    sub: "装备维护和补给品的买卖流程",
    kind: "scalars",
    groups: ["修理", "商店仓库"],
  },
  {
    id: "skills",
    label: "技能规则",
    group: "技能",
    icon: "skills",
    title: "技能规则",
    sub: "按类型分组：每种技能逻辑一张卡片，可折叠",
    kind: "skills",
    blockTypes: ["attackSkillSlot", "useSelf_skill", "partySkill"],
  },
  {
    id: "item_use",
    label: "物品使用",
    group: "物品装备",
    icon: "supply",
    title: "物品使用 · 自身使用物品",
    sub: "自动使用消耗品（如药水），满足条件时触发",
    kind: "skills",
    blockTypes: ["useSelf_item"],
  },
  {
    id: "buy_auto",
    label: "自动购买",
    group: "物品装备",
    icon: "supply",
    title: "自动购买",
    sub: "库存不足时自动从 NPC 买补给",
    kind: "skills",
    blockTypes: ["buyAuto"],
  },
  {
    id: "get_auto",
    label: "自动取物",
    group: "物品装备",
    icon: "items_control",
    title: "自动取物（仓库）",
    sub: "身上数量不足时自动从仓库取补给",
    kind: "skills",
    blockTypes: ["getAuto"],
  },
  {
    id: "equip_auto",
    label: "自动换装",
    group: "物品装备",
    icon: "items_control",
    title: "自动换装",
    sub: "按自身/怪物条件自动切换装备槽位",
    kind: "skills",
    blockTypes: ["equipAuto"],
  },
  {
    id: "mon_control",
    label: "怪物规则",
    group: "规则表",
    icon: "mon_control",
    title: "怪物规则",
    sub: "对特定怪物自定义攻击 / 逃跑行为；高级条件默认收起",
    kind: "controls",
    file: "mon_control.txt",
  },
  {
    id: "pickupitems",
    label: "拾取物品",
    group: "规则表",
    icon: "pickupitems",
    title: "拾取物品",
    sub: "逐个物品指定是否捡取",
    kind: "controls",
    file: "pickupitems.txt",
  },
  {
    id: "items_control",
    label: "物品规则",
    group: "规则表",
    icon: "items_control",
    title: "物品规则",
    sub: "身上保留多少、是否存仓 / 出售 / 放推车",
    kind: "controls",
    file: "items_control.txt",
  },
  {
    id: "timeouts",
    label: "超时",
    group: "规则表",
    icon: "timeouts",
    title: "超时",
    sub: "调整内部动作的等待与重试间隔，一般保持默认",
    kind: "controls",
    file: "timeouts.txt",
  },
];

const CONTROL_LABELS: Record<string, string> = {
  "mon_control.txt": "怪物规则",
  "pickupitems.txt": "拾取物品",
  "items_control.txt": "物品规则",
  "timeouts.txt": "超时",
};

/** 规则表分区顶部的白话说明（依据 OpenKore 官方文档语义）。 */
const CONTROL_TAB_HINTS: Record<string, string> = {
  "mon_control.txt":
    "单独配置的怪物优先于 all 兜底规则。「仅反击」＝平时不打、被打才还手；「打坐也攻击」＝把这种怪视作主动怪，坐下回血时也会起身追打；「遇怪传送」可选见到就飞、被打才飞，或按距离飞。",
  "pickupitems.txt":
    "「优先拾取」＝物品一出现就马上去捡；「拾取」＝路过时顺手捡；「不拾取」＝完全无视（写入 0，与 -1 等效）。",
  "items_control.txt":
    "工作方式：身上数量多于「身上保留」→ 多余的自动存仓 / 出售 / 放进推车；少于它 → 自动从推车补回。同时开启存仓和出售时先存仓（仓库满才卖）。",
};

// 下拉列表最多渲染的条目数（超过时底部提示用户直接输入文字过滤）。
const PICKER_LIMIT = 100;

export async function keFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: KE_FETCH_CACHE,
  });
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = body?.error?.code ?? "REQUEST_FAILED";
    const message = body?.error?.message ?? "请求失败";
    if (response.status === 401) throw new Error(`AUTH:${message}`);
    throw new Error(`${code}:${message}`);
  }
  return (await response.json()) as T;
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

export function mountKePage(root: HTMLElement): void {
  let characters: KeCharacter[] = [];
  let selectedKey: string | null = null;
  let editingId: number | null = null;
  let configDoc: ConfigDoc = emptyDoc();
  let options: KeOptions | null = null;
  let selectedJobId: number | null = null;
  let showAllSkills = false;
  let controlDoc = emptyControlDoc();
  let activeTab = "route";
  let dirty = false;
  let previewCollapsed = false;
  const expandedBlocks = new WeakSet<BlockValue>();

  root.innerHTML = `
  <header class="site-header">
    <div class="topbar page-width">
      <a class="brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      <span id="ke-demo-chip" class="ke-demo-chip" hidden><i></i>演示模式 · 改动不会保存</span>
    </div>
  </header>
  <main class="page-width">
    <section class="ke-hero" aria-labelledby="ke-title">
      <p class="eyebrow">KoreEngine · 自动挂机配置</p>
      <h1 class="ke-title" id="ke-title">挂机配置工作台</h1>
      <p class="ke-hero-sub">为每个角色保存多套挂机方案：路线、战斗、补给与规则表分开管理，激活其中一套即刻生效。</p>
      <p id="ke-status" class="ke-status" role="status" aria-live="polite">正在加载…</p>
      <p class="ke-hero-sub"><a href="/ke/device">管理已授权的 KoreEngine 设备 →</a></p>
    </section>

    <section class="ke-char-card" id="ke-char-card" aria-label="当前角色" hidden>
      <div class="ke-avatar" id="ke-char-avatar">?</div>
      <div class="ke-char-main">
        <div class="ke-char-name"><span id="ke-char-name">—</span><span class="ke-chip" id="ke-char-job" hidden></span></div>
        <div class="ke-char-meta" id="ke-char-meta"></div>
      </div>
      <div class="ke-char-switch">
        <span>切换角色</span>
        <select id="ke-char-select"><option value="">加载中…</option></select>
      </div>
    </section>

    <div class="section-heading" id="ke-profiles-head" hidden>
      <div>
        <p class="eyebrow">Profiles</p>
        <h2>配置方案</h2>
      </div>
      <p>「使用中」的方案由 KoreEngine 客户端拉取执行；编辑已激活的方案后，需要重新激活才会生效。</p>
    </div>
    <div id="ke-profile-list" class="ke-profile-grid" hidden></div>

    <section id="ke-editor" aria-label="方案编辑器" hidden>
      <div class="section-heading">
        <div>
          <p class="eyebrow">Editor</p>
          <h2 id="ke-editor-title">编辑方案</h2>
        </div>
        <p>左侧按用途切换分区；修改会即时生成右侧的 config.txt 预览，确认无误后保存。</p>
      </div>
      <div class="ke-editor">
        <div class="ke-editor-head">
          <div class="ke-field-name">
            <input id="ke-profile-name" maxlength="64" placeholder="方案名称，例如：斐扬打波利" aria-label="方案名称" />
          </div>
          <span class="ke-dirty" id="ke-dirty" hidden><i></i>有未保存的更改</span>
          <div class="ke-editor-actions">
            <button type="button" class="ke-btn-ghost ke-btn-quiet" data-action="cancel">取消</button>
            <button type="button" class="ke-btn-primary" data-action="save">保存方案</button>
          </div>
        </div>
        <p id="ke-form-error" class="ke-error" role="alert" hidden></p>
        <div class="ke-editor-body">
          <nav class="ke-nav" id="ke-nav" aria-label="配置分区"></nav>
          <div class="ke-main" id="ke-tab-panels"></div>
          <aside class="ke-side">
            <div class="ke-side-card">
              <span class="ke-side-label">方案状态</span>
              <div class="ke-side-rows" id="ke-side-stats"></div>
              <div class="ke-side-status" id="ke-dirty-side" hidden><span class="dot"></span>有未保存的更改 · 保存前不会生效</div>
            </div>
            <div class="ke-side-card">
              <button type="button" class="ke-preview-toggle" id="ke-preview-toggle"><span id="ke-preview-file">CONFIG.TXT</span> 预览 <span>收起 ▾</span></button>
              <pre id="ke-config-preview" class="ke-preview-pre" aria-live="polite"></pre>
            </div>
            <div class="ke-side-save">
              <button type="button" class="ke-btn-primary" data-action="save">保存方案</button>
              <button type="button" class="ke-btn-ghost" data-action="cancel">取消编辑</button>
            </div>
          </aside>
        </div>
        <div class="ke-editor-foot">
          <button type="button" class="ke-btn-primary" data-action="save">保存方案</button>
          <button type="button" class="ke-btn-ghost" data-action="cancel">取消</button>
        </div>
      </div>
    </section>
  </main>
  <datalist id="ke-maps-list"></datalist>
  <style>
    .ke-demo-chip { display: inline-flex; align-items: center; gap: 7px; padding: 5px 13px; color: #835f18; background: var(--tip-soft); border: 1px solid var(--tip-line); border-radius: 999px; font-size: .72rem; font-weight: 800; }
    .ke-demo-chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--gold); }

    .ke-hero { padding: 30px 0 4px; }
    .ke-hero .eyebrow { color: var(--red-dark); }
    .ke-title { margin: 8px 0 6px; color: var(--forest); font-family: Georgia, "Microsoft YaHei", serif; font-size: clamp(1.5rem, 2.6vw, 2rem); font-weight: 700; }
    .ke-hero-sub { max-width: 560px; margin: 0; color: var(--muted); font-size: .86rem; line-height: 1.7; }
    .ke-status { margin: 8px 0 0; color: var(--muted); font-size: .84rem; min-height: 1.2em; }

    .ke-char-card { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin-top: 20px; padding: 14px 18px; background: #f7f3ea; border: 1px solid #b9ab94; border-radius: 12px; box-shadow: 0 22px 45px rgba(80,62,38,.11); }
    .ke-avatar { display: grid; place-items: center; width: 46px; height: 46px; color: var(--forest); background: var(--cream); border: 1px solid var(--line-light); border-radius: 10px; font-family: Georgia, serif; font-weight: 900; font-size: 1.05rem; }
    .ke-char-main { flex: 1; min-width: 200px; }
    .ke-char-name { display: flex; align-items: center; gap: 9px; color: var(--forest); font-weight: 800; font-size: .95rem; }
    .ke-char-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; }
    .ke-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; color: #56604f; background: #efe9dc; border: 1px solid var(--line); border-radius: 999px; font-size: .7rem; font-weight: 700; }
    .ke-chip--map { color: var(--red-dark); background: #f6ece6; border-color: #dcc0b4; font-family: ui-monospace, Menlo, Consolas, monospace; }
    .ke-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .ke-tags-empty { color: #9a937f; font-size: .74rem; }
    .ke-tag { display: inline-flex; align-items: center; gap: 3px; padding: 2px 4px 2px 10px; color: var(--red-dark); background: #f6ece6; border: 1px solid #dcc0b4; border-radius: 999px; font-size: .74rem; font-weight: 700; }
    .ke-tag-x { display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; min-height: 0; padding: 0; color: inherit; background: transparent; border: none; border-radius: 50%; font-size: .82rem; font-weight: 400; line-height: 1; cursor: pointer; }
    .ke-tag-x:hover:not(:disabled) { color: #7c3325; background: rgba(184,77,63,.16); }
    .ke-char-switch { width: 250px; }
    .ke-char-switch > span { display: block; margin-bottom: 5px; color: var(--muted); font-size: .7rem; font-weight: 800; letter-spacing: .03em; }

    .ke-profile-grid { display: grid; grid-template-columns: repeat(auto-fill, 258px); justify-content: start; gap: 14px; }
    .ke-profile-card { display: flex; flex-direction: column; gap: 9px; padding: 14px 15px; background: #fffdf8; border: 1px solid #b9ab94; border-radius: 10px; box-shadow: 0 10px 22px rgba(80,62,38,.07); }
    .ke-profile-card.is-active { border-color: #7fae94; box-shadow: 0 0 0 1px #7fae94, 0 10px 22px rgba(44,122,89,.1); }
    .ke-profile-name { display: flex; align-items: center; gap: 8px; color: var(--forest); font-weight: 800; font-size: .92rem; overflow-wrap: anywhere; }
    .ke-badge-live { display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px; color: var(--buy); background: var(--buy-soft); border: 1px solid #b5d4c4; border-radius: 999px; font-size: .66rem; font-weight: 800; white-space: nowrap; }
    .ke-badge-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--buy); animation: ke-pulse 2.2s ease-in-out infinite; }
    @keyframes ke-pulse { 50% { opacity: .35; } }
    .ke-profile-actions { display: flex; gap: 7px; margin-top: 2px; }

    .ke-profile-new { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 128px; color: var(--muted); background: transparent; border: 1.5px dashed var(--line-light); border-radius: 10px; font-weight: 700; box-shadow: none; cursor: pointer; }
    .ke-profile-new:hover:not(:disabled) { color: var(--red-dark); border-color: var(--red); background: rgba(184,77,63,.04); }

    .ke-btn-ghost { color: var(--ink); background: #f7f3ea; border-color: #aa9d88; border-radius: 8px; min-height: 30px; padding: 3px 12px; font-size: .74rem; }
    .ke-btn-ghost:hover:not(:disabled) { color: var(--ink); background: #efe9dd; border-color: #97896f; }
    .ke-btn-quiet { color: var(--muted); background: transparent; }
    .ke-btn-quiet:hover:not(:disabled) { color: var(--forest); background: #efe9dd; }
    .ke-btn-primary { border-radius: 8px; min-height: 40px; }
    .ke-btn-live { color: var(--buy); background: var(--buy-soft); border-color: #b5d4c4; border-radius: 8px; min-height: 30px; padding: 3px 12px; font-size: .74rem; font-weight: 800; }
    .ke-btn-live:hover:not(:disabled) { color: #1f5e43; background: #d5e8de; border-color: var(--buy); }
    .ke-btn-danger { color: var(--red-dark); background: #fdf6f3; border-color: #d8b3a9; border-radius: 8px; min-height: 30px; padding: 3px 12px; font-size: .74rem; font-weight: 800; }
    .ke-btn-danger:hover:not(:disabled) { color: var(--red-dark); background: #f6e7e1; border-color: var(--red-dark); }

    .ke-empty { display: grid; gap: 8px; justify-items: center; padding: 30px 20px; color: var(--muted); background: #fffdf8; border: 1.5px dashed var(--line-light); border-radius: 10px; text-align: center; font-size: .84rem; line-height: 1.7; }
    .ke-empty b { color: var(--forest); font-size: .92rem; }

    .ke-editor { background: #f7f3ea; border: 1px solid #b9ab94; border-radius: 12px; box-shadow: 0 22px 45px rgba(80,62,38,.11); }
    .ke-editor-head { position: sticky; top: 74px; z-index: 6; display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 13px 20px; background: rgba(247,243,234,.96); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); border-radius: 12px 12px 0 0; }
    .ke-field-name { flex: 1; min-width: 220px; }
    .ke-field-name input { min-height: 40px; font-weight: 700; }
    .ke-dirty { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; color: #835f18; background: var(--tip-soft); border: 1px solid var(--tip-line); border-radius: 999px; font-size: .7rem; font-weight: 800; white-space: nowrap; }
    .ke-dirty i { width: 7px; height: 7px; border-radius: 50%; background: var(--gold); }
    .ke-editor-actions { display: flex; gap: 8px; }
    .ke-error { margin: 0; padding: 10px 20px 0; color: var(--red-dark); font-size: .82rem; font-weight: 700; white-space: pre-line; }
    .ke-error[hidden] { display: none; }

    .ke-editor-body { display: grid; grid-template-columns: 196px minmax(0, 1fr) 272px; }
    .ke-nav { display: flex; flex-direction: column; padding: 14px 10px 18px; border-right: 1px solid var(--line); }
    .ke-nav-label { margin: 10px 8px 6px; color: var(--muted); font-size: .62rem; font-weight: 900; letter-spacing: .12em; }
    .ke-nav-item { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 36px; margin: 1px 0; padding: 6px 10px; color: #4c5a50; background: transparent; border: 1px solid transparent; border-radius: 8px; font-weight: 700; font-size: .8rem; text-align: left; box-shadow: none; }
    .ke-nav-item svg { flex: none; width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
    .ke-nav-item:hover:not(:disabled) { color: var(--forest); background: rgba(255,253,248,.7); }
    .ke-nav-item.is-active { color: var(--forest); background: #fffdf8; border-color: var(--line-light); box-shadow: 0 2px 8px rgba(80,62,38,.08); }
    .ke-count { margin-left: auto; padding: 0 7px; color: var(--red-dark); background: #f6ece6; border-radius: 999px; font-size: .64rem; font-weight: 800; }

    .ke-main { padding: 18px 22px 26px; min-width: 0; }
    .ke-tab-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin: 2px 0 4px; }
    .ke-tab-head h3 { margin: 0; color: var(--forest); font-family: Georgia, "Microsoft YaHei", serif; font-size: 1.12rem; }
    .ke-tab-head p { margin: 0; color: var(--muted); font-size: .74rem; }

    .ke-group { margin-top: 14px; padding: 15px 17px 6px; background: #fffdf8; border: 1px solid var(--line); border-radius: 10px; }
    .ke-group-title { display: flex; align-items: baseline; gap: 8px; margin: 0 0 12px; color: var(--paper); font-size: .78rem; font-weight: 900; letter-spacing: .05em; }
    .ke-group-title small { color: var(--muted); font-weight: 600; letter-spacing: 0; }
    .ke-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 22px; padding-bottom: 12px; }
    .ke-field { display: grid; gap: 5px; }
    .ke-field-label { display: flex; align-items: center; gap: 6px; color: #4c5a50; font-size: .74rem; font-weight: 800; }
    .ke-suffix { color: var(--muted); font-weight: 600; font-size: .7rem; }
    .ke-help { position: relative; display: inline-grid; place-items: center; width: 15px; height: 15px; margin-left: auto; color: #a99b87; background: #f1ecdf; border: 1px solid var(--line); border-radius: 50%; font-size: .6rem; font-weight: 900; cursor: help; }
    .ke-help .ke-tip { position: absolute; bottom: calc(100% + 8px); right: -6px; z-index: 30; width: 248px; padding: 9px 12px; color: #f3efe6; background: #2f3a34; border-radius: 7px; font-size: .72rem; font-weight: 500; line-height: 1.55; letter-spacing: 0; text-align: left; box-shadow: 0 6px 18px rgba(0,0,0,.22); opacity: 0; visibility: hidden; transform: translateY(3px); transition: .16s ease; }
    .ke-help:hover .ke-tip, .ke-help:focus-visible .ke-tip { opacity: 1; visibility: visible; transform: none; }
    .ke-help .ke-tip::after { content: ""; position: absolute; top: 100%; right: 14px; border: 5px solid transparent; border-top-color: #2f3a34; }

    .ke-editor input, .ke-editor select { border-radius: 8px; padding: 8px 11px; min-height: 38px; }
    .ke-seg { display: inline-flex; padding: 3px; background: #efe9dc; border: 1px solid var(--line); border-radius: 8px; gap: 2px; align-self: start; }
    .ke-seg button { min-height: 30px; padding: 4px 12px; color: #6d776f; background: transparent; border: 0; border-radius: 6px; font-size: .74rem; font-weight: 700; box-shadow: none; white-space: nowrap; }
    .ke-seg button:hover:not(:disabled) { color: var(--forest); background: rgba(255,253,248,.6); }
    .ke-seg button.is-on { color: var(--red-dark); background: #fffdf8; box-shadow: 0 1px 4px rgba(80,62,38,.16); }
    .ke-seg--mini { padding: 2px; gap: 2px; }
    .ke-seg--mini button { min-height: 26px; padding: 2px 10px; font-size: .7rem; border-radius: 5px; }

    .ke-block-sec { margin-top: 18px; }
    .ke-block-sec-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: 9px; }
    .ke-block-sec-head b { color: var(--paper); font-size: .86rem; }
    .ke-block-sec-head small { color: var(--muted); font-size: .72rem; flex: 1; min-width: 160px; }
    .ke-block-add { color: var(--red-dark); background: transparent; border: 1px dashed #cfa692; border-radius: 8px; min-height: 30px; padding: 3px 12px; font-size: .74rem; font-weight: 800; }
    .ke-block-add:hover:not(:disabled) { color: var(--red-dark); background: rgba(184,77,63,.06); }
    .ke-block-list { display: grid; gap: 10px; }
    .ke-block-card { background: #fffdf8; border: 1px solid var(--line); border-radius: 10px; }
    .ke-block-card.is-open { border-color: #b9ab94; box-shadow: 0 6px 16px rgba(80,62,38,.07); }
    .ke-block-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; width: 100%; padding: 10px 14px; color: inherit; background: transparent; border: 0; border-radius: 10px; cursor: pointer; text-align: left; box-shadow: none; font-weight: 400; }
    .ke-block-head:hover:not(:disabled) { background: rgba(239,233,220,.5); }
    .ke-b-name { color: var(--forest); font-weight: 800; font-size: .84rem; }
    .ke-b-skill { color: var(--red-dark); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .74rem; }
    .ke-chev { margin-left: auto; color: var(--muted); transition: transform .18s ease; }
    .ke-block-card.is-open .ke-chev { transform: rotate(180deg); }
    .ke-block-body { padding: 4px 16px 14px; border-top: 1px dashed var(--line); }

    .ke-cond { margin-top: 12px; padding: 10px 12px 4px; background: var(--forest-card); border: 1px solid var(--line); border-radius: 8px; }
    .ke-cond-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--muted); font-size: .68rem; font-weight: 900; letter-spacing: .05em; }
    .ke-cond-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; gap: 8px; align-items: start; margin-bottom: 8px; }
    .ke-cond-row input, .ke-cond-row select { min-height: 34px; padding: 5px 10px; font-size: .78rem; }
    .ke-cond-expr { display: flex; gap: 4px; align-items: center; }
    .ke-cond-expr input, .ke-cond-expr select { width: auto; }
    .ke-cond-expr .ke-cond-op { flex: 0 0 52px; width: 52px; }
    .ke-cond-expr input { flex: 1 1 0; min-width: 0; }
    .ke-cond-expr .ke-cond-suffix { flex: 0 0 60px; width: 60px; }
    .ke-icon-btn { min-height: 34px; width: 34px; padding: 0; display: grid; place-items: center; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: 7px; font-weight: 400; font-size: 1rem; }
    .ke-icon-btn:hover:not(:disabled) { color: var(--red-dark); border-color: #d8b3a9; background: #fdf6f3; }

    .ke-adv { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px; }
    .ke-adv summary { cursor: pointer; color: var(--muted); font-size: .72rem; font-weight: 800; user-select: none; }
    .ke-adv summary:hover { color: var(--forest); }
    .ke-adv-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 220px)); gap: 8px 16px; padding-top: 10px; }
    .ke-int-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #4c5a50; font-size: .74rem; font-weight: 700; }
    .ke-int-line input { width: 76px; min-height: 32px; padding: 4px 8px; flex: none; }

    .ke-tgl { display: inline-flex; align-items: center; gap: 6px; }
    .ke-tgl-box { flex-wrap: wrap; }
    .ke-tgl-label { color: #4c5a50; font-size: .72rem; font-weight: 800; white-space: nowrap; cursor: help; }
    .ke-editor input.ke-input-sm { width: 74px; min-height: 26px; padding: 2px 8px; font-size: .74rem; }
    .ke-dist-warn { flex-basis: 100%; color: var(--red-dark); font-size: .72rem; font-weight: 700; }

    .ke-rule-list { display: grid; gap: 10px; margin-top: 14px; }
    .ke-rule-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; padding: 12px 14px; background: #fffdf8; border: 1px solid var(--line); border-radius: 10px; }
    .ke-rule-row.is-fallback { border-style: dashed; }
    .ke-rule-name { width: 220px; min-width: 170px; }
    .ke-rn { color: var(--forest); font-weight: 800; font-size: .84rem; overflow-wrap: anywhere; }
    .ke-rn-code { color: #9b9488; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .68rem; }
    .ke-rule-main { flex: 1; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
    .ke-rule-note { width: 100%; margin: 0; color: var(--muted); font-size: .72rem; }
    .ke-rule-grid { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 26px; flex: 1; min-width: 240px; }
    .ke-rule-grid .ke-field input { width: 96px; }
    .ke-rule-remove { align-self: flex-start; }

    .ke-picker { position: relative; flex: 1; }
    .ke-picker-list { position: absolute; z-index: 20; left: 0; right: 0; max-height: 220px; overflow-y: auto; background: #fffdf8; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 18px rgba(74, 57, 35, .12); }
    .ke-picker-item { padding: 7px 11px; font-size: .8rem; cursor: pointer; }
    .ke-picker-group { padding: 5px 11px 3px; color: var(--muted); font-size: .62rem; font-weight: 800; letter-spacing: .06em; border-top: 1px dashed var(--line); background: #f7f3ea; }
    .ke-picker-more { padding: 6px 11px; color: var(--muted); font-size: .68rem; font-weight: 700; border-top: 1px dashed var(--line); background: #f7f3ea; }
    .ke-picker-item:hover { background: #f0e9d8; }

    .ke-side { padding: 16px 16px 22px; border-left: 1px solid var(--line); }
    .ke-side-card { padding: 13px 14px; background: #fffdf8; border: 1px solid var(--line); border-radius: 10px; }
    .ke-side-card + .ke-side-card { margin-top: 12px; }
    .ke-side-label { display: block; margin-bottom: 8px; color: var(--muted); font-size: .68rem; font-weight: 900; letter-spacing: .06em; }
    .ke-side-rows { display: grid; gap: 6px; color: var(--ink); font-size: .76rem; }
    .ke-side-rows > div { display: flex; justify-content: space-between; gap: 10px; }
    .ke-side-rows b { font-weight: 800; }
    .ke-side-status { display: flex; align-items: center; gap: 7px; margin-top: 9px; color: var(--muted); font-size: .72rem; }
    .ke-side-status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gold); }
    .ke-preview-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 0; padding: 0; color: var(--muted); background: transparent; border: 0; font-size: .68rem; font-weight: 900; letter-spacing: .06em; box-shadow: none; cursor: pointer; }
    .ke-preview-toggle:hover:not(:disabled) { color: var(--forest); background: transparent; }
    .ke-preview-pre { margin: 9px 0 0; padding: 11px 12px; max-height: 300px; overflow: auto; color: #4c5a50; background: var(--forest-card); border: 1px solid var(--line); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .7rem; line-height: 1.65; white-space: pre-wrap; word-break: break-all; }
    .ke-preview-pre[hidden] { display: none; }
    .ke-side-save { display: grid; gap: 8px; margin-top: 12px; }
    .ke-side-save .ke-btn-primary, .ke-side-save .ke-btn-ghost { min-height: 40px; font-size: .82rem; }

    .ke-editor-foot { display: none; position: sticky; bottom: 0; z-index: 5; gap: 10px; padding: 12px 16px; background: rgba(247,243,234,.97); backdrop-filter: blur(10px); border-top: 1px solid var(--line); border-radius: 0 0 12px 12px; }

    .ke-hint { margin: 14px 2px 0; color: var(--muted); font-size: .72rem; line-height: 1.7; }

    @media (max-width: 1080px) {
      .ke-editor-body { grid-template-columns: 176px minmax(0, 1fr); }
      .ke-side { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
      .ke-side-card + .ke-side-card { margin-top: 0; }
      .ke-side-save { margin-top: 0; align-self: start; }
    }
    @media (max-width: 760px) {
      .ke-editor-body { grid-template-columns: 1fr; }
      .ke-nav { flex-direction: row; overflow-x: auto; gap: 4px; border-right: 0; border-bottom: 1px solid var(--line); padding: 10px 12px; }
      .ke-nav-label { display: none; }
      .ke-nav-item { width: auto; white-space: nowrap; }
      .ke-nav-item .ke-count { display: none; }
      .ke-main { padding: 14px 14px 20px; }
      .ke-side { grid-template-columns: 1fr; }
      .ke-fields { grid-template-columns: 1fr; }
      .ke-char-switch { width: 100%; }
      .ke-profile-grid { grid-template-columns: 1fr 1fr; }
      .ke-cond-row { grid-template-columns: 1fr auto; }
      .ke-cond-row > :first-child { grid-column: 1 / -1; }
      .ke-editor-foot { display: flex; }
      .ke-side-save { display: none; }
      .ke-editor-head { padding: 11px 12px; }
    }
    @media (max-width: 520px) {
      .ke-profile-grid { grid-template-columns: 1fr; }
      .ke-field-name { min-width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ke-badge-live i, .ke-chev, .ke-help .ke-tip { transition: none !important; animation: none !important; }
    }
  </style>
  `;

  const status = root.querySelector<HTMLElement>("#ke-status")!;
  const charCard = root.querySelector<HTMLElement>("#ke-char-card")!;
  const avatar = root.querySelector<HTMLElement>("#ke-char-avatar")!;
  const charName = root.querySelector<HTMLElement>("#ke-char-name")!;
  const jobChip = root.querySelector<HTMLElement>("#ke-char-job")!;
  const charMeta = root.querySelector<HTMLElement>("#ke-char-meta")!;
  const charSelect = root.querySelector<HTMLSelectElement>("#ke-char-select")!;
  const profilesHead = root.querySelector<HTMLElement>("#ke-profiles-head")!;
  const profileList = root.querySelector<HTMLElement>("#ke-profile-list")!;
  const editor = root.querySelector<HTMLElement>("#ke-editor")!;
  const editorTitle = root.querySelector<HTMLElement>("#ke-editor-title")!;
  const nameInput = root.querySelector<HTMLInputElement>("#ke-profile-name")!;
  const dirtyBadge = root.querySelector<HTMLElement>("#ke-dirty")!;
  const formError = root.querySelector<HTMLElement>("#ke-form-error")!;
  const navBar = root.querySelector<HTMLElement>("#ke-nav")!;
  const tabPanels = root.querySelector<HTMLElement>("#ke-tab-panels")!;
  const sideStats = root.querySelector<HTMLElement>("#ke-side-stats")!;
  const dirtySide = root.querySelector<HTMLElement>("#ke-dirty-side")!;
  const previewToggle =
    root.querySelector<HTMLButtonElement>("#ke-preview-toggle")!;
  const previewFile = root.querySelector<HTMLElement>("#ke-preview-file")!;
  const preview = root.querySelector<HTMLElement>("#ke-config-preview")!;
  const mapsList = root.querySelector<HTMLDataListElement>("#ke-maps-list")!;

  function selectedCharacter(): KeCharacter | null {
    return (
      characters.find((c) => `${c.aid}:${c.cid}:${c.nid}` === selectedKey) ??
      null
    );
  }

  /** char_name / map_name 由 KE 客户端自报，属于不可信输入，必须按纯文本写入（禁止拼进 innerHTML）。 */
  function fillCharacterSelect(): void {
    charSelect.replaceChildren(
      ...characters.map((character) => {
        const option = document.createElement("option");
        option.value = `${character.aid}:${character.cid}:${character.nid}`;
        option.textContent = `${character.char_name}（${character.map_name ?? "未知地图"}）`;
        return option;
      }),
    );
  }

  // —— 状态徽章 / 预览 / 统计 ——

  function markDirty(): void {
    dirty = true;
    dirtyBadge.hidden = false;
    dirtySide.hidden = false;
  }

  function clearDirty(): void {
    dirty = false;
    dirtyBadge.hidden = true;
    dirtySide.hidden = true;
  }

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("有未保存的更改，确定放弃这些修改吗？");
  }

  function updatePreview(): void {
    const entry = NAV.find((n) => n.id === activeTab) ?? NAV[0]!;
    if (entry.kind === "controls") {
      const schema = CONTROL_SCHEMAS.find((s) => s.file === entry.file)!;
      previewFile.textContent = entry.file!.toUpperCase();
      const text = serializeControl(schema, controlDoc[entry.file!] ?? []);
      preview.textContent = text === "" ? "（空）" : text;
    } else {
      previewFile.textContent = "CONFIG.TXT";
      preview.textContent = serializeConfig(configDoc);
    }
  }

  function updateNavCounts(): void {
    for (const entry of NAV) {
      const el = navBar.querySelector<HTMLElement>(
        `[data-tab="${entry.id}"] .ke-count`,
      );
      if (!el) continue;
      if (entry.kind === "skills") {
        const types = entry.blockTypes;
        const total = Object.entries(configDoc.blocks).reduce(
          (sum, [type, list]) =>
            types && !types.includes(type) ? sum : sum + list.length,
          0,
        );
        el.textContent = String(total);
        el.hidden = total === 0;
      } else if (entry.kind === "controls") {
        const rows = controlDoc[entry.file!] ?? [];
        el.textContent = String(rows.length);
        el.hidden = rows.length === 0;
      } else {
        el.hidden = true;
      }
    }
  }

  function updateSideStats(): void {
    const character = selectedCharacter();
    const filled = Object.values(configDoc.scalars).filter(
      (v) => v !== "",
    ).length;
    const blocks = Object.values(configDoc.blocks).reduce(
      (sum, list) => sum + list.length,
      0,
    );
    const rules = Object.values(controlDoc).reduce(
      (sum, rows) => sum + rows.length,
      0,
    );
    sideStats.innerHTML = `
      <div>目标角色<b>${escapeHtml(character?.char_name ?? "—")}</b></div>
      <div>已填设置<b>${filled} 项</b></div>
      <div>技能规则<b>${blocks} 条</b></div>
      <div>规则表条目<b>${rules} 条</b></div>
    `;
  }

  function escapeHtml(text: string): string {
    return text.replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch]!,
    );
  }

  function refreshAll(): void {
    updatePreview();
    updateNavCounts();
    updateSideStats();
  }

  // —— 通用控件 ——

  function helpTip(label: string, help: string): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "ke-field-label";
    const text = document.createElement("span");
    text.textContent = label;
    wrap.appendChild(text);
    if (help) {
      const badge = document.createElement("span");
      badge.className = "ke-help";
      badge.tabIndex = 0;
      badge.textContent = "?";
      const tip = document.createElement("span");
      tip.className = "ke-tip";
      tip.textContent = help;
      badge.appendChild(tip);
      wrap.appendChild(badge);
    }
    return wrap;
  }

  function suffixEl(suffix: string): HTMLElement {
    const span = document.createElement("span");
    span.className = "ke-suffix";
    span.textContent = suffix;
    return span;
  }

  interface SegOption {
    value: string;
    label: string;
    hint?: string;
  }

  /** 分段按钮。allowUnset：再次点击已选段清空（用于无默认值的 block 字段）。 */
  function segEl(
    segOptions: SegOption[],
    value: string,
    onChange: (value: string) => void,
    variant: "" | "mini" | "miniRed" | "red" = "",
    allowUnset = false,
  ): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = `ke-seg${variant ? ` ke-seg--${variant}` : ""}`;
    wrap.setAttribute("role", "group");
    for (const option of segOptions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = option.label;
      btn.title = option.hint ?? "";
      btn.dataset.value = option.value;
      const sync = (): void => {
        const on = option.value === value;
        btn.classList.toggle("is-on", on);
        btn.setAttribute("aria-pressed", String(on));
      };
      sync();
      btn.addEventListener("click", () => {
        const next = allowUnset && option.value === value ? "" : option.value;
        if (next === value && !allowUnset) return;
        value = next;
        wrap.querySelectorAll("button").forEach((b) => {
          b.classList.toggle("is-on", b.dataset.value === value);
          b.setAttribute("aria-pressed", String(b.dataset.value === value));
        });
        onChange(value);
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function createPicker(
    listOptions: PickerOption[],
    value: string,
    onSelect: (v: string) => void,
    resetOnSelect = false,
    placeholder = "搜索并选择…",
  ): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "ke-picker";
    const input = document.createElement("input");
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.value = listOptions.find((o) => o.value === value)?.label ?? value;
    const list = document.createElement("div");
    list.className = "ke-picker-list";
    list.hidden = true;
    wrapper.append(input, list);

    function render(query: string): void {
      list.innerHTML = "";
      const q = query.toLowerCase();
      const matches = listOptions.filter(
        (o) =>
          String(o.label ?? "")
            .toLowerCase()
            .includes(q) ||
          String(o.value ?? "")
            .toLowerCase()
            .includes(q),
      );
      // 分组选项（如「一转技能 / 二转技能」）放最前并用小标题隔离；常规选项在后。
      const grouped = new Map<string, PickerOption[]>();
      const plain: PickerOption[] = [];
      for (const option of matches) {
        if (option.group) {
          const bucket = grouped.get(option.group) ?? [];
          bucket.push(option);
          grouped.set(option.group, bucket);
        } else {
          plain.push(option);
        }
      }
      let shownPlain = 0;
      let shownGrouped = 0;
      let truncated = false;
      const appendItems = (
        entries: PickerOption[],
        isGrouped: boolean,
      ): void => {
        for (const option of entries) {
          if (isGrouped ? shownGrouped >= PICKER_LIMIT : shownPlain >= PICKER_LIMIT) {
            truncated = true;
            return;
          }
          if (isGrouped) shownGrouped += 1;
          else shownPlain += 1;
          const item = document.createElement("div");
          item.className = "ke-picker-item";
          item.textContent = option.label;
          item.addEventListener("mousedown", (event) => {
            event.preventDefault();
            input.value = resetOnSelect ? "" : option.label;
            onSelect(option.value);
            list.hidden = true;
          });
          list.appendChild(item);
        }
      };
      const groupHeader = (title: string): void => {
        const header = document.createElement("div");
        header.className = "ke-picker-group";
        header.textContent = title;
        list.appendChild(header);
      };
      for (const [title, bucket] of grouped) {
        groupHeader(title);
        appendItems(bucket, true);
      }
      if (grouped.size > 0 && plain.length > 0 && shownGrouped < PICKER_LIMIT) {
        groupHeader("本职业技能");
      }
      appendItems(plain, false);
      if (truncated) {
        const more = document.createElement("div");
        more.className = "ke-picker-more";
        more.textContent = `已达 ${PICKER_LIMIT} 项上限，请直接输入文字继续过滤`;
        more.addEventListener("mousedown", (event) => event.preventDefault());
        list.appendChild(more);
      }
      list.hidden = shownPlain + shownGrouped === 0;
    }

    input.addEventListener("focus", () => {
      render(input.value);
      list.hidden = false;
    });
    input.addEventListener("input", () => {
      // 选择器的值与显示文本一一对应（标量 item 字段、技能 selector 等 value 即用户输入），
      // 因此输入/清空必须同步回数据源，否则保存时旧值仍会被写回 config.txt。
      onSelect(input.value);
      render(input.value);
      list.hidden = false;
    });
    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        list.hidden = true;
      }, 150);
    });
    return wrapper;
  }

  // 卡片 / 装备可带来的通用技能（按 handle 匹配）：即使不属于当前职业，也始终出现在技能选择器里。
  // 只保留最常用的两个，避免干扰日常选择。
  const UNIVERSAL_SKILL_HANDLES = new Set([
    "AL_TELEPORT", // 瞬间移动
    "AL_HEAL", // 治愈术
  ]);

  function skillOptions(): PickerOption[] {
    if (!options) return [];
    // 「全部技能」：不按当前职业过滤，改为按所属职业分组（通用技能 / 各职业 / 其他技能）。
    if (showAllSkills) {
      const byJob = options.skill_groups;
      return options.skills.map((s) => ({
        label: skillLabel(s),
        value: String(s.id),
        ...(byJob ? { group: byJob[String(s.id)] ?? "其他技能" } : {}),
      }));
    }
    const jobGroups =
      selectedJobId !== null
        ? options.job_skill_groups?.[String(selectedJobId)]
        : null;
    const groupedIds = jobGroups
      ? new Map(
          Object.entries(jobGroups).flatMap(([group, ids]) =>
            ids.map((id) => [id, group] as const),
          ),
        )
      : null;
    const jobIds = groupedIds
      ? new Set(groupedIds.keys())
      : selectedJobId !== null && options.job_skills
        ? new Set(options.job_skills[String(selectedJobId)] ?? [])
        : null;
    const skills = jobIds
      ? options.skills.filter(
          (s) =>
            jobIds.has(s.id) ||
            (s.handle !== undefined && UNIVERSAL_SKILL_HANDLES.has(s.handle)),
        )
      : options.skills;
    return skills.map((s) => ({
      label: skillLabel(s),
      value: String(s.id),
      ...(groupedIds
        ? { group: groupedIds.get(s.id) ?? "通用技能" }
        : jobIds && !jobIds.has(s.id)
          ? { group: "通用技能" }
          : {}),
    }));
  }

  function skillLabel(skill: SkillOption): string {
    const english = skill.name || skill.handle || String(skill.id);
    const chinese =
      skill.nameZh || skill.name || skill.handle || String(skill.id);
    return chinese === english ? chinese : chinese + " (" + english + ")";
  }

  function itemOptions(): PickerOption[] {
    return (options?.items ?? []).map((i) => ({
      label: i.name,
      value: String(i.id),
    }));
  }

  /** 道具名称选择器（传送类道具存道具名称，OpenKore 按 name 匹配），value 直接用名称。 */
  function itemNameOptions(): PickerOption[] {
    return (options?.items ?? []).map((i) => ({
      label: i.name,
      value: i.name,
    }));
  }

  function monsterOptions(): PickerOption[] {
    return (options?.monsters ?? []).map((m) => ({
      label: m.name,
      value: String(m.id),
    }));
  }

  /** 把逗号分隔的怪物 ID 串解析成中文名（找不到的保留原值）。 */
  function monsterNamesOf(csv: string): string {
    const pool = monsterOptions();
    return csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => pool.find((o) => o.value === id)?.label ?? id)
      .join("、");
  }

  function statusOptions(): PickerOption[] {
    return (options?.statuses ?? []).map((s) => {
      const english = s.name || s.handle;
      const chinese = s.nameZh || s.name || s.handle;
      return {
        label: chinese === english ? chinese : chinese + " (" + english + ")",
        value: s.handle,
      };
    });
  }

  // —— 比较条件编辑器 ——

  const COMPARISON_OPS = ["<", "<=", "=", ">=", ">"] as const;

  interface ConditionExpr {
    op: string;
    value: string;
    percent: boolean;
  }

  /** 解析比较表达式文本，如 "< 50%" → { op: "<", value: "50", percent: true }。无法解析时返回 null。 */
  function parseConditionExpr(text: string): ConditionExpr | null {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const match = trimmed.match(/^([<>=!]+)\s*([\d.]+)\s*(%)?$/);
    if (match) return { op: match[1]!, value: match[2]!, percent: match[3] === "%" };
    const numMatch = trimmed.match(/^([\d.]+)\s*(%)?$/);
    if (numMatch) return { op: "=", value: numMatch[1]!, percent: numMatch[2] === "%" };
    return null;
  }

  function serializeConditionExpr(expr: ConditionExpr): string {
    if (expr.value === "") return "";
    return `${expr.op} ${expr.value}${expr.percent ? "%" : ""}`;
  }

  /**
   * 三段式比较条件编辑器：操作符下拉 + 数值输入 + （可选）百分比后缀下拉。
   * allowPercent 为 false 时不渲染后缀，纯数值。
   */
  function createComparisonEditor(
    initialText: string,
    onChange: (text: string) => void,
    allowPercent: boolean,
  ): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "ke-cond-expr";

    const parsed = parseConditionExpr(initialText);
    const expr: ConditionExpr = parsed ?? {
      op: "<",
      value: "",
      percent: allowPercent, // 百分比类条件新建时默认 %
    };
    // 纯数值条件强制 percent=false
    if (!allowPercent) expr.percent = false;

    const opSelect = document.createElement("select");
    opSelect.className = "ke-cond-op";
    for (const op of COMPARISON_OPS) {
      const option = document.createElement("option");
      option.value = op;
      option.textContent = op;
      opSelect.appendChild(option);
    }
    opSelect.value = expr.op;

    const numInput = document.createElement("input");
    numInput.type = "text";
    numInput.inputMode = "decimal";
    numInput.value = expr.value;
    numInput.placeholder = "数值";

    let suffixSelect: HTMLSelectElement | null = null;
    if (allowPercent) {
      suffixSelect = document.createElement("select");
      suffixSelect.className = "ke-cond-suffix";
      const percentOption = document.createElement("option");
      percentOption.value = "%";
      percentOption.textContent = "%";
      suffixSelect.appendChild(percentOption);
      const noneOption = document.createElement("option");
      noneOption.value = "";
      noneOption.textContent = "数值";
      suffixSelect.appendChild(noneOption);
      suffixSelect.value = expr.percent ? "%" : "";
    }

    function sync(): void {
      expr.op = opSelect.value;
      expr.value = numInput.value;
      expr.percent = suffixSelect?.value === "%";
      onChange(serializeConditionExpr(expr));
    }

    opSelect.addEventListener("change", sync);
    numInput.addEventListener("input", sync);
    suffixSelect?.addEventListener("change", sync);

    wrapper.append(opSelect, numInput);
    if (suffixSelect) wrapper.appendChild(suffixSelect);
    return wrapper;
  }

  // —— 条件控件：怪物多选 / 物品数量 / 地图 / 职业 ——

  /**
   * 怪物多选编辑器：已选怪物以 chips 展示（可逐个移除）+ 搜索选择器追加。
   * 值为逗号分隔的怪物 ID 串；空串回调 '' 表示清空。
   */
  function createMonsterChipsEditor(
    initialValue: string,
    onChange: (csv: string) => void,
    emptyText = "未指定，对全部怪物生效",
  ): HTMLElement {
    const wrap = document.createElement("div");
    const pool = monsterOptions();
    const chips = document.createElement("div");
    chips.className = "ke-tags";
    let current = initialValue;
    const idsOf = (): string[] =>
      current.split(",").map((s) => s.trim()).filter(Boolean);
    function renderChips(): void {
      chips.innerHTML = "";
      const ids = idsOf();
      if (ids.length === 0) {
        const empty = document.createElement("span");
        empty.className = "ke-tags-empty";
        empty.textContent = emptyText;
        chips.appendChild(empty);
        return;
      }
      for (const id of ids) {
        const name = pool.find((o) => o.value === id)?.label ?? `怪物 #${id}`;
        const tag = document.createElement("span");
        tag.className = "ke-tag";
        const label = document.createElement("span");
        label.textContent = name;
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "ke-tag-x";
        removeBtn.title = `移除 ${name}`;
        removeBtn.setAttribute("aria-label", `移除 ${name}`);
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", () => {
          const rest = idsOf().filter((v) => v !== id);
          current = rest.join(", ");
          onChange(current);
          renderChips();
        });
        tag.append(label, removeBtn);
        chips.appendChild(tag);
      }
    }
    renderChips();
    wrap.appendChild(chips);
    wrap.appendChild(
      createPicker(pool, "", (value) => {
        const ids = idsOf();
        if (!ids.includes(value)) ids.push(value);
        current = ids.join(", ");
        onChange(current);
        renderChips();
      }, true, "＋ 搜索怪物加入列表…"),
    );
    return wrap;
  }

  /**
   * 物品数量条件编辑器：物品单选搜索 + 操作符 + 数值。
   * 序列化为 "物品 > 1"；物品或数值为空时回调 ''。
   * pool 的 value 决定存物品名还是物品 ID。
   */
  function createItemAmountEditor(
    initialText: string,
    onChange: (text: string) => void,
    pool: PickerOption[],
  ): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "ke-cond-expr ke-cond-item";

    // 解析 "红色药水 > 1" / "501 >= 2"
    const match = initialText.trim().match(/^(.+?)\s*([<>=!]+)\s*([\d.]+)$/);
    let item = match?.[1]?.trim() ?? "";
    let op = match?.[2] ?? ">";
    let num = match?.[3] ?? "";

    const opSelect = document.createElement("select");
    opSelect.className = "ke-cond-op";
    for (const opItem of COMPARISON_OPS) {
      const option = document.createElement("option");
      option.value = opItem;
      option.textContent = opItem;
      opSelect.appendChild(option);
    }
    opSelect.value = COMPARISON_OPS.includes(op as (typeof COMPARISON_OPS)[number]) ? op : ">";

    const numInput = document.createElement("input");
    numInput.type = "text";
    numInput.inputMode = "decimal";
    numInput.value = num;
    numInput.placeholder = "数量";

    function sync(): void {
      op = opSelect.value;
      num = numInput.value.trim();
      onChange(item === "" || num === "" ? "" : `${item} ${op} ${num}`);
    }

    const itemPicker = createPicker(pool, item, (value) => {
      item = value;
      sync();
    }, false, "搜索物品…");

    opSelect.addEventListener("change", sync);
    numInput.addEventListener("input", sync);

    wrapper.append(itemPicker, opSelect, numInput);
    return wrapper;
  }

  function mapOptions(): PickerOption[] {
    return (options?.maps ?? []).map((m) => ({ label: m.code, value: m.code }));
  }

  /** 职业选择器：value 存职业英文名（OpenKore target_isJob 语义），label 显示中文 + 英文。 */
  function jobOptions(): PickerOption[] {
    const jobs = options?.jobs ?? {};
    const jobsZh = options?.jobs_zh ?? {};
    return Object.entries(jobs).map(([id, name]) => {
      const zh = jobsZh[id];
      return {
        label: zh && zh !== name ? `${zh} (${name})` : name,
        value: name,
      };
    });
  }

  // —— 角色卡 ——

  function renderCharCard(): void {
    const character = selectedCharacter();
    if (!character) {
      charCard.hidden = true;
      return;
    }
    charCard.hidden = false;
    avatar.textContent = character.char_name.slice(0, 1) || "?";
    charName.textContent = character.char_name;
    const jobName =
      character.job_id !== null
        ? (options?.jobs_zh?.[String(character.job_id)] ??
          options?.jobs[String(character.job_id)])
        : undefined;
    jobChip.hidden = !jobName;
    jobChip.textContent = jobName ?? "";
    charMeta.innerHTML = "";
    if (character.map_name) {
      const mapChip = document.createElement("span");
      mapChip.className = "ke-chip ke-chip--map";
      mapChip.textContent = character.map_name;
      charMeta.appendChild(mapChip);
    }
    if (character.last_seen_at) {
      const seenChip = document.createElement("span");
      seenChip.className = "ke-chip";
      seenChip.textContent = `最近在线 ${relativeTime(character.last_seen_at)}`;
      charMeta.appendChild(seenChip);
    }
  }

  // —— Profile 列表 ——

  function renderProfiles(profiles: ProfileSummary[]): void {
    profilesHead.hidden = false;
    profileList.hidden = false;
    profileList.innerHTML = "";
    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ke-empty";
      empty.style.gridColumn = "1 / -1";
      empty.innerHTML =
        "<b>该角色还没有配置方案</b><span>新建一套方案，选好挂机地图和技能，就能开始自动挂机。</span>";
      const newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "ke-btn-primary";
      newBtn.textContent = "＋ 新建第一套方案";
      newBtn.addEventListener("click", () => {
        if (confirmDiscard()) void openEditor(null);
      });
      empty.appendChild(newBtn);
      profileList.appendChild(empty);
      return;
    }
    for (const profile of profiles) {
      const card = document.createElement("article");
      card.className = `ke-profile-card${profile.is_active ? " is-active" : ""}`;
      const name = document.createElement("div");
      name.className = "ke-profile-name";
      const nameText = document.createElement("span");
      nameText.textContent = profile.name;
      name.appendChild(nameText);
      if (profile.is_active) {
        const badge = document.createElement("span");
        badge.className = "ke-badge-live";
        badge.innerHTML = "<i></i>使用中";
        name.appendChild(badge);
      }
      const actions = document.createElement("div");
      actions.className = "ke-profile-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ke-btn-ghost";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => {
        if (confirmDiscard()) void openEditor(profile.id);
      });
      const activate = document.createElement("button");
      activate.type = "button";
      activate.className = "ke-btn-live";
      activate.textContent = profile.is_active ? "已激活" : "激活";
      activate.disabled = profile.is_active;
      activate.addEventListener(
        "click",
        () => void activateProfile(profile.id),
      );
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ke-btn-danger";
      remove.textContent = "删除";
      remove.addEventListener("click", () => void deleteProfile(profile.id));
      actions.append(edit, activate, remove);
      card.append(name, actions);
      profileList.appendChild(card);
    }
    const newCard = document.createElement("button");
    newCard.type = "button";
    newCard.className = "ke-profile-new";
    newCard.textContent = "＋ 新建配置方案";
    newCard.addEventListener("click", () => {
      if (confirmDiscard()) void openEditor(null);
    });
    profileList.appendChild(newCard);
  }

  // —— 编辑器导航 ——

  function renderNav(): void {
    navBar.innerHTML = "";
    let lastGroup = "";
    for (const entry of NAV) {
      if (entry.group !== lastGroup) {
        lastGroup = entry.group;
        const label = document.createElement("p");
        label.className = "ke-nav-label";
        label.textContent = entry.group;
        navBar.appendChild(label);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `ke-nav-item${entry.id === activeTab ? " is-active" : ""}`;
      btn.dataset.tab = entry.id;
      btn.setAttribute(
        "aria-current",
        entry.id === activeTab ? "true" : "false",
      );
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[entry.icon] ?? ""}</svg><span></span><span class="ke-count" hidden></span>`;
      (btn.children[1] as HTMLElement).textContent = entry.label;
      btn.addEventListener("click", () => switchTab(entry.id));
      navBar.appendChild(btn);
    }
    updateNavCounts();
  }

  function switchTab(tabId: string): void {
    if (activeTab === tabId) return;
    activeTab = tabId;
    for (const btn of Array.from(
      navBar.querySelectorAll<HTMLButtonElement>(".ke-nav-item"),
    )) {
      const on = btn.dataset.tab === tabId;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-current", on ? "true" : "false");
    }
    renderActivePanel();
  }

  function renderActivePanel(): void {
    const entry = NAV.find((n) => n.id === activeTab) ?? NAV[0]!;
    tabPanels.innerHTML = "";
    const head = document.createElement("div");
    head.className = "ke-tab-head";
    const h3 = document.createElement("h3");
    h3.textContent = entry.title;
    const sub = document.createElement("p");
    sub.textContent = entry.sub;
    head.append(h3, sub);
    tabPanels.appendChild(head);
    if (entry.kind === "scalars") renderScalarsTab(entry);
    else if (entry.kind === "skills") renderSkillsTab(entry);
    else renderControlsTab(entry);
    updatePreview();
  }

  // —— 标量分区（基础/战斗/生存/拾取/跟随/补给） ——

  function renderScalarsTab(entry: NavEntry): void {
    let shown = 0;
    for (const group of entry.groups ?? []) {
      const scalars = CONFIG_SCALARS.filter((s) => s.group === group);
      if (scalars.length === 0) continue;
      shown += scalars.length;
      const groupEl = document.createElement("div");
      groupEl.className = "ke-group";
      const title = document.createElement("p");
      title.className = "ke-group-title";
      title.textContent = group;
      groupEl.appendChild(title);
      const fields = document.createElement("div");
      fields.className = "ke-fields";
      for (const scalar of scalars) fields.appendChild(renderScalar(scalar));
      groupEl.appendChild(fields);
      tabPanels.appendChild(groupEl);
    }
    if (shown === 0) {
      const empty = document.createElement("p");
      empty.className = "ke-hint";
      empty.textContent = "该分区暂无可配置项。";
      tabPanels.appendChild(empty);
    }
  }

  function renderScalar(scalar: ScalarDef): HTMLElement {
    const field = document.createElement("label");
    field.className = "ke-field";
    field.appendChild(helpTip(scalar.label, scalar.help));
    let control: HTMLInputElement | HTMLSelectElement;
    if (scalar.type === "enum") {
      const seg = segEl(
        scalar.options ?? [],
        configDoc.scalars[scalar.key] ?? scalar.default ?? "",
        (value) => {
          configDoc.scalars[scalar.key] = value;
          markDirty();
          updatePreview();
        },
      );
      field.appendChild(seg);
      return field;
    }
    if (scalar.picker === "item") {
      const picker = createPicker(
        itemNameOptions(),
        configDoc.scalars[scalar.key] ?? "",
        (value) => {
          configDoc.scalars[scalar.key] = value;
          markDirty();
          updatePreview();
        },
      );
      field.appendChild(picker);
      return field;
    }
    if (scalar.type === "map") {
      const input = document.createElement("input");
      input.type = "text";
      input.setAttribute("list", "ke-maps-list");
      input.placeholder = "地图代码，如 prt_fild08";
      input.value = configDoc.scalars[scalar.key] ?? "";
      control = input;
    } else {
      const input = document.createElement("input");
      input.type = scalar.type === "int" ? "number" : "text";
      input.inputMode = scalar.type === "int" ? "decimal" : "text";
      input.step = "any";
      input.placeholder = scalar.default ?? "未设置";
      input.value = configDoc.scalars[scalar.key] ?? "";
      control = input;
    }
    control.addEventListener("input", () => {
      configDoc.scalars[scalar.key] = control.value;
      markDirty();
      updatePreview();
    });
    field.appendChild(control);
    if (scalar.suffix) field.appendChild(suffixEl(scalar.suffix));
    return field;
  }

  // —— 技能分区（block 卡片） ——

  function renderSkillsTab(entry: NavEntry): void {
    const isMainSkillTab = entry.id === "skills";
    if (isMainSkillTab && selectedJobId !== null && options?.job_skills !== undefined) {
      const row = document.createElement("div");
      row.className = "ke-hint";
      row.style.marginTop = "8px";
      const check = document.createElement("label");
      check.style.display = "flex";
      check.style.alignItems = "center";
      check.style.gap = "8px";
      check.style.fontWeight = "600";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "ke-allskills";
      checkbox.style.width = "auto";
      checkbox.style.minHeight = "0";
      checkbox.checked = showAllSkills;
      checkbox.addEventListener("change", () => {
        showAllSkills = checkbox.checked;
        renderActivePanel();
      });
      check.append(
        checkbox,
        document.createTextNode(
          "显示全部技能（按职业分组，含卡片 / 装备带来的跨职业技能）",
        ),
      );
      row.appendChild(check);
      tabPanels.appendChild(row);
    }

    // 智能治疗等「技能」组标量：属于技能行为，只跟随主技能规则页展示。
    const smartScalars = isMainSkillTab ? CONFIG_SCALARS.filter((s) => s.group === "技能") : [];
    if (smartScalars.length > 0) {
      const groupEl = document.createElement("div");
      groupEl.className = "ke-group";
      const title = document.createElement("p");
      title.className = "ke-group-title";
      title.textContent = "治疗辅助";
      groupEl.appendChild(title);
      const fields = document.createElement("div");
      fields.className = "ke-fields";
      for (const scalar of smartScalars)
        fields.appendChild(renderScalar(scalar));
      groupEl.appendChild(fields);
      tabPanels.appendChild(groupEl);
    }

    const defs = BLOCK_DEFS.filter(
      (def) => !entry.blockTypes || entry.blockTypes.includes(def.type),
    );
    const withBlocks = defs.filter(
      (def) => (configDoc.blocks[def.type] ?? []).length > 0,
    );
    const withoutBlocks = defs.filter(
      (def) => (configDoc.blocks[def.type] ?? []).length === 0,
    );

    for (const def of withBlocks) renderBlockSection(def);

    if (withoutBlocks.length > 0) {
      const addArea = document.createElement("div");
      addArea.className = "ke-block-sec";
      const head = document.createElement("div");
      head.className = "ke-block-sec-head";
      const b = document.createElement("b");
      b.textContent = "添加新规则";
      const small = document.createElement("small");
      small.textContent =
        "还没有配置的类型会显示在这里，点击即可添加第一张卡片。";
      head.append(b, small);
      addArea.appendChild(head);
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";
      for (const def of withoutBlocks) {
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "ke-block-add";
        addBtn.title = def.help;
        addBtn.textContent = `＋ ${def.label}`;
        addBtn.addEventListener("click", () => {
          const block = newBlock(def);
          (configDoc.blocks[def.type] ??= []).push(block);
          expandedBlocks.add(block);
          markDirty();
          renderActivePanel();
          refreshAll();
        });
        btnRow.appendChild(addBtn);
      }
      addArea.appendChild(btnRow);
      tabPanels.appendChild(addArea);
    }
    if (withBlocks.length === 0) {
      const hint = document.createElement("p");
      hint.className = "ke-hint";
      hint.textContent =
        "技能规则决定角色用什么技能打怪、何时给自己加 buff、何时买药。从上方「添加新规则」开始。";
      tabPanels.appendChild(hint);
    }
  }

  function renderBlockSection(def: BlockDef): void {
    const section = document.createElement("div");
    section.className = "ke-block-sec";
    const head = document.createElement("div");
    head.className = "ke-block-sec-head";
    const b = document.createElement("b");
    b.textContent = def.label;
    const small = document.createElement("small");
    small.textContent = def.help;
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ke-block-add";
    addBtn.textContent = "＋ 添加";
    addBtn.addEventListener("click", () => {
      const block = newBlock(def);
      (configDoc.blocks[def.type] ??= []).push(block);
      expandedBlocks.add(block);
      markDirty();
      renderActivePanel();
      refreshAll();
      const cards = tabPanels.querySelectorAll(".ke-block-card");
      cards[cards.length - 1]?.scrollIntoView({ block: "nearest" });
    });
    head.append(b, small, addBtn);
    section.appendChild(head);

    const list = document.createElement("div");
    list.className = "ke-block-list";
    (configDoc.blocks[def.type] ?? []).forEach((block) =>
      list.appendChild(renderBlockCard(def, block)),
    );
    section.appendChild(list);
    tabPanels.appendChild(section);
  }

  function blockSummary(def: BlockDef, block: BlockValue): string[] {
    const parts: string[] = [];
    if (block.selector) {
      const pool =
        def.selectorKind === "skill"
          ? (options?.skills ?? []).map((skill) => ({
              label: skillLabel(skill),
              value: String(skill.id),
            }))
          : itemOptions();
      parts.push(
        pool.find((o) => o.value === block.selector)?.label ?? block.selector,
      );
    }
    if (block.fields.monsters)
      parts.push(`仅对：${monsterNamesOf(block.fields.monsters)}`);
    for (const [key, value] of Object.entries(block.conditions)) {
      if (!value) continue;
      const known = Object.values(conditionKeysOf("self"))
        .concat(conditionKeysOf("monster"), conditionKeysOf("player"))
        .find((k) => k.key === key);
      parts.push(`${known?.label ?? key} ${value}`);
      if (parts.length >= 3) break;
    }
    return parts.slice(0, 3);
  }

  /** 新建 block 卡片：套用 schema 的预填字段/条件（如 buyAuto 默认指向普隆德拉道具商人）。 */
  function newBlock(def: BlockDef): BlockValue {
    return {
      selector: "",
      fields: { ...(def.defaults?.fields ?? {}) },
      conditions: { ...(def.defaults?.conditions ?? {}) },
    };
  }

  function renderBlockCard(def: BlockDef, block: BlockValue): HTMLElement {
    const card = document.createElement("div");
    const isOpen = expandedBlocks.has(block);
    card.className = `ke-block-card${isOpen ? " is-open" : ""}`;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "ke-block-head";
    head.setAttribute("aria-expanded", String(isOpen));
    const name = document.createElement("span");
    name.className = "ke-b-name";
    name.textContent = def.label;
    head.appendChild(name);
    for (const part of blockSummary(def, block)) {
      const chip = document.createElement("span");
      chip.className = "ke-chip";
      chip.textContent = part.length > 24 ? `${part.slice(0, 23)}…` : part;
      head.appendChild(chip);
    }
    const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chev.setAttribute("class", "ke-chev");
    chev.setAttribute("width", "14");
    chev.setAttribute("height", "14");
    chev.setAttribute("viewBox", "0 0 24 24");
    chev.setAttribute("fill", "none");
    chev.setAttribute("stroke", "currentColor");
    chev.setAttribute("stroke-width", "2");
    chev.innerHTML = '<path d="M6 9l6 6 6-6"/>';
    head.appendChild(chev);
    head.addEventListener("click", () => {
      const open = !card.classList.contains("is-open");
      card.classList.toggle("is-open", open);
      head.setAttribute("aria-expanded", String(open));
      if (open) expandedBlocks.add(block);
      else expandedBlocks.delete(block);
      const body = card.querySelector<HTMLElement>(".ke-block-body");
      if (body) body.hidden = !open;
    });
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "ke-block-body";
    body.hidden = !isOpen;

    const fields = document.createElement("div");
    fields.className = "ke-fields";
    fields.style.paddingBottom = "0";

    function renderFields(): void {
      fields.innerHTML = "";
      for (const fieldDef of def.fields) {
        // noSmartHeal 仅对治愈术（技能 ID 28）显示
        if (fieldDef.key === 'noSmartHeal' && block.selector !== '28') continue;
        fields.appendChild(renderBlockField(fieldDef, block));
      }
    }

    if (def.selectorKind !== "none") {
      const field = document.createElement("div");
      field.className = "ke-field";
      field.appendChild(
        helpTip(
          def.selectorKind === "skill" ? "技能" : "物品",
          "输入名称搜索选择；这是这条规则作用的技能或物品。",
        ),
      );
      const pool =
        def.selectorKind === "skill" ? skillOptions() : itemOptions();
      if (def.selectorKind === "skill" && block.selector) {
        const savedSkill = options?.skills.find(
          (skill) => String(skill.id) === block.selector,
        );
        if (
          savedSkill &&
          !pool.some((option) => option.value === block.selector)
        ) {
          pool.unshift({
            label: skillLabel(savedSkill),
            value: block.selector,
            group: "已保存技能",
          });
        }
      }
      const picker = createPicker(pool, block.selector, (value) => {
        block.selector = value;
        markDirty();
        updatePreview();
        const chips = card.querySelectorAll<HTMLElement>(
          ".ke-block-head .ke-chip",
        );
        if (chips.length > 0) {
          const label = pool.find((o) => o.value === value)?.label ?? "";
          chips[0]!.textContent = label;
          chips[0]!.hidden = !label;
        }
        renderFields();
      });
      field.appendChild(picker);
      body.appendChild(field);
    }

    renderFields();
    body.appendChild(fields);
    for (const group of def.conditions)
      body.appendChild(renderConditions(group, block));
    card.appendChild(body);
    return card;
  }

  function renderBlockField(
    fieldDef: BlockFieldDef,
    block: BlockValue,
  ): HTMLElement {
    const field = document.createElement("div");
    field.className = "ke-field";
    field.appendChild(helpTip(fieldDef.label, fieldDef.help));
    if (fieldDef.type === "monsters") {
      field.appendChild(
        createMonsterChipsEditor(
          block.fields[fieldDef.key] ?? "",
          (csv) => {
            if (csv === "") delete block.fields[fieldDef.key];
            else block.fields[fieldDef.key] = csv;
            markDirty();
            updatePreview();
          },
          fieldDef.key === "notMonsters"
            ? "未排除任何怪物"
            : "未指定，对全部怪物生效",
        ),
      );
      return field;
    }
    if (fieldDef.type === "enum") {
      field.appendChild(
        segEl(
          fieldDef.options ?? [],
          block.fields[fieldDef.key] ?? "",
          (value) => {
            block.fields[fieldDef.key] = value;
            markDirty();
            updatePreview();
          },
          "",
          true,
        ),
      );
      return field;
    }
    if (fieldDef.picker === "item") {
      field.appendChild(
        createPicker(
          itemOptions(),
          block.fields[fieldDef.key] ?? "",
          (value) => {
            block.fields[fieldDef.key] = value;
            markDirty();
            updatePreview();
          },
        ),
      );
      return field;
    }
    const input = document.createElement("input");
    input.type = fieldDef.type === "int" ? "number" : "text";
    input.inputMode = fieldDef.type === "int" ? "decimal" : "text";
    input.step = "any";
    input.placeholder = "未设置";
    input.value = block.fields[fieldDef.key] ?? "";
    input.addEventListener("input", () => {
      block.fields[fieldDef.key] = input.value;
      markDirty();
      updatePreview();
    });
    field.appendChild(input);
    return field;
  }

  function renderConditions(
    group: ConditionGroup,
    block: BlockValue,
  ): HTMLElement {
    const container = document.createElement("div");
    container.className = "ke-cond";
    const head = document.createElement("div");
    head.className = "ke-cond-head";
    const label = document.createElement("span");
    label.textContent = conditionGroupLabel(group);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ke-btn-ghost";
    addBtn.style.minHeight = "26px";
    addBtn.style.padding = "2px 10px";
    addBtn.textContent = "＋ 添加条件";
    head.append(label, addBtn);
    container.appendChild(head);

    const keys = conditionKeysOf(group);
    function addRow(initialKey: string): void {
      const row = document.createElement("div");
      row.className = "ke-cond-row";
      const keySelect = document.createElement("select");
      for (const key of keys) {
        const option = document.createElement("option");
        option.value = key.key;
        option.textContent = key.label;
        keySelect.appendChild(option);
      }
      keySelect.value = initialKey;
      const valueSlot = document.createElement("div");
      valueSlot.style.minWidth = "0";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "ke-icon-btn";
      removeBtn.title = "删除条件";
      removeBtn.textContent = "×";

      let currentKey = initialKey;
      function setValue(value: string): void {
        if (value === "") delete block.conditions[currentKey];
        else block.conditions[currentKey] = value;
        markDirty();
        updatePreview();
      }
      function renderValue(): void {
        valueSlot.innerHTML = "";
        const def = keys.find((k) => k.key === currentKey);
        keySelect.title = def?.help ?? "";
        const currentValue = block.conditions[currentKey] ?? "";
        const widget = def?.widget ?? "text";
        if (widget === "status") {
          valueSlot.appendChild(
            createPicker(statusOptions(), currentValue, setValue),
          );
        } else if (widget === "comparisonPercent" || widget === "comparisonNum") {
          valueSlot.appendChild(
            createComparisonEditor(
              currentValue,
              setValue,
              widget === "comparisonPercent",
            ),
          );
        } else if (widget === "bool") {
          valueSlot.appendChild(
            segEl(
              [
                { value: "0", label: "关闭" },
                { value: "1", label: "开启" },
              ],
              currentValue,
              setValue,
              "",
              true,
            ),
          );
        } else if (widget === "monsters") {
          valueSlot.appendChild(
            createMonsterChipsEditor(
              currentValue,
              setValue,
              currentKey === "notMonsters" ? "未排除任何怪物" : "未指定怪物",
            ),
          );
        } else if (widget === "itemAmount") {
          valueSlot.appendChild(
            createItemAmountEditor(currentValue, setValue, itemNameOptions()),
          );
        } else if (widget === "itemAmountId") {
          valueSlot.appendChild(
            createItemAmountEditor(currentValue, setValue, itemOptions()),
          );
        } else if (widget === "map") {
          valueSlot.appendChild(
            createPicker(mapOptions(), currentValue, setValue),
          );
        } else if (widget === "job") {
          valueSlot.appendChild(
            createPicker(jobOptions(), currentValue, setValue),
          );
        } else if (widget === "skill") {
          valueSlot.appendChild(
            createPicker(skillOptions(), currentValue, setValue),
          );
        } else if (widget === "enum") {
          valueSlot.appendChild(
            segEl(def?.options ?? [], currentValue, setValue, "", true),
          );
        } else {
          const input = document.createElement("input");
          input.placeholder = def?.hint ?? "值";
          input.value = currentValue;
          input.addEventListener("input", () => setValue(input.value));
          valueSlot.appendChild(input);
        }
      }
      keySelect.addEventListener("change", () => {
        delete block.conditions[currentKey];
        currentKey = keySelect.value;
        renderValue();
        markDirty();
        updatePreview();
      });
      removeBtn.addEventListener("click", () => {
        delete block.conditions[currentKey];
        row.remove();
        markDirty();
        updatePreview();
      });
      row.append(keySelect, valueSlot, removeBtn);
      renderValue();
      container.appendChild(row);
    }
    addBtn.addEventListener("click", () => addRow(keys[0]?.key ?? ""));
    for (const [key] of Object.entries(block.conditions)) {
      if (keys.some((k) => k.key === key)) addRow(key);
    }
    return container;
  }

  // —— 规则表分区（怪物/拾取/物品/超时） ——

  function renderControlsTab(entry: NavEntry): void {
    const schema = CONTROL_SCHEMAS.find((s) => s.file === entry.file)!;
    const rows = (controlDoc[schema.file] ??= []);

    const tabHint = CONTROL_TAB_HINTS[schema.file];
    if (tabHint) {
      const hintEl = document.createElement("p");
      hintEl.className = "ke-hint";
      hintEl.style.margin = "4px 0 0";
      hintEl.textContent = tabHint;
      tabPanels.appendChild(hintEl);
    }

    const list = document.createElement("div");
    list.className = "ke-rule-list";
    tabPanels.appendChild(list);

    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ke-hint";
      empty.textContent =
        schema.file === "timeouts.txt"
          ? "还没有超时项。大多数情况下保持默认即可，只有遇到动作太慢/太快时才需要调整。"
          : "还没有规则。不配置时 KE 会按默认行为处理所有对象。";
      tabPanels.appendChild(empty);
    } else {
      rows.forEach((row, index) =>
        list.appendChild(renderRuleRow(schema, row, index)),
      );
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ke-block-add";
    addBtn.style.marginTop = "12px";
    addBtn.textContent =
      schema.file === "timeouts.txt"
        ? "＋ 添加超时项"
        : `＋ 添加${CONTROL_LABELS[schema.file] ?? "规则"}`;
    addBtn.addEventListener("click", () => {
      rows.push({ name: "", values: {} });
      markDirty();
      renderActivePanel();
      updateNavCounts();
      updateSideStats();
      const pickers = tabPanels.querySelectorAll<HTMLInputElement>(
        ".ke-rule-row:last-child input",
      );
      pickers[pickers.length - 1]?.focus();
    });
    tabPanels.appendChild(addBtn);
  }

  function ruleNameField(schema: ControlSchema, row: ControlRow): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ke-rule-name";
    const name = document.createElement("div");
    name.className = "ke-rn";
    wrap.appendChild(name);
    const syncName = (): void => {
      if (schema.nameKind === "monster") {
        const found = options?.monsters.find((m) => String(m.id) === row.name);
        name.textContent = found ? found.name : row.name || "（未选择）";
      } else if (schema.nameKind === "item") {
        const found = options?.items.find((i) => String(i.id) === row.name);
        name.textContent = found ? found.name : row.name || "（未选择）";
      } else {
        name.textContent = row.name || "（未选择）";
      }
    };
    syncName();
    if (schema.nameKind === "timeout") {
      const select = document.createElement("select");
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "选择超时项…";
      select.appendChild(empty);
      for (const timeout of options?.timeouts ?? []) {
        const option = document.createElement("option");
        option.value = timeout.key;
        option.textContent = timeout.key;
        select.appendChild(option);
      }
      select.value = row.name;
      select.addEventListener("change", () => {
        row.name = select.value;
        syncName();
        markDirty();
        renderActivePanel();
      });
      const selectWrap = document.createElement("div");
      selectWrap.appendChild(select);
      wrap.appendChild(selectWrap);
    } else {
      const isMonster = schema.nameKind === "monster";
      const base = isMonster ? monsterOptions() : itemOptions();
      const allOption: PickerOption = {
        label: `all（${isMonster ? "所有怪物" : "所有物品"}兜底）`,
        value: "all",
      };
      const picker = createPicker(
        [allOption, ...base],
        row.name,
        (value) => {
          row.name = value;
          syncName();
          markDirty();
          updateSideStats();
          updatePreview();
        },
        false,
        isMonster ? "搜索怪物，或选 all 兜底…" : "搜索物品，或选 all 兜底…",
      );
      wrap.appendChild(picker);
    }
    return wrap;
  }

  function intControl(
    column: ControlColumn,
    values: Record<string, string>,
  ): HTMLElement {
    const line = document.createElement("label");
    line.className = "ke-int-line";
    const text = document.createElement("span");
    text.textContent = column.label;
    line.appendChild(text);
    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "decimal";
    input.step = "any";
    input.title = column.help;
    input.placeholder = column.placeholder ?? "—";
    input.value = values[column.key] ?? "";
    input.addEventListener("input", () => {
      values[column.key] = input.value;
      markDirty();
      updatePreview();
    });
    line.appendChild(input);
    return line;
  }

  function enumControl(
    column: ControlColumn,
    values: Record<string, string>,
    onChange: () => void,
  ): HTMLElement {
    const options_ = column.options ?? [];
    // 拾取 flag：-1 与 0 语义相同（不拾取），合并为一个分段展示，点击写入 0。
    const segOptions: SegOption[] = options_
      .filter((o) => !(column.key === "flag" && o.value === "-1"))
      .map((o) => ({
        value: o.value === "-1" && column.key === "flag" ? "0" : o.value,
        label: o.label,
        hint: o.hint ?? column.help,
      }));
    const raw = values[column.key] ?? "";
    const current = column.key === "flag" && raw === "-1" ? "0" : raw;
    return segEl(
      segOptions,
      current,
      (value) => {
        values[column.key] = value;
        markDirty();
        updatePreview();
        onChange();
      },
      "mini",
    );
  }

  /** 横排「标签 + 是/否迷你分段」，用于怪物规则行内的布尔开关。 */
  function labeledEnumToggle(
    column: ControlColumn,
    values: Record<string, string>,
  ): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "ke-tgl";
    const label = document.createElement("span");
    label.className = "ke-tgl-label";
    label.textContent = column.label;
    label.title = column.help;
    wrap.appendChild(label);
    wrap.appendChild(enumControl(column, values, () => {}));
    return wrap;
  }

  /** 遇怪传送（teleport_auto）：0 不传 / 1 见到就飞 / 2 被打才飞 / 负数=怪物接近 N 格就飞。 */
  function teleportControl(values: Record<string, string>): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "ke-tgl ke-tgl-box";
    const label = document.createElement("span");
    label.className = "ke-tgl-label";
    label.textContent = "遇怪传送";
    wrap.appendChild(label);

    const raw = values.teleport_auto ?? "0";
    const isDist = raw.startsWith("-");
    const distInput = document.createElement("input");
    distInput.type = "number";
    distInput.inputMode = "decimal";
    distInput.className = "ke-input-sm";
    distInput.placeholder = "距离";
    distInput.title =
      "怪物接近这个格数就瞬移（写入负数，例如 6 表示距 6 格就飞）。";
    distInput.value = isDist ? raw.slice(1) : "";

    const warn = document.createElement("span");
    warn.className = "ke-dist-warn";
    warn.hidden = true;
    warn.textContent =
      "屏幕内一般只有 10–15 格：距离填得比 15 大，效果约等于「见到就飞」。建议填 1–10。";
    const syncWarn = (): void => {
      const num = Number(distInput.value);
      warn.hidden =
        distInput.value.trim() === "" || !Number.isFinite(num) || num <= 15;
    };

    const segOptions: SegOption[] = [
      { value: "0", label: "不传送", hint: "遇到也不躲。" },
      {
        value: "1",
        label: "见到就飞",
        hint: "这种怪一出现在屏幕上就立刻瞬移。",
      },
      { value: "2", label: "被打才飞", hint: "要被它攻击命中时才瞬移。" },
      {
        value: "dist",
        label: "按距离",
        hint: "怪物接近指定格数就瞬移（写入负数）。",
      },
    ];
    const seg = segEl(
      segOptions,
      isDist ? "dist" : raw,
      (value) => {
        if (value === "dist") {
          values.teleport_auto =
            distInput.value.trim() === "" ? "-1" : `-${distInput.value}`;
          distInput.hidden = false;
          syncWarn();
        } else {
          values.teleport_auto = value;
          distInput.hidden = true;
          distInput.value = "";
          warn.hidden = true;
        }
        markDirty();
        updatePreview();
      },
      "mini",
    );
    distInput.hidden = !isDist;
    distInput.addEventListener("input", () => {
      const num = Math.abs(Number(distInput.value));
      values.teleport_auto =
        distInput.value.trim() === "" || !Number.isFinite(num) || num === 0
          ? "-1"
          : `-${num}`;
      syncWarn();
      markDirty();
      updatePreview();
    });
    wrap.appendChild(seg);
    wrap.appendChild(distInput);
    wrap.appendChild(warn);
    return wrap;
  }

  /** 物品规则网格单元：label（带帮助气泡）+ 数字输入或迷你分段。 */
  function controlCell(
    column: ControlColumn,
    values: Record<string, string>,
  ): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "ke-field";
    cell.appendChild(helpTip(column.label, column.help));
    if (column.type === "enum") {
      cell.appendChild(enumControl(column, values, () => {}));
      return cell;
    }
    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "decimal";
    input.step = "any";
    input.title = column.help;
    input.placeholder = column.placeholder ?? "—";
    input.value = values[column.key] ?? "";
    input.addEventListener("input", () => {
      values[column.key] = input.value;
      markDirty();
      updatePreview();
    });
    cell.appendChild(input);
    return cell;
  }

  function renderRuleRow(
    schema: ControlSchema,
    row: ControlRow,
    index: number,
  ): HTMLElement {
    const card = document.createElement("div");
    card.className = `ke-rule-row${row.name === "all" ? " is-fallback" : ""}`;
    card.appendChild(ruleNameField(schema, row));

    const main = document.createElement("div");
    main.className = "ke-rule-main";
    card.appendChild(main);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ke-btn-danger ke-rule-remove";
    removeBtn.textContent = "删除";
    removeBtn.addEventListener("click", () => {
      controlDoc[schema.file] = (controlDoc[schema.file] ?? []).filter(
        (_, i) => i !== index,
      );
      markDirty();
      renderActivePanel();
      updateNavCounts();
      updateSideStats();
    });
    card.appendChild(removeBtn);

    if (schema.file === "mon_control.txt") {
      main.appendChild(
        enumControl(schema.columns[0]!, row.values, updateSideStats),
      );
      main.appendChild(teleportControl(row.values));
      for (const column of schema.columns) {
        if (
          column.key === "teleport_search" ||
          column.key === "skillcancel_auto"
        ) {
          main.appendChild(labeledEnumToggle(column, row.values));
        }
      }
      const adv = document.createElement("details");
      adv.className = "ke-adv";
      adv.style.flexBasis = "100%";
      const summary = document.createElement("summary");
      summary.textContent = "高级条件（自身等级 / HP / 计怪权重）";
      adv.appendChild(summary);
      const grid = document.createElement("div");
      grid.className = "ke-adv-fields";
      const advKeys = new Set([
        "attack_lvl",
        "attack_jlvl",
        "attack_hp",
        "attack_sp",
        "weight",
      ]);
      for (const column of schema.columns) {
        if (advKeys.has(column.key))
          grid.appendChild(intControl(column, row.values));
      }
      adv.appendChild(grid);
      main.appendChild(adv);
      const note = document.createElement("p");
      note.className = "ke-rule-note";
      note.textContent =
        row.name === "all" ? "未单独配置的怪物都会命中这条兜底规则。" : "";
      if (note.textContent) main.appendChild(note);
      return card;
    }

    if (schema.file === "pickupitems.txt") {
      main.appendChild(
        enumControl(schema.columns[0]!, row.values, updateSideStats),
      );
      if (row.name === "all") {
        const note = document.createElement("p");
        note.className = "ke-rule-note";
        note.textContent = "未单独配置的物品都会按这条兜底规则处理。";
        main.appendChild(note);
      }
      return card;
    }

    if (schema.file === "items_control.txt") {
      const grid = document.createElement("div");
      grid.className = "ke-rule-grid";
      for (const column of schema.columns)
        grid.appendChild(controlCell(column, row.values));
      main.appendChild(grid);
      return card;
    }

    // timeouts
    const info = options?.timeouts.find((t) => t.key === row.name);
    if (info?.desc) {
      const note = document.createElement("p");
      note.className = "ke-rule-note";
      note.textContent = `${info.desc}（建议 ${info.range}）`;
      main.appendChild(note);
    }
    const valueCol = schema.columns[0]!;
    const line = document.createElement("label");
    line.className = "ke-int-line";
    const text = document.createElement("span");
    text.textContent = "秒";
    line.appendChild(text);
    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "decimal";
    input.step = "any";
    input.style.width = "90px";
    input.placeholder = info?.value ?? "—";
    input.title = valueCol.help;
    input.value = row.values[valueCol.key] ?? "";
    input.addEventListener("input", () => {
      row.values[valueCol.key] = input.value;
      markDirty();
      updatePreview();
    });
    line.appendChild(input);
    main.appendChild(line);
    return card;
  }

  // —— 数据流 ——

  function hideForm(): void {
    editor.hidden = true;
    editingId = null;
    clearDirty();
  }

  /** 按 KE 默认值（+ LastRO 覆盖值）填满 timeouts 规则。 */
  function fillTimeoutRows(): void {
    const rows = controlDoc["timeouts.txt"] ?? (controlDoc["timeouts.txt"] = []);
    for (const timeout of options?.timeouts ?? []) {
      rows.push({
        name: timeout.key,
        values: {
          value: TIMEOUT_DEFAULT_OVERRIDES[timeout.key] ?? timeout.value,
        },
      });
    }
  }

  async function openEditor(id: number | null): Promise<void> {
    formError.hidden = true;
    editor.hidden = false;
    editingId = id;
    showAllSkills = false;
    activeTab = "route";
    editorTitle.textContent = id === null ? "新建方案" : "编辑方案";
    if (id === null) {
      nameInput.value = "";
      configDoc = defaultDoc();
      controlDoc = defaultControlDoc();
      fillTimeoutRows();
      clearDirty();
      renderNav();
      renderActivePanel();
      refreshAll();
      nameInput.focus();
      return;
    }
    status.textContent = "正在加载方案…";
    try {
      const profile = await keFetch<ProfileDetail>(`/api/v1/ke/profiles/${id}`);
      nameInput.value = profile.name;
      configDoc = parseConfig(profile.config_text);
      controlDoc = emptyControlDoc();
      const profileText: Record<string, string> = {
        "mon_control.txt": profile.mon_control ?? "",
        "pickupitems.txt": profile.pickupitems ?? "",
        "items_control.txt": profile.items_control ?? "",
        "timeouts.txt": profile.timeouts ?? "",
      };
      for (const schema of CONTROL_SCHEMAS)
        controlDoc[schema.file] = parseControl(
          schema,
          profileText[schema.file] ?? "",
        );
      // 历史 profile 的规则文件可能为空/缺 all 兜底，加载时即补齐，保证再保存不落 NULL。
      ensureAllFallback(controlDoc);
      if ((controlDoc["timeouts.txt"] ?? []).length === 0) fillTimeoutRows();
      clearDirty();
      renderNav();
      renderActivePanel();
      refreshAll();
      status.textContent = "";
    } catch (error) {
      formError.hidden = false;
      formError.textContent =
        error instanceof Error ? error.message : "加载失败";
      status.textContent = "";
    }
  }

  async function reloadProfiles(): Promise<void> {
    const character = selectedCharacter();
    if (!character) {
      profilesHead.hidden = true;
      profileList.hidden = true;
      profileList.innerHTML = "";
      return;
    }
    const query = `aid=${character.aid}&cid=${character.cid}&nid=${character.nid}`;
    const body = await keFetch<{ profiles: ProfileSummary[] }>(
      `/api/v1/ke/profiles?${query}`,
    );
    renderProfiles(body.profiles);
  }

  async function activateProfile(id: number): Promise<void> {
    try {
      await keFetch<void>(`/api/v1/ke/profiles/${id}/activate`, {
        method: "POST",
      });
      await reloadProfiles();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "激活失败";
    }
  }

  async function deleteProfile(id: number): Promise<void> {
    if (!window.confirm("确定删除该方案？删除后无法恢复。")) return;
    try {
      await keFetch<void>(`/api/v1/ke/profiles/${id}`, { method: "DELETE" });
      await reloadProfiles();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "删除失败";
    }
  }

  async function saveProfile(): Promise<void> {
    const character = selectedCharacter();
    if (!character) return;
    if (nameInput.value.trim() === "") {
      formError.hidden = false;
      formError.textContent = "请先填写方案名称，方便以后区分不同场景。";
      nameInput.focus();
      return;
    }
    formError.hidden = true;
    // 保存前校验：格式/取值错误的配置项逐条列出并阻止保存，避免写坏 config.txt。
    const configErrors = validateConfigDoc(configDoc);
    if (configErrors.length > 0) {
      formError.hidden = false;
      formError.textContent =
        `发现 ${configErrors.length} 处配置问题，请修正后再保存：\n` +
        configErrors.map((message, index) => `${index + 1}. ${message}`).join("\n");
      return;
    }
    // 保存前兜底：所有 control 文件必须生成，mon/pickup/items 必须带 all 兜底行，绝不落 NULL。
    ensureAllFallback(controlDoc);
    if ((controlDoc["timeouts.txt"] ?? []).length === 0) fillTimeoutRows();
    const controlText = (file: string): string => {
      const schema = CONTROL_SCHEMAS.find((s) => s.file === file)!;
      const text = serializeControl(schema, controlDoc[file] ?? []).trim();
      if (text !== "" || file === "timeouts.txt") return text;
      return serializeControl(schema, allFallbackRows(file)).trim();
    };
    const missing: string[] = [];
    const ruleFiles = [
      ["mon_control.txt", "怪物规则"],
      ["pickupitems.txt", "拾取物品"],
      ["items_control.txt", "物品规则"],
    ] as const;
    for (const [file, label] of ruleFiles) {
      const hasAll = controlText(file)
        .split("\n")
        .some((line) => line.trim().split(/\s+/u)[0] === "all");
      if (!hasAll) missing.push(label);
    }
    if (controlText("timeouts.txt") === "") missing.push("超时配置");
    if (missing.length > 0) {
      formError.hidden = false;
      formError.textContent = `以下配置文件未能生成：${missing.join(
        "、",
      )}，请刷新页面后重试。`;
      return;
    }
    const values = {
      name: nameInput.value,
      config_text: serializeConfig(configDoc),
      mon_control: controlText("mon_control.txt"),
      pickupitems: controlText("pickupitems.txt"),
      items_control: controlText("items_control.txt"),
      timeouts: controlText("timeouts.txt"),
    };
    try {
      if (editingId === null) {
        await keFetch<{ id: number }>("/api/v1/ke/profiles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            aid: character.aid,
            cid: character.cid,
            nid: character.nid,
            ...values,
          }),
        });
      } else {
        await keFetch<void>(`/api/v1/ke/profiles/${editingId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values),
        });
      }
      hideForm();
      await reloadProfiles();
    } catch (error) {
      formError.hidden = false;
      formError.textContent =
        error instanceof Error ? error.message : "保存失败";
    }
  }

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-action]"),
  )) {
    if (button.dataset.action === "save")
      button.addEventListener("click", () => void saveProfile());
    else if (button.dataset.action === "cancel")
      button.addEventListener("click", () => {
        if (confirmDiscard()) hideForm();
      });
  }
  previewToggle.addEventListener("click", () => {
    previewCollapsed = !previewCollapsed;
    preview.hidden = previewCollapsed;
    previewToggle.querySelector("span")!.textContent = previewCollapsed
      ? "展开 ▸"
      : "收起 ▾";
  });
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveProfile();
    }
  });
  nameInput.addEventListener("input", () => {
    if (!nameInput.value.trim() && !dirty) return;
    markDirty();
  });

  charSelect.addEventListener("change", () => {
    if (!confirmDiscard()) {
      charSelect.value = selectedKey ?? "";
      return;
    }
    selectedKey = charSelect.value;
    const character = selectedCharacter();
    selectedJobId = character?.job_id ?? null;
    hideForm();
    renderCharCard();
    void reloadProfiles();
  });

  // —— 初始化 ——

  async function init(): Promise<void> {
    const demo = new URLSearchParams(window.location.search).has("demo");
    options = await keFetch<KeOptions>("/ke/options.json").catch(() => null);
    if (options) {
      mapsList.innerHTML = options.maps
        .map((m) => `<option value="${m.code}"></option>`)
        .join("");
    }
    if (demo) {
      root.querySelector<HTMLElement>("#ke-demo-chip")!.hidden = false;
      characters = [
        {
          aid: 1000001,
          cid: 2000002,
          nid: 3000003,
          char_name: "波利猎人",
          job_id: 4016,
          map_name: "prt_fild08",
          last_seen_at: Date.now() - 3 * 60000,
        },
      ];
      fillCharacterSelect();
      selectedKey = charSelect.value;
      selectedJobId = characters[0]!.job_id ?? null;
      status.textContent = "演示模式：未连接后端，改动不会保存。";
      renderCharCard();
      renderProfiles([]);
      void openEditor(null);
      return;
    }
    try {
      const charactersBody = await keFetch<{ characters: KeCharacter[] }>(
        "/api/v1/ke/characters",
      );
      characters = charactersBody.characters;
      if (characters.length === 0) {
        status.textContent =
          "暂无已绑定角色。请先用 KoreEngine 登录角色，然后刷新本页。";
        return;
      }
      fillCharacterSelect();
      selectedKey = charSelect.value;
      selectedJobId = characters[0]!.job_id ?? null;
      status.textContent = "";
      renderCharCard();
      await reloadProfiles();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("AUTH:")) {
        status.textContent = "请先登录账号，再回到本页配置挂机方案。";
      } else {
        status.textContent =
          error instanceof Error ? error.message : "加载失败";
      }
    }
  }

  void init();
}
