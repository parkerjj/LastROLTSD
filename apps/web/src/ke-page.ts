// KoreEngine 配置工作台：角色卡 + Profile 卡片网格 + 三栏编辑器（分区导航 / 表单 / 状态与预览）。
// 设计要点：枚举开关用分段按钮；字段带 ? 帮助提示（hover + 键盘可达）；技能规则按类型分节、卡片可折叠；
// 规则表行化、低频列收进「高级」；未保存更改在编辑头与右栏双处提示，切换前需确认。仅通过 /ke/my 访问，站内不挂入口。

import { openWorldmapPicker } from "./ke-worldmap";
import {
  BLOCK_DEFS,
  CONFIG_SCALARS,
  conditionGroupLabel,
  conditionKeysOf,
  defaultDoc,
  emptyDoc,
  normalizeFullWidth,
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
  newControlRow,
  parseControl,
  serializeControl,
  validateControlDoc,
  type ControlColumn,
  type ControlRow,
  type ControlSchema,
} from "./ke-controls";
import { createProfileSharing } from "./profile-sharing";
import type { ProfileSharingMetadata } from "../../worker/src/ke/shared-profile-types";
import { isLocalDemoMode } from "./demo-mode";
import { mountSiteNav, siteNavMarkup } from "./nav";

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
  sharing?: ProfileSharingMetadata | null;
}

interface ProfileDetail extends ProfileSummary {
  aid: number;
  cid: number;
  nid: number;
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
interface MapNamesFile {
  names: Record<string, string>;
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

// RO 官方 renewalparty 职业图标映射（从客户端 icon_jobs_{job_id}.bmp 转 PNG）
// 高阶二转复用一转图标
const PTICON_MAP_URL = "/ui/pticons/pticon-map.json";
let pticonMap: Record<string, string> | null = null;
async function loadPticonMap(): Promise<Record<string, string>> {
  if (pticonMap) return pticonMap;
  try {
    const r = await fetch(PTICON_MAP_URL, { cache: "force-cache" });
    if (r.ok) pticonMap = await r.json();
  } catch {
    /* offline / asset unavailable — fall through to text fallback */
  }
  return pticonMap ?? {};
}
function iconUrl(jobId: number | null): string | null {
  if (jobId === null || jobId === undefined || !pticonMap) return null;
  // 精确匹配 job_id（基础/一转/扩展 23 个独立图标）
  const exact = pticonMap[String(jobId)];
  if (exact) return exact;
  // 高阶二转（161-181）→ 同系列一转图标
  const HIGH_TO_BASE: Record<string, string> = {
    "161": "0", "162": "1", "163": "2", "164": "3", "165": "4",
    "166": "5", "167": "6", "168": "7", "169": "8", "170": "9",
    "171": "10", "172": "11", "173": "12", "174": "13", "175": "14",
    "176": "15", "177": "16", "178": "17", "179": "18", "180": "19",
    "181": "20",
  };
  const base = HIGH_TO_BASE[String(jobId)];
  return base ? pticonMap[base] ?? null : null;
}

// RO 客户端把纯洋红 #ff00ff 当作透明色；网页里先抠成 alpha=0 再显示。
const PTICON_CLEAN = new Map<string, string>();
const PTICON_PENDING = new Map<string, Promise<string | null>>();

function chromaKeyIcon(doc: Document, src: string): Promise<string | null> {
  const win = doc.defaultView;
  if (!win) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      win.clearTimeout(timer);
      resolve(value);
    };
    timer = win.setTimeout(() => finish(null), 3000);
    const img = new win.Image();
    img.onload = () => {
      try {
        const canvas = doc.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx || canvas.width === 0 || canvas.height === 0) {
          finish(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = pixels.data;
        // 图标是像素画，透明色为精确的 (255, 0, 255)，无需近似容差。
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 255) {
            data[i + 3] = 0;
          }
        }
        ctx.putImageData(pixels, 0, 0);
        finish(canvas.toDataURL("image/png"));
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = src;
  });
}

/** 渲染角色列表前先抠色，之后 iconSrc 可以同步取到透明图标。 */
async function prewarmPticons(doc: Document, jobIds: Array<number | null>): Promise<void> {
  await loadPticonMap();
  await Promise.all(
    jobIds.map(async (jobId) => {
      const src = iconUrl(jobId);
      if (!src || PTICON_CLEAN.has(src)) return;
      let pending = PTICON_PENDING.get(src);
      if (!pending) {
        pending = chromaKeyIcon(doc, src).then((clean) => {
          if (clean) PTICON_CLEAN.set(src, clean);
          return clean;
        });
        PTICON_PENDING.set(src, pending);
      }
      await pending;
    }),
  );
}

/** 已抠色的图标地址；处理失败时退回原图，避免图标空白。 */
function iconSrc(jobId: number | null): string | null {
  const src = iconUrl(jobId);
  return src ? PTICON_CLEAN.get(src) ?? src : null;
}

/** demo 角色：模拟真实账号绑定 20-30 个角色的情况（仅第一个角色带方案）。 */
const DEMO_CHARACTER_NAMES: ReadonlyArray<readonly [string, number, string]> = [
  ["波利猎人", 11, "pay_fild08"],
  ["初心者小明", 0, "prontera"],
  ["剑士阿强", 1, "prt_fild05"],
  ["魔法师露娜", 2, "gef_fild02"],
  ["弓箭手小羽", 3, "pay_fild01"],
  ["服侍小祈", 4, "prt_fild08"],
  ["商人金币", 5, "moc_fild12"],
  ["盗贼夜影", 6, "moc_fild17"],
  ["骑士亚瑟", 7, "prt_fild05"],
  ["牧师艾莉", 8, "pay_fild02"],
  ["巫师墨言", 9, "gef_fild07"],
  ["铁匠铁锤", 10, "gef_fild02"],
  ["刺客暗刃", 12, "moc_fild17"],
  ["骑乘骑士风驰", 13, "prt_fild05"],
  ["十字军圣光", 14, "prt_fild08"],
  ["武僧拳心", 15, "pay_fild01"],
  ["贤者星尘", 16, "gef_fild07"],
  ["流氓狡黠", 17, "moc_fild12"],
  ["炼金术士瓶瓶", 18, "cmd_fild02"],
  ["吟游诗人弦歌", 19, "pay_fild08"],
  ["舞娘旋舞", 20, "pay_fild02"],
  ["超级初心者小新", 23, "prontera"],
  ["神枪手火铳", 24, "moc_fild17"],
  ["忍者疾风", 25, "cmd_fild02"],
  ["骑士领主苍岚", 4008, "prt_fild05"],
  ["神射手鹰眼", 4012, "pay_fild08"],
  ["武术宗师铁拳", 4016, "prt_fild08"],
  ["符文骑士龙魂", 4054, "gef_fild07"],
  ["游侠林风", 4056, "pay_fild01"],
  ["大主教慈光", 4057, "pay_fild02"],
];

function buildDemoCharacters(): KeCharacter[] {
  const now = Date.now();
  return DEMO_CHARACTER_NAMES.map(([char_name, job_id, map_name], index) => ({
    aid: 1000001,
    cid: 2000001 + index,
    nid: 3000001 + index,
    char_name,
    job_id,
    map_name,
    last_seen_at: now - (index === 0 ? 3 : index * 37 + 5) * 60_000,
  }));
}

/** demo：给波利猎人准备 3 套已写好的方案，其余角色保持「没有方案」的空状态。 */
function buildDemoProfiles(options: KeOptions | null): ProfileDetail[] {
  const control = defaultControlDoc();
  control["timeouts.txt"] = (options?.timeouts ?? []).map((timeout) => ({
    name: timeout.key,
    values: { value: TIMEOUT_DEFAULT_OVERRIDES[timeout.key] ?? timeout.value },
  }));
  const controlText = (file: string): string => {
    const schema = CONTROL_SCHEMAS.find((s) => s.file === file)!;
    return serializeControl(schema, control[file] ?? []).trim();
  };
  const files = {
    mon_control: controlText("mon_control.txt"),
    pickupitems: controlText("pickupitems.txt"),
    items_control: controlText("items_control.txt"),
    timeouts: controlText("timeouts.txt"),
  };
  const designs: Array<{
    name: string;
    lockMap: string;
    saveMap: string;
    active: boolean;
  }> = [
    { name: "斐扬打波利", lockMap: "pay_fild08", saveMap: "payon", active: true },
    { name: "波利岛清怪", lockMap: "pay_fild01", saveMap: "payon", active: false },
    { name: "北门蹲点捡卡", lockMap: "prt_fild08", saveMap: "prontera", active: false },
  ];
  return designs.map((design, index) => {
    const doc = defaultDoc();
    doc.scalars.lockMap = design.lockMap;
    doc.scalars.saveMap = design.saveMap;
    return {
      id: index + 1,
      aid: 1000001,
      cid: 2000001,
      nid: 3000001,
      name: design.name,
      is_active: design.active,
      sharing: null,
      config_text: serializeConfig(doc),
      ...files,
    };
  });
}

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
    groups: ["修理", "商店仓库", "NPC 对话"],
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
    blockTypes: ["equipAuto", "autoSwitch"],
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

/** 规则表分区顶部的白话说明（依据 KE 配置文档）。 */
const CONTROL_TAB_HINTS: Record<string, string> = {
  "mon_control.txt": [
    "优先级（从高到低）：精确怪物名 → class id 数字 → 通配符 → all_mvp / all_miniboss → all。",
    "通配符：* 匹配任意长度（可空），? 匹配恰好一个字符，中文可用，如「兽人*」「Por*g」「红?药水」；多条通配符同时命中时，取文件里靠前的一条。",
    "all_mvp 匹配所有 MVP，all_miniboss 匹配所有小 Boss（依据进场包 isBoss 标志位，MVP 小弟无标志位无法区分，需单独列）。两者互不回落：MVP 只看 all_mvp、小 Boss 只看 all_miniboss，都没写时落到 all。",
    "「仅反击」＝平时不打、被打才还手；「打坐也攻击」＝视作主动怪，坐下回血时也会起身追打；「遇怪传送」可选见到就飞、被打才飞，或按距离飞。",
  ].join("\n"),
  "pickupitems.txt": [
    "优先级与通配符规则同怪物规则：精确物品名 → item id → 通配符 → all。通配符示例：「红*药」「*药草」「?色药水」；多条通配符同时命中时，文件里靠前的优先。",
    "「优先拾取」＝物品一出现就马上去捡；「拾取」＝路过时顺手捡；「不拾取」＝完全无视（写入 0）；「丢弃」＝不捡并让物品消失（写入 -1）。",
  ].join("\n"),
  "items_control.txt": [
    "优先级与通配符规则同怪物规则：精确物品名 → item id → 通配符 → all。通配符示例：「红*药」「*药草」「?色药水」；多条通配符同时命中时，文件里靠前的优先。",
    "工作方式：身上数量多于「身上保留」→ 多余的自动存仓 / 出售 / 放进推车；少于它 → 自动从推车补回。同时开启存仓和出售时先存仓（仓库满才卖）。",
  ].join("\n"),
};

// 下拉列表最多渲染的条目数（超过时底部提示用户直接输入文字过滤）。
const PICKER_LIMIT = 100;

/** block 类分区（技能规则 / 物品使用 / 自动购买 / 自动取物 / 自动换装）顶部的简易教程。 */
const BLOCK_TAB_HINTS: Record<string, string> = {
  skills: [
    "每个类型可以添加多张规则卡片。KE 按从上到下顺序逐条检查：第一张条件全部满足的卡片会被执行，后面的同类型卡片不再检查——所以请把「更优先」的卡片放在上面（卡片右上角可上下移动/拖拽排序）。",
    "「攻击技能槽」决定打怪用什么技能（优先级高于普攻）；「自身技能」是给自己加 buff / 治疗；「队伍技能」是给队友施放。",
  ].join("\n"),
  item_use:
    "满足条件时自动使用消耗品（如 HP 低于百分比喝药水）。KE 按从上到下顺序逐条检查，第一张条件满足的卡片优先执行——优先级高的规则请放上面（卡片右上角可排序）。",
  buy_auto:
    "身上数量低于设定值时自动去 NPC 购买补给。KE 按从上到下顺序逐条检查，第一张条件满足的卡片优先执行（卡片右上角可排序）。",
  get_auto:
    "身上数量不足时自动从仓库取补给。KE 按从上到下顺序逐条检查，第一张条件满足的卡片优先执行（卡片右上角可排序）。",
  equip_auto:
    "满足自身/怪物条件时自动切换装备。KE 按从上到下顺序逐条检查，第一张条件满足的卡片优先执行——专用套装放上面、通用兜底放下面（卡片右上角可排序）。",
};

// —— 地图预设（/ke/map-mobs.json，由 scripts/build-ke-map-mobs.mjs 从进阶客户端提取） ——

/** 单张地图的预设数据：mobs=该图全部怪物 ID，drops=所有怪物常规掉落物 ID 并集（不含 MVP 奖励）。 */
interface MapMobsEntry {
  mobs: number[];
  drops: number[];
}

interface MapMobsData {
  maps: Record<string, MapMobsEntry>;
}

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
  const demo = isLocalDemoMode(root.ownerDocument.defaultView?.location);
  let characters: KeCharacter[] = [];
  let selectedKey: string | null = null;
  let editingId: number | null = null;
  let configDoc: ConfigDoc = emptyDoc();
  let options: KeOptions | null = null;
  // 地图代码 → 中文名（/ke/mapnames.json），以及中文名反向索引；缺失时回退显示代码。
  let mapNames: Record<string, string> = {};
  let mapCodeByName = new Map<string, string>();
  let selectedJobId: number | null = null;
  let showAllSkills = false;
  let controlDoc = emptyControlDoc();
  let activeTab = "route";
  let dirty = false;
  let previewCollapsed = false;
  let advancedEdit = false;
  let previewTyping = false;
  let charFilter = "";
  let demoProfiles: ProfileDetail[] = [];
  const expandedBlocks = new WeakSet<BlockValue>();

  root.innerHTML = `
  <header class="site-header">
    <div class="topbar page-width">
      <a class="brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup("ke")}
    </div>
  </header>
  <main class="page-width">
    <section class="ke-hero" aria-labelledby="ke-title">
      <div class="ke-hero-main">
        <p class="eyebrow">KoreEngine · 自动挂机配置</p>
        <h1 class="ke-title" id="ke-title">挂机配置<em>工作台</em></h1>
        <p class="ke-hero-sub">为每个角色保存多套挂机方案：路线、战斗、补给与规则表分开管理，激活其中一套即刻生效。</p>
      </div>
      <div class="ke-hero-side">
        <span id="ke-demo-chip" class="ke-demo-chip" hidden><i></i>演示模式 · 操作仅临时模拟</span>
        <p id="ke-status" class="ke-status" role="status" aria-live="polite">正在加载…</p>
        <p class="ke-hero-links">
          <a class="ke-commerce-link" href="/ke/buy">购买额度与功能</a>
          <a href="/ke/device">管理已授权的 KoreEngine 设备 →</a>
          ${demo ? '<a class="ke-demo-hall-link" href="/ke/hall?demo=1">配置大厅 →</a>' : ''}
        </p>
      </div>
    </section>

    <section class="ke-command" id="ke-char-card" aria-label="当前角色" hidden>
      <div class="ke-passport">
        <img class="ke-passport-wm" id="ke-passport-wm" alt="" hidden />
        <div class="ke-char-current">
          <div class="ke-char-avatar" id="ke-char-avatar">
            <img alt="" hidden />
            <span class="ke-char-avatar-fallback">?</span>
            <span class="ke-char-live" aria-hidden="true"></span>
          </div>
          <div class="ke-char-main">
            <p class="ke-passport-label">当前角色 · Current</p>
            <div class="ke-char-name"><span id="ke-char-name">—</span></div>
            <div class="ke-char-meta" id="ke-char-meta">
              <span class="ke-chip ke-chip--job" id="ke-char-job" hidden></span>
            </div>
          </div>
        </div>
        <div class="ke-passport-stats">
          <div class="ke-p-stat"><b id="ke-stat-profiles">0</b><span>配置方案</span></div>
          <div class="ke-p-stat is-hot"><b id="ke-stat-active">0</b><span>使用中</span></div>
          <div class="ke-p-stat"><b id="ke-stat-chars">0</b><span>已绑定角色</span></div>
        </div>
        <div class="ke-passport-actions">
          <button type="button" class="ke-btn-primary ke-passport-new" id="ke-passport-new">＋ 新建方案</button>
          <a class="ke-btn-ghost ke-passport-hall" href="/ke/hall">配置大厅 →</a>
        </div>
      </div>
      <div class="ke-roster">
        <div class="ke-roster-head">
          <div class="ke-roster-title">
            <p class="eyebrow">02 · 冒险者名册</p>
            <h2>全部角色 <span class="ke-count-pill"><i id="ke-roster-count">0</i><span id="ke-roster-total">/ 0</span></span></h2>
          </div>
          <label class="ke-roster-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="M16 16l4 4"></path></svg>
            <input id="ke-roster-filter" type="search" placeholder="搜索角色名 / 职业" aria-label="搜索角色" autocomplete="off" />
          </label>
        </div>
        <div class="ke-char-strip" id="ke-char-strip" aria-label="切换角色"></div>
        <p class="ke-roster-note" id="ke-roster-note"></p>
      </div>
    </section>

    <div class="section-heading ke-profiles-head" id="ke-profiles-head" hidden>
      <div>
        <p class="eyebrow">03 · Profiles</p>
        <h2>配置方案 <span class="ke-profiles-who" id="ke-profiles-who"></span></h2>
      </div>
      <p class="ke-profiles-hint">「使用中」的方案由 KoreEngine 客户端拉取执行；编辑已激活的方案后，需要重新激活才会生效。</p>
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
              <div class="ke-preview-head">
                <button type="button" class="ke-preview-toggle" id="ke-preview-toggle"><span id="ke-preview-file">CONFIG.TXT</span> 预览 <span id="ke-preview-caret">收起 ▾</span></button>
                <button type="button" class="ke-preview-adv" id="ke-preview-adv" aria-pressed="false">高级编辑</button>
              </div>
              <pre id="ke-config-preview" class="ke-preview-pre" aria-live="polite"></pre>
              <textarea id="ke-config-editor" class="ke-preview-edit" spellcheck="false" aria-label="手动编辑配置文本" hidden></textarea>
              <p class="ke-preview-note" id="ke-preview-note" hidden>直接编辑当前文件内容，修改会立即同步到左侧表单；仅支持表单能识别的配置项。</p>
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
  <style>
    .ke-demo-chip { display: inline-flex; align-items: center; gap: 7px; padding: 5px 13px; color: #835f18; background: var(--tip-soft); border: 1px solid var(--tip-line); border-radius: 999px; font-size: .72rem; font-weight: 800; }
    .ke-demo-hall-link { color: var(--forest); font-size: .78rem; font-weight: 800; white-space: nowrap; }
    .ke-demo-chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--gold); }

    .ke-hero { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 18px 28px; padding: 30px 0 22px; }
    .ke-hero .eyebrow { margin: 0 0 9px; color: #a97b24; font-size: .66rem; font-weight: 800; letter-spacing: .22em; text-transform: uppercase; }
    .ke-title { margin: 0; color: #172a23; font-family: Georgia, "Songti SC", "Microsoft YaHei", serif; font-size: clamp(1.7rem, 3vw, 2.35rem); font-weight: 600; letter-spacing: .02em; line-height: 1.25; }
    .ke-title em { color: #b84d3f; font-style: normal; }
    .ke-hero-sub { max-width: 560px; margin: 9px 0 0; color: var(--muted); font-size: .84rem; line-height: 1.75; }
    .ke-hero-side { flex: none; display: grid; gap: 7px; justify-items: end; }
    .ke-hero-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 0; }
    .ke-status { margin: 0; min-height: 1.2em; color: var(--muted); font-size: .76rem; text-align: right; }

    /* 当前角色 passport + 全部角色名册 */
    .ke-command { display: grid; grid-template-columns: 332px minmax(0, 1fr); gap: 16px; align-items: stretch; }
    .ke-passport {
      position: relative; overflow: hidden; display: flex; flex-direction: column;
      padding: 22px 22px 20px; color: #f6efe2;
      background:
        radial-gradient(260px 200px at 105% -5%, rgba(198,148,69,.22), transparent 70%),
        linear-gradient(155deg, #243e33 0%, #1a2e26 48%, #172a23 100%);
      border: 1px solid rgba(198,148,69,.42); border-radius: 16px;
      box-shadow: 0 24px 44px rgba(23,42,35,.3), inset 0 1px 0 rgba(255,248,238,.1);
      animation: ke-rise .5s cubic-bezier(.2,.7,.2,1) backwards;
    }
    .ke-passport::before, .ke-passport::after { content: ""; position: absolute; width: 24px; height: 24px; border: 1px solid rgba(198,148,69,.5); pointer-events: none; }
    .ke-passport::before { top: 8px; left: 8px; border-right: 0; border-bottom: 0; border-top-left-radius: 7px; }
    .ke-passport::after { bottom: 8px; right: 8px; border-left: 0; border-top: 0; border-bottom-right-radius: 7px; }
    .ke-passport-wm { position: absolute; right: -26px; bottom: -18px; width: 168px; height: auto; opacity: .07; filter: grayscale(1) brightness(2.4); pointer-events: none; user-select: none; }
    .ke-passport-wm[hidden] { display: none; }
    .ke-passport-label { margin: 0 0 2px; color: #d9b97f; font-size: .58rem; font-weight: 800; letter-spacing: .22em; text-transform: uppercase; }
    .ke-char-current { display: flex; align-items: center; gap: 14px; }
    .ke-char-avatar { position: relative; flex: none; display: grid; place-items: center; width: 66px; height: 66px; border-radius: 18px; background: rgba(255,248,238,.07); border: 1px solid rgba(198,148,69,.55); box-shadow: inset 0 0 0 4px rgba(198,148,69,.12); }
    .ke-char-avatar::after { content: ""; position: absolute; inset: 5px; border: 1px dashed rgba(255,248,238,.16); border-radius: 13px; pointer-events: none; }
    .ke-char-avatar img { position: relative; z-index: 1; width: 42px; height: 42px; object-fit: contain; image-rendering: pixelated; }
    .ke-char-avatar-fallback { position: relative; z-index: 1; color: #f6efe2; font-family: Georgia, serif; font-size: 1.35rem; font-weight: 900; }
    .ke-char-live { position: absolute; top: -2px; right: -2px; z-index: 2; width: 11px; height: 11px; background: var(--gold); border: 2px solid #1b2f27; border-radius: 50%; animation: ke-pulse 2.4s ease-in-out infinite; }
    .ke-char-main { min-width: 0; display: grid; gap: 2px; }
    .ke-char-name { min-width: 0; color: #fbf5e9; font-family: Georgia, "Songti SC", "Microsoft YaHei", serif; font-size: 1.42rem; font-weight: 600; letter-spacing: .02em; line-height: 1.3; overflow-wrap: anywhere; }
    .ke-char-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }

    .ke-passport-stats { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 20px; padding: 12px 0; border-top: 1px dashed rgba(246,239,226,.18); border-bottom: 1px dashed rgba(246,239,226,.18); }
    .ke-p-stat { display: grid; gap: 1px; padding: 0 8px; }
    .ke-p-stat + .ke-p-stat { border-left: 1px solid rgba(246,239,226,.12); }
    .ke-p-stat b { color: #fbf5e9; font-family: Georgia, serif; font-size: 1.35rem; font-weight: 600; line-height: 1.15; }
    .ke-p-stat.is-hot b { color: #eccf97; }
    .ke-p-stat span { color: rgba(246,239,226,.48); font-size: .56rem; font-weight: 700; letter-spacing: .14em; }
    .ke-passport-actions { display: flex; gap: 8px; margin-top: auto; padding-top: 18px; }
    .ke-passport .ke-passport-new { flex: 1; min-height: 40px; color: #24180a; background: linear-gradient(180deg, #d2a153, #c69445); border-color: #b58436; border-radius: 9px; font-weight: 800; box-shadow: 0 8px 16px rgba(198,148,69,.26); }
    .ke-passport .ke-passport-new:hover:not(:disabled) { color: #24180a; background: linear-gradient(180deg, #dcae64, #cf9d4d); }
    .ke-passport .ke-passport-hall { flex: none; display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 14px; color: #efe4cf; background: rgba(255,248,238,.04); border: 1px solid rgba(246,239,226,.24); border-radius: 9px; font-size: .76rem; font-weight: 700; white-space: nowrap; text-decoration: none; }
    .ke-passport .ke-passport-hall:hover { color: #fff; background: rgba(255,248,238,.1); border-color: rgba(246,239,226,.44); }

    /* 名册 */
    .ke-roster { display: flex; flex-direction: column; min-width: 0; padding: 20px 20px 14px; background: #fffdf8; border: 1px solid #cfc0a8; border-radius: 16px; box-shadow: 0 14px 30px rgba(74,57,35,.08); animation: ke-rise .5s .06s cubic-bezier(.2,.7,.2,1) backwards; }
    .ke-roster-head { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 12px 16px; }
    .ke-roster-title .eyebrow { margin: 0 0 5px; color: #a97b24; font-size: .58rem; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
    .ke-roster-title h2 { display: flex; align-items: center; gap: 9px; margin: 0; color: #172a23; font-family: Georgia, "Songti SC", "Microsoft YaHei", serif; font-size: 1.25rem; font-weight: 600; }
    .ke-count-pill { display: inline-flex; align-items: baseline; gap: 3px; padding: 1px 9px; color: #a97b24; background: #f3e7d0; border: 1px solid #e1cb94; border-radius: 999px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .68rem; font-weight: 800; }
    .ke-count-pill i { font-style: normal; }
    .ke-roster-search { display: flex; align-items: center; gap: 7px; width: 212px; height: 34px; padding: 0 11px; background: #fbf7ef; border: 1px solid #e2d7c4; border-radius: 9px; transition: border-color .15s, box-shadow .15s; }
    .ke-roster-search:focus-within { background: #fffdf8; border-color: var(--gold); box-shadow: 0 0 0 3px rgba(198,148,69,.14); }
    .ke-roster-search svg { flex: none; width: 14px; height: 14px; stroke: #949d96; fill: none; stroke-width: 1.8; stroke-linecap: round; }
    .ke-roster-search input { width: 100%; min-width: 0; height: 30px; min-height: 0; padding: 0; color: var(--ink); background: transparent; border: 0; outline: 0; font-size: .75rem; }
    .ke-roster-search input::placeholder { color: #949d96; }

    .ke-char-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(146px, 1fr)); gap: 8px; margin-top: 14px; }
    .ke-char-card-chip {
      position: relative; display: flex; align-items: center; gap: 9px; min-height: 55px; padding: 0 10px;
      text-align: left; cursor: pointer;
      background: #fffdf8; border: 1px solid #e6dccb; border-radius: 9px; box-shadow: none;
      transition: transform .14s, border-color .14s, background .14s, box-shadow .14s;
    }
    .ke-char-card-chip:hover:not(:disabled) { transform: translateY(-2px); background: #fffaf0; border-color: #cfc0a8; box-shadow: 0 8px 16px rgba(74,57,35,.08); }
    .ke-char-card-chip.is-active { background: #fff8e8; border-color: var(--gold); box-shadow: 0 0 0 1px rgba(198,148,69,.42); }
    .ke-char-card-chip.is-active::before { content: ""; position: absolute; top: 9px; bottom: 9px; left: 0; width: 3px; background: var(--gold); border-radius: 0 3px 3px 0; }
    .ke-char-card-chip.is-live::after {
      content: ""; position: absolute; top: 8px; right: 8px; width: 6px; height: 6px;
      background: var(--gold); border-radius: 50%; box-shadow: 0 0 0 2px #fffdf8;
      animation: ke-pulse 2.4s ease-in-out infinite;
    }
    .ke-char-card-chip.is-active.is-live::after { display: none; }
    .ke-char-card-iconbox { flex: none; display: grid; place-items: center; width: 34px; height: 34px; background: #f7f1e5; border: 1px solid #ecdfc9; border-radius: 8px; overflow: hidden; }
    .ke-char-card-chip.is-active .ke-char-card-iconbox { background: #f6ead2; border-color: #ddc79c; }
    .ke-char-card-icon { width: 27px; height: 27px; object-fit: contain; image-rendering: pixelated; }
    .ke-char-card-icon-fallback { display: grid; place-items: center; width: 27px; height: 27px; color: var(--forest); font-family: Georgia, serif; font-size: .8rem; font-weight: 900; }
    .ke-char-card-info { display: grid; gap: 0; min-width: 0; }
    .ke-char-card-name { overflow: hidden; color: #172a23; font-size: .78rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .ke-char-card-job { color: var(--muted); font-size: .63rem; font-weight: 600; letter-spacing: .02em; }
    .ke-char-card-flag { position: absolute; top: 4px; right: 5px; padding: 0 5px; color: #2b1c06; background: var(--gold); border-radius: 999px; font-size: .5rem; font-weight: 800; letter-spacing: .06em; }
    .ke-roster-note { display: flex; align-items: center; gap: 8px; margin: 13px 0 0; color: var(--muted); font-size: .64rem; }
    .ke-roster-note::before { content: ""; width: 14px; height: 1px; background: #cfc0a8; }
    .ke-roster-empty { grid-column: 1 / -1; padding: 22px; color: var(--muted); border: 1px dashed #e2d7c4; border-radius: 10px; text-align: center; font-size: .76rem; }

    .ke-chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; font-size: .62rem; font-weight: 700; }
    .ke-chip--job { color: #eccf97; background: rgba(198,148,69,.14); border: 1px solid rgba(198,148,69,.45); }
    .ke-chip--map { color: rgba(246,239,226,.82); background: rgba(255,248,238,.07); border: 1px solid rgba(255,248,238,.14); font-family: ui-monospace, Menlo, Consolas, monospace; }
    .ke-chip--map-zh, .ke-chip--seen { color: rgba(246,239,226,.78); background: rgba(255,248,238,.07); border: 1px solid rgba(255,248,238,.14); }

    .ke-profiles-head { margin-top: 30px; }
    .ke-profiles-head .eyebrow { color: #a97b24; }
    .ke-profiles-head h2 { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    .ke-profiles-who { color: var(--red-dark); font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: .74rem; font-weight: 700; }
    .ke-profiles-hint { max-width: 470px; color: var(--muted); font-size: .72rem; line-height: 1.7; }

    .ke-profile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: 14px; }
    .ke-profile-card { display: flex; flex-direction: column; gap: 9px; min-height: 186px; padding: 16px 16px 13px; background: #fffdf8; border: 1px solid #ddd0bb; border-radius: 14px; box-shadow: 0 14px 30px rgba(74,57,35,.08); animation: ke-rise .5s .12s cubic-bezier(.2,.7,.2,1) backwards; transition: transform .16s, border-color .16s, box-shadow .16s; }
    .ke-profile-card:hover { transform: translateY(-3px); border-color: #cfc0a8; box-shadow: 0 26px 50px rgba(74,57,35,.15); }
    .ke-profile-card.is-active { background: linear-gradient(180deg, #f2f8f3 0%, #fffdf8 62%); border-color: #7fae94; box-shadow: 0 0 0 1px rgba(44,122,89,.22), 0 14px 28px rgba(44,122,89,.12); }
    .ke-profile-name { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; color: #172a23; font-family: Georgia, "Songti SC", "Microsoft YaHei", serif; font-size: 1.06rem; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
    .ke-profile-name > span:first-child { min-width: 0; }
    .ke-profile-share-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; color: var(--muted); font-size: .72rem; }
    .ke-profile-share-code { color: var(--forest); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-weight: 800; }
    .ke-profile-share-row a { color: var(--forest); font-weight: 800; }
    .ke-profile-share-row button { min-height: 28px; padding: 3px 8px; font-size: .68rem; }
    .ke-badge-live { display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px; color: var(--buy); background: var(--buy-soft); border: 1px solid #b5d4c4; border-radius: 999px; font-size: .66rem; font-weight: 800; white-space: nowrap; }
    .ke-badge-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--buy); animation: ke-pulse 2.2s ease-in-out infinite; }
    @keyframes ke-pulse { 50% { opacity: .35; } }
    @keyframes ke-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    .ke-profile-meta { margin-top: auto; padding-top: 9px; color: var(--muted); border-top: 1px dashed var(--line); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .6rem; letter-spacing: .02em; }
    .ke-profile-actions { display: flex; flex-wrap: wrap; gap: 6px 7px; margin-top: 2px; }

    .ke-profile-new { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; min-height: 186px; padding: 18px; color: var(--muted); background: transparent; border: 1.5px dashed #cfc0a8; border-radius: 14px; box-shadow: none; cursor: pointer; transition: border-color .16s, background .16s, transform .16s; }
    .ke-profile-new:hover:not(:disabled) { color: var(--muted); background: #fffaf0; border-color: var(--gold); transform: translateY(-2px); }
    .ke-profile-new-ring { display: grid; place-items: center; width: 34px; height: 34px; margin-bottom: 2px; color: #a97b24; background: #fff8e8; border: 1px solid var(--gold); border-radius: 50%; font-family: Georgia, serif; font-size: 1.2rem; line-height: 1; }
    .ke-profile-new b { color: var(--forest); font-size: .8rem; }
    .ke-profile-new small { color: #949d96; font-size: .66rem; }
    .ke-profile-hall { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-height: 186px; color: var(--forest); background: transparent; border: 1.5px dashed #b5d4c4; border-radius: 14px; font-weight: 700; box-shadow: none; cursor: pointer; text-decoration: none; }
    .ke-profile-hall:hover { color: #1f5e43; border-color: var(--buy); background: var(--buy-soft); }
    .ke-profile-hall small { color: var(--muted); font-size: .66rem; font-weight: 600; }

    .ke-btn-ghost { color: var(--ink); background: #f7f3ea; border-color: #aa9d88; border-radius: 8px; min-height: 30px; padding: 3px 12px; font-size: .74rem; }
    .ke-btn-ghost:hover:not(:disabled) { color: var(--ink); background: #efe9dd; border-color: #97896f; }
    .ke-btn-quiet { color: var(--muted); background: transparent; }
    .ke-btn-quiet:hover:not(:disabled) { color: var(--forest); background: #efe9dd; }
    .ke-btn-primary { border-radius: 8px; min-height: 40px; }
    .ke-btn-live { color: var(--buy); background: var(--buy-soft); border-color: #b5d4c4; border-radius: 8px; min-height: 30px; padding: 3px 12px; font-size: .74rem; font-weight: 800; }
    .ke-btn-live:hover:not(:disabled) { color: #1f5e43; background: #d5e8de; border-color: var(--buy); }
    .ke-btn-danger { color: var(--red-dark); background: #fdf6f3; border-color: #d8b3a9; border-radius: 8px; min-height: 30px; padding: 3px 12px; font-size: .74rem; font-weight: 800; }
    .ke-btn-danger:hover:not(:disabled) { color: var(--red-dark); background: #f6e7e1; border-color: var(--red-dark); }

    .ke-empty { display: grid; justify-items: center; gap: 7px; padding: 42px 24px 38px; color: var(--muted); background: radial-gradient(340px 160px at 50% 0%, #fbf4e6 0%, transparent 70%), #fffdf8; border: 1px solid #cfc0a8; border-radius: 14px; box-shadow: 0 14px 30px rgba(74,57,35,.08); text-align: center; font-size: .8rem; line-height: 1.7; }
    .ke-empty-orbit { display: grid; place-items: center; width: 58px; height: 58px; margin-bottom: 5px; color: #a97b24; background: #fff8e8; border: 1px solid var(--gold); border-radius: 50%; box-shadow: inset 0 0 0 5px rgba(198,148,69,.12); font-family: Georgia, serif; font-size: 1.6rem; line-height: 1; }
    .ke-empty b { color: #172a23; font-family: Georgia, "Songti SC", "Microsoft YaHei", serif; font-size: 1.05rem; font-weight: 600; }
    .ke-empty-steps { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin: 3px 0 5px; }
    .ke-empty-steps span { padding: 2px 9px; color: var(--muted); background: #f6f1e7; border: 1px solid var(--line); border-radius: 999px; font-size: .62rem; font-weight: 600; }
    .ke-empty-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 4px; }
    .ke-empty-hall { display: inline-flex; align-items: center; min-height: 40px; padding: 3px 18px; color: #fff; background: var(--forest); border-color: var(--forest); border-radius: 8px; font-weight: 800; text-decoration: none; box-shadow: 0 8px 18px rgba(44,74,58,.22); }
    .ke-empty-hall:hover { color: #fff; background: #1f5e43; border-color: #1f5e43; }

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
    /* 单位内嵌输入框：外框模拟输入框样式，内部 input 去边框，右侧竖线分隔单位。 */
    .ke-affix { display: flex; align-items: stretch; border: 1px solid var(--line-light); border-radius: 8px; background: #fffdf8; overflow: hidden; }
    .ke-affix:focus-within { outline: 2px solid var(--gold); outline-offset: 3px; }
    .ke-affix input { flex: 1; min-width: 0; min-height: 38px; border: 0; border-radius: 0; background: transparent; }
    .ke-affix input:focus-visible { outline: none; }
    .ke-affix .ke-suffix { display: inline-flex; align-items: center; padding: 0 11px; border-left: 1px solid var(--line-light); background: #f7f3ea; }
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
    .ke-b-tail { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .ke-chev { color: var(--muted); transition: transform .18s ease; }
    .ke-block-card.is-open .ke-chev { transform: rotate(180deg); }
    .ke-block-del { background: transparent; border: 1px solid transparent; color: #c97869; font-size: .85rem; width: 22px; height: 22px; min-height: 0; border-radius: 6px; line-height: 1; padding: 0; cursor: pointer; opacity: .55; transition: opacity .15s, background .15s, border-color .15s; }
    .ke-block-del:hover, .ke-block-card .ke-block-del:hover { opacity: 1; background: rgba(201,120,105,.12); border-color: #c97869; }
    .ke-block-move { background: transparent; border: 1px solid transparent; color: var(--muted); font-size: .72rem; width: 20px; height: 22px; min-height: 0; border-radius: 6px; line-height: 1; padding: 0; cursor: pointer; opacity: .55; transition: opacity .15s, background .15s, border-color .15s; }
    .ke-block-move:hover, .ke-block-card .ke-block-move:hover { opacity: 1; color: var(--forest); background: rgba(80,62,38,.08); border-color: var(--line-light); }
    .ke-block-grip { display: inline-grid; place-items: center; width: 16px; height: 22px; min-height: 0; color: var(--muted); font-size: .8rem; cursor: grab; opacity: .55; }
    .ke-block-grip:hover { opacity: 1; }
    .ke-block-card.is-drop-before { box-shadow: 0 -3px 0 var(--gold); }
    .ke-block-card.is-drop-after { box-shadow: 0 3px 0 var(--gold); }
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
    .ke-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
    .ke-tags-empty { color: var(--muted); font-size: .74rem; }
    .ke-tag { display: inline-flex; align-items: center; gap: 6px; background: #fffdf8; border: 1px solid var(--line-light); border-radius: 6px; padding: 3px 6px 3px 9px; font-size: .76rem; font-weight: 600; color: var(--forest); line-height: 1.5; }
    .ke-tag-x { display: inline-grid; place-items: center; width: 14px; height: 14px; min-height: 0; margin: 0; border: none; background: transparent; color: var(--muted); font-size: .8rem; font-weight: 400; line-height: 1; padding: 0; box-shadow: none; cursor: pointer; }
    .ke-tag-x:hover, .ke-tags .ke-tag-x:hover { background: transparent; border-color: transparent; color: #b3502f; }
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
    .ke-preview-head { display: flex; align-items: center; gap: 8px; }
    .ke-preview-toggle { display: flex; flex: 1; align-items: center; gap: 4px; min-height: 0; padding: 0; color: var(--muted); background: transparent; border: 0; font-size: .68rem; font-weight: 900; letter-spacing: .06em; box-shadow: none; cursor: pointer; }
    .ke-preview-toggle:hover:not(:disabled) { color: var(--forest); background: transparent; }
    .ke-preview-adv { flex: none; min-height: 0; padding: 2px 8px; color: var(--muted); background: transparent; border: 1px solid var(--line-light); border-radius: 6px; font-size: .64rem; font-weight: 800; letter-spacing: 0; box-shadow: none; cursor: pointer; }
    .ke-preview-adv:hover:not(:disabled) { color: var(--forest); background: rgba(255,253,248,.7); border-color: var(--line); }
    .ke-preview-adv.is-on { color: var(--red-dark); background: #fffdf8; border-color: #cfa692; }
    .ke-preview-pre { margin: 9px 0 0; padding: 11px 12px; max-height: 300px; overflow: auto; color: #4c5a50; background: var(--forest-card); border: 1px solid var(--line); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .7rem; line-height: 1.65; white-space: pre-wrap; word-break: break-all; }
    .ke-preview-pre[hidden] { display: none; }
    .ke-preview-edit { display: block; width: 100%; min-height: 260px; max-height: 420px; margin: 9px 0 0; padding: 11px 12px; color: #4c5a50; background: #fffdf8; border: 1px solid var(--line); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .7rem; line-height: 1.65; resize: vertical; }
    .ke-preview-edit:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
    .ke-preview-edit[hidden] { display: none; }
    .ke-preview-note { margin: 8px 0 0; color: var(--muted); font-size: .66rem; line-height: 1.6; }
    .ke-preview-note[hidden] { display: none; }
    .ke-side-save { display: grid; gap: 8px; margin-top: 12px; }
    .ke-side-save .ke-btn-primary, .ke-side-save .ke-btn-ghost { min-height: 40px; font-size: .82rem; }

    .ke-editor-foot { display: none; position: sticky; bottom: 0; z-index: 5; gap: 10px; padding: 12px 16px; background: rgba(247,243,234,.97); backdrop-filter: blur(10px); border-top: 1px solid var(--line); border-radius: 0 0 12px 12px; }

    .ke-hint { margin: 14px 2px 0; color: var(--muted); font-size: .72rem; line-height: 1.7; white-space: pre-line; }

    @media (max-width: 1080px) {
      .ke-editor-body { grid-template-columns: 176px minmax(0, 1fr); }
      .ke-side { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
      .ke-side-card + .ke-side-card { margin-top: 0; }
      .ke-side-save { margin-top: 0; align-self: start; }
    }
    @media (max-width: 980px) {
      .ke-command { grid-template-columns: 1fr; }
      .ke-hero { align-items: flex-start; }
      .ke-hero-side { justify-items: start; }
      .ke-status { text-align: left; }
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
      .ke-hero { flex-direction: column; gap: 14px; }
      .ke-roster-head { align-items: flex-start; }
      .ke-roster-search { width: 100%; }
      .ke-char-strip { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
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
      .ke-char-strip { grid-template-columns: 1fr 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ke-badge-live i, .ke-char-live, .ke-char-card-chip.is-live::after,
      .ke-passport, .ke-roster, .ke-profile-card, .ke-chev, .ke-help .ke-tip {
        transition: none !important;
        animation: none !important;
      }
    }

    /* 世界地图选图：输入框 + 「选择地图」按钮行 */
    .ke-mapline { display: flex; gap: 8px; align-items: stretch; }
    .ke-mapline input { flex: 1; min-width: 0; }
    .ke-mapline .ke-wmap-open { flex: none; min-height: 40px; padding: 0 14px; font-size: .78rem; white-space: nowrap; }

    /* 选图后的「添加地图预设」询问浮层（怪物 → 怪物规则，掉落物 → 拾取/物品规则） */
    .ke-preset-overlay { position: fixed; inset: 0; z-index: 95; display: grid; place-items: center; padding: 18px; background: rgba(43,37,28,.45); backdrop-filter: blur(3px); }
    .ke-preset-dialog { display: grid; gap: 10px; width: min(520px, 100%); max-height: calc(100vh - 36px); overflow: auto; padding: 16px 18px 14px; background: #f7f3ea; border: 1px solid #b9ab94; border-radius: 12px; box-shadow: 0 26px 60px rgba(80,62,38,.25); }
    .ke-preset-title { margin: 0; color: var(--forest); font-size: .95rem; font-weight: 800; text-align: center; }
    .ke-preset-body { margin: 0; color: #4c5a50; font-size: .82rem; line-height: 1.7; }
    .ke-preset-body strong { color: var(--forest); }
    .ke-preset-mobs { display: flex; flex-wrap: wrap; gap: 4px; max-height: 108px; overflow-y: auto; padding: 6px; border: 1px solid var(--line-light); border-radius: 8px; background: var(--cream); }
    .ke-preset-mob { padding: 1px 8px; border-radius: 999px; background: #e9e2d0; color: #4c5a50; font-size: .74rem; line-height: 1.7; white-space: nowrap; }
    .ke-preset-mob.ke-preset-more { background: transparent; color: var(--muted); }
    .ke-preset-actions { display: flex; justify-content: center; gap: 10px; margin-top: 4px; }
    .ke-preset-actions button { min-height: 36px; padding: 6px 18px; border-radius: 8px; font-size: .82rem; font-weight: 700; cursor: pointer; }
    .ke-preset-yes { border: 1px solid var(--forest); background: var(--forest); color: #f7f3ea; }
    .ke-preset-yes:hover:not(:disabled) { background: #2e4638; border-color: #2e4638; }
    .ke-preset-no { border: 1px solid var(--line-light); background: var(--cream); color: var(--muted); }
    .ke-preset-no:hover:not(:disabled) { color: var(--red-dark); background: #f7f3ea; border-color: var(--red-dark); }

    /* 复制方案到其他角色：轻量弹窗，列出当前账号的其它角色 */
    .ke-copy-overlay { position: fixed; inset: 0; z-index: 95; display: grid; place-items: center; padding: 18px; background: rgba(43,37,28,.45); backdrop-filter: blur(3px); }
    .ke-copy-overlay[hidden] { display: none; }
    .ke-copy-dialog { display: grid; gap: 12px; width: min(460px, 100%); max-height: calc(100vh - 36px); overflow: auto; padding: 16px 18px 14px; background: #f7f3ea; border: 1px solid #b9ab94; border-radius: 12px; box-shadow: 0 26px 60px rgba(80,62,38,.25); }
    .ke-copy-title { margin: 0; color: var(--forest); font-size: .95rem; font-weight: 800; text-align: center; }
    .ke-copy-sub { margin: 0; color: #4c5a50; font-size: .78rem; line-height: 1.65; }
    .ke-copy-list { display: grid; gap: 6px; max-height: 280px; overflow-y: auto; }
    .ke-copy-char { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; color: var(--ink); background: #fffdf8; border: 1px solid var(--line); border-radius: 8px; font: inherit; text-align: left; box-shadow: none; cursor: pointer; }
    .ke-copy-char:hover:not(:disabled) { border-color: var(--line-light); background: #fff6e6; }
    .ke-copy-char.is-on { border-color: var(--buy); background: var(--cream); box-shadow: 0 0 0 2px var(--buy-soft); }
    .ke-copy-char-icon { width: 22px; height: 22px; flex: none; object-fit: contain; image-rendering: pixelated; }
    .ke-copy-char-icon-fallback { display: grid; place-items: center; width: 22px; height: 22px; flex: none; color: var(--forest); background: var(--cream); border: 1px solid var(--line-light); border-radius: 5px; font-size: .7rem; font-weight: 800; }
    .ke-copy-char-text { display: grid; gap: 1px; min-width: 0; }
    .ke-copy-char-name { overflow: hidden; color: var(--forest); font-size: .82rem; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
    .ke-copy-char-job { color: var(--muted); font-size: .7rem; }
    .ke-copy-empty { padding: 16px; color: var(--muted); background: #fffdf8; border: 1px dashed var(--line-light); border-radius: 8px; font-size: .8rem; text-align: center; }
    .ke-copy-error { margin: 0; color: var(--red-dark); font-size: .76rem; font-weight: 700; }
    .ke-copy-error[hidden] { display: none; }
    .ke-copy-actions { display: flex; justify-content: flex-end; gap: 10px; }
  </style>
  `;

  mountSiteNav(root);

  const status = root.querySelector<HTMLElement>("#ke-status")!;
  const charCard = root.querySelector<HTMLElement>("#ke-char-card")!;
  const avatarWrap = root.querySelector<HTMLElement>("#ke-char-avatar")!;
  const avatarImg = avatarWrap.querySelector<HTMLImageElement>("img")!;
  const avatarFallback = avatarWrap.querySelector<HTMLElement>(".ke-char-avatar-fallback")!;
  const avatarLive = avatarWrap.querySelector<HTMLElement>(".ke-char-live")!;
  const charName = root.querySelector<HTMLElement>("#ke-char-name")!;
  const jobChip = root.querySelector<HTMLElement>("#ke-char-job")!;
  const charMeta = root.querySelector<HTMLElement>("#ke-char-meta")!;
  const charStrip = root.querySelector<HTMLElement>("#ke-char-strip")!;
  const charWm = root.querySelector<HTMLImageElement>("#ke-passport-wm")!;
  const rosterFilter = root.querySelector<HTMLInputElement>("#ke-roster-filter")!;
  const rosterCount = root.querySelector<HTMLElement>("#ke-roster-count")!;
  const rosterTotal = root.querySelector<HTMLElement>("#ke-roster-total")!;
  const rosterNote = root.querySelector<HTMLElement>("#ke-roster-note")!;
  const statProfiles = root.querySelector<HTMLElement>("#ke-stat-profiles")!;
  const statActive = root.querySelector<HTMLElement>("#ke-stat-active")!;
  const statChars = root.querySelector<HTMLElement>("#ke-stat-chars")!;
  const passportNew = root.querySelector<HTMLButtonElement>("#ke-passport-new")!;
  const profilesHead = root.querySelector<HTMLElement>("#ke-profiles-head")!;
  const profilesWho = root.querySelector<HTMLElement>("#ke-profiles-who")!;
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
  const previewCaret = root.querySelector<HTMLElement>("#ke-preview-caret")!;
  const preview = root.querySelector<HTMLElement>("#ke-config-preview")!;
  const previewEditor =
    root.querySelector<HTMLTextAreaElement>("#ke-config-editor")!;
  const previewAdv = root.querySelector<HTMLButtonElement>("#ke-preview-adv")!;
  const previewNote = root.querySelector<HTMLElement>("#ke-preview-note")!;
  const sharingControls = createProfileSharing(root.ownerDocument, () => markDirty(), () => void withdrawSharing());
  editor.querySelector<HTMLElement>(".ke-editor-head")?.after(sharingControls.root);

  rosterFilter.addEventListener("input", () => {
    charFilter = rosterFilter.value;
    renderCharacterStrip();
  });
  passportNew.addEventListener("click", () => {
    if (confirmDiscard()) window.location.assign(newProfileHref());
  });

  function selectedCharacter(): KeCharacter | null {
    return (
      characters.find((c) => `${c.aid}:${c.cid}:${c.nid}` === selectedKey) ??
      null
    );
  }

  /** demo 多角色下，每名角色只看自己的方案。 */
  function demoProfilesForSelected(): ProfileDetail[] {
    const ch = selectedCharacter();
    if (!ch) return [];
    return demoProfiles.filter(
      (p) => p.aid === ch.aid && p.cid === ch.cid && p.nid === ch.nid,
    );
  }

  /** 新建方案统一进一键配置向导；编辑已有方案仍走下方编辑器。 */
  function newProfileHref(): string {
    const ch = selectedCharacter();
    const demoSuffix = demo ? `${ch ? "&" : "?"}demo=1` : "";
    return ch
      ? `/ke/my/create/setup-guide?aid=${ch.aid}&cid=${ch.cid}&nid=${ch.nid}${demoSuffix}`
      : `/ke/my/create/setup-guide${demoSuffix}`;
  }

  function jobLabelOf(character: KeCharacter): string {
    return (
      (character.job_id !== null
        ? options?.jobs_zh?.[String(character.job_id)] ??
          options?.jobs[String(character.job_id)]
        : undefined) || "未知职业"
    );
  }

  /** char_name / map_name / job_id 由 KE 客户端自报或 RO 配置，必须纯文本写入。 */
  function renderCharacterStrip(): void {
    charStrip.replaceChildren();
    const term = charFilter.trim().toLowerCase();
    const matched = characters.filter(
      (c) =>
        term === "" ||
        c.char_name.toLowerCase().includes(term) ||
        jobLabelOf(c).toLowerCase().includes(term),
    );
    rosterCount.textContent = String(matched.length);
    rosterTotal.textContent = `/ ${characters.length}`;
    rosterNote.textContent =
      term === ""
        ? `全部 ${characters.length} 名角色已平铺展示 · 点击任意卡片切换当前角色`
        : `匹配 ${matched.length} / ${characters.length} 名角色 · 清空搜索显示全部`;
    if (matched.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ke-roster-empty";
      empty.textContent = `没有匹配「${charFilter.trim()}」的角色，试试职业名（如「猎人」）`;
      charStrip.appendChild(empty);
      return;
    }
    const currentKey = selectedKey;
    matched.forEach((c) => {
      const key = `${c.aid}:${c.cid}:${c.nid}`;
      const isCurrent = key === currentKey;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `ke-char-card-chip${isCurrent ? " is-active" : ""}${c.last_seen_at > Date.now() - 5 * 60_000 ? " is-live" : ""}`;
      btn.dataset.key = key;
      btn.setAttribute("aria-pressed", isCurrent ? "true" : "false");
      // 职业图标（只有没图标时才 fallback 字首）
      const iconBox = document.createElement("span");
      iconBox.className = "ke-char-card-iconbox";
      const src = iconSrc(c.job_id);
      if (src) {
        const icon = document.createElement("img");
        icon.alt = "";
        icon.className = "ke-char-card-icon";
        icon.src = src;
        iconBox.appendChild(icon);
      } else {
        const fallback = document.createElement("span");
        fallback.className = "ke-char-card-icon-fallback";
        fallback.textContent = c.char_name.slice(0, 1) || "?";
        iconBox.appendChild(fallback);
      }
      btn.appendChild(iconBox);
      // 信息
      const info = document.createElement("span");
      info.className = "ke-char-card-info";
      const name = document.createElement("span");
      name.className = "ke-char-card-name";
      name.textContent = c.char_name;
      const job = document.createElement("span");
      job.className = "ke-char-card-job";
      job.textContent = jobLabelOf(c);
      info.append(name, job);
      btn.appendChild(info);
      if (isCurrent) {
        const flag = document.createElement("span");
        flag.className = "ke-char-card-flag";
        flag.textContent = "当前";
        btn.appendChild(flag);
      }
      btn.addEventListener("click", () => {
        if (!confirmDiscard()) return;
        selectedKey = key;
        const sel = selectedCharacter();
        selectedJobId = sel?.job_id ?? null;
        hideForm();
        renderCharCard();
        renderCharacterStrip(); // 刷新 active 状态
        void reloadProfiles();
      });
      charStrip.appendChild(btn);
    });
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

  /** 当前激活分区对应的预览文件（scalars/skills → CONFIG.TXT，其余为规则文件）。 */
  function currentPreview(): { file: string; text: string; emptyText: string } {
    const entry = NAV.find((n) => n.id === activeTab) ?? NAV[0]!;
    if (entry.kind === "controls") {
      const schema = CONTROL_SCHEMAS.find((s) => s.file === entry.file)!;
      return {
        file: entry.file!.toUpperCase(),
        text: serializeControl(schema, controlDoc[entry.file!] ?? []),
        emptyText: "（空）",
      };
    }
    return {
      file: "CONFIG.TXT",
      text: serializeConfig(configDoc),
      emptyText: "",
    };
  }

  /** 预览区显示状态：折叠 / 只读预览 / 高级编辑三者互斥。 */
  function syncPreviewVisibility(): void {
    const expanded = !previewCollapsed;
    preview.hidden = !(expanded && !advancedEdit);
    previewEditor.hidden = !(expanded && advancedEdit);
    previewNote.hidden = !advancedEdit;
    previewCaret.textContent = previewCollapsed ? "展开 ▸" : "收起 ▾";
    previewAdv.textContent = advancedEdit ? "退出高级" : "高级编辑";
    previewAdv.classList.toggle("is-on", advancedEdit);
    previewAdv.setAttribute("aria-pressed", advancedEdit ? "true" : "false");
  }

  function updatePreview(): void {
    const content = currentPreview();
    previewFile.textContent = content.file;
    preview.textContent =
      content.text === "" ? content.emptyText : content.text;
    // 输入中（input 事件内）不能回写，否则光标会被重置。
    if (!previewTyping && document.activeElement !== previewEditor) {
      previewEditor.value = content.text;
    }
  }

  /** 高级编辑：把 textarea 文本解析回表单模型，左侧 GUI 立即重建。 */
  function applyPreviewEdit(): void {
    const entry = NAV.find((n) => n.id === activeTab) ?? NAV[0]!;
    previewTyping = true;
    try {
      if (entry.kind === "controls") {
        const schema = CONTROL_SCHEMAS.find((s) => s.file === entry.file)!;
        controlDoc[entry.file!] = parseControl(schema, previewEditor.value);
      } else {
        configDoc = parseConfig(previewEditor.value);
      }
    } finally {
      previewTyping = false;
    }
    markDirty();
    renderActivePanel();
    updateNavCounts();
    updateSideStats();
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
    /**
     * freeText=true：输入框文本本身就是值（标量/块级物品名字段、地图码等），
     *   input 事件同步 onSelect(input.value)，支持清空与自由文本。
     * freeText=false（默认）：值是 option 的映射值（技能/怪物/状态 ID、职业英文名等），
     *   input 事件只过滤下拉列表，onSelect 仅在点中选项时触发——避免把搜索中间态写进配置。
     */
    freeText = false,
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
    // 已聚焦时再次点击也要重新弹出下拉（focus 只在未聚焦时触发）。
    input.addEventListener("click", () => {
      if (!list.hidden) return;
      render(input.value);
      list.hidden = false;
    });
    input.addEventListener("input", () => {
      // freeText 场景（物品名/地图码等）输入框文本本身就是值，必须同步回数据源，
      // 否则清空后保存时旧值仍会被写回 config.txt。
      // mapped 场景（技能/怪物/状态 ID 等）搜索文本不是合法值，只过滤列表不提交。
      if (freeText) onSelect(input.value);
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

  /** 地图代码的展示文本：有中文名时显示「中文名（代码）」，否则直接显示代码。 */
  function mapDisplay(code: string): string {
    if (code === "") return "";
    const name = mapNames[code];
    return name ? `${name}（${code}）` : code;
  }

  /**
   * 地图选择器（挂机地图/回城地图）：输入框显示中文名，提交值始终是地图代码。
   * 支持按中文名或代码过滤、从列表选择，以及在输入框里手动填写任意地图代码（实例图兜底）。
   */
  function createMapPicker(
    initial: string,
    onSelect: (code: string) => void,
  ): { root: HTMLElement; setValue: (code: string) => void } {
    const wrapper = document.createElement("div");
    wrapper.className = "ke-picker";
    const input = document.createElement("input");
    input.autocomplete = "off";
    input.placeholder = "搜索地图名或代码…";
    input.value = mapDisplay(initial);
    const list = document.createElement("div");
    list.className = "ke-picker-list";
    list.hidden = true;
    wrapper.append(input, list);

    // 输入文本 → 地图代码：完整标签、纯中文名或代码本身都能解析，其余按手输代码原样提交。
    const toCode = (raw: string): string => {
      const text = raw.trim();
      if (text === "") return "";
      const label = text.match(/^(.*)（([^（）]+)）$/);
      if (label && mapNames[label[2]!] !== undefined) return label[2]!;
      return mapCodeByName.get(text) ?? text;
    };

    function render(query: string): void {
      list.innerHTML = "";
      const q = query.trim().toLowerCase();
      let shown = 0;
      let truncated = false;
      for (const { code } of options?.maps ?? []) {
        const label = mapDisplay(code);
        if (q && !label.toLowerCase().includes(q) && !code.toLowerCase().includes(q)) continue;
        if (shown >= PICKER_LIMIT) {
          truncated = true;
          break;
        }
        const item = document.createElement("div");
        item.className = "ke-picker-item";
        item.textContent = label;
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          input.value = label;
          onSelect(code);
          list.hidden = true;
        });
        list.appendChild(item);
        shown += 1;
      }
      if (truncated) {
        const more = document.createElement("div");
        more.className = "ke-picker-more";
        more.textContent = `已达 ${PICKER_LIMIT} 项上限，请直接输入文字继续过滤`;
        more.addEventListener("mousedown", (event) => event.preventDefault());
        list.appendChild(more);
      }
      list.hidden = shown === 0;
    }

    input.addEventListener("focus", () => {
      render("");
      list.hidden = false;
    });
    input.addEventListener("click", () => {
      if (!list.hidden) return;
      render(input.value);
      list.hidden = false;
    });
    input.addEventListener("input", () => {
      const value = normalizeFullWidth(input.value);
      if (value !== input.value) input.value = value;
      const code = toCode(value);
      // 解析成已知地图（中文名/完整标签/代码）时写入代码；纯 ASCII 视为手输代码照常提交；
      // 半截中文名先不写入配置，避免把无效中文名存进 config.txt。
      if (value === "") onSelect("");
      else if (code !== value || !/[\u3400-\u9fff]/u.test(value)) onSelect(code);
      render(value);
      list.hidden = false;
    });
    input.addEventListener("blur", () => {
      // 失焦时把能解析的地图代码规范成「中文名（代码）」，避免输入框停在半截名字上。
      input.value = mapDisplay(toCode(input.value));
      window.setTimeout(() => {
        list.hidden = true;
      }, 150);
    });

    return {
      root: wrapper,
      setValue: (code) => {
        input.value = mapDisplay(code);
      },
    };
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
      value: m.name, // KO config 用怪物名字，不用 ID
    }));
  }

  /** 把逗号分隔的怪物名字/ID 串解析成中文名（找不到的保留原值）。 */
  function monsterNamesOf(csv: string): string {
    const pool = monsterOptions();
    return csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((v) => {
        // 先按名字查（新格式），找不到按 ID 查（旧格式），都找不到保留原值
        const byName = pool.find((o) => o.value === v);
        if (byName) return byName.label;
        const byId = (options?.monsters ?? []).find((m) => String(m.id) === v);
        return byId?.name ?? v;
      })
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
    // 数字部分用严格小数格式，避免把范围写法 "20..80" 误吞为单个数字
    const match = trimmed.match(/^([<>=!]+)\s*(\d+(?:\.\d+)?)\s*(%)?$/);
    if (match) return { op: match[1]!, value: match[2]!, percent: match[3] === "%" };
    const numMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(%)?$/);
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
    // 范围（3..8 / 20..80%）或 != 等三段式无法表达的合法写法：回退为纯文本输入，保留原文不丢失。
    if (parsed === null && initialText.trim() !== "") {
      const fallback = document.createElement("input");
      fallback.type = "text";
      fallback.value = initialText;
      fallback.placeholder = "例：< 50% 或 3..8";
      fallback.addEventListener("input", () =>
        onChange(normalizeFullWidth(fallback.value)),
      );
      wrapper.appendChild(fallback);
      return wrapper;
    }
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
   * 地图多选编辑器：已选地图以 chips 展示（可逐个移除）+ 搜索选择器追加。
   * 接受空格/逗号混合分隔的旧输入并规范化为逗号分隔；允许添加列表外的地图代码。
   */
  function createMapChipsEditor(
    initialValue: string,
    onChange: (csv: string, silent?: boolean) => void,
  ): HTMLElement {
    const wrap = document.createElement("div");
    const pool = (options?.maps ?? []).map((m) => ({
      value: m.code,
      label: m.code,
    }));
    const chips = document.createElement("div");
    chips.className = "ke-tags";
    // KE 允许空白或逗号分隔，统一规范为逗号分隔。
    let current = initialValue
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(", ");
    if (current !== initialValue) onChange(current, true);
    const codesOf = (): string[] =>
      current.split(",").map((s) => s.trim()).filter(Boolean);
    function renderChips(): void {
      chips.innerHTML = "";
      const codes = codesOf();
      if (codes.length === 0) {
        const empty = document.createElement("span");
        empty.className = "ke-tags-empty";
        empty.textContent = "未添加额外地图";
        chips.appendChild(empty);
        return;
      }
      for (const code of codes) {
        const tag = document.createElement("span");
        tag.className = "ke-tag";
        const label = document.createElement("span");
        label.textContent = code;
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "ke-tag-x";
        removeBtn.title = `移除 ${code}`;
        removeBtn.setAttribute("aria-label", `移除 ${code}`);
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", () => {
          current = codesOf().filter((v) => v !== code).join(", ");
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
        const codes = codesOf();
        if (!codes.includes(value)) codes.push(value);
        current = codes.join(", ");
        onChange(current);
        renderChips();
      }, true, "＋ 搜索地图加入列表…"),
    );
    return wrap;
  }

  /**
   * 怪物多选编辑器：已选怪物以 chips 展示（可逐个移除）+ 搜索选择器追加。
   * 值为逗号分隔的怪物 ID 串；空串回调 '' 表示清空。
   */
  function createMonsterChipsEditor(
    initialValue: string,
    onChange: (csv: string, silent?: boolean) => void,
    emptyText = "未指定，对全部怪物生效",
  ): HTMLElement {
    const wrap = document.createElement("div");
    const pool = monsterOptions();
    const chips = document.createElement("div");
    chips.className = "ke-tags";
    // 初始化时把旧的怪物 ID 格式转成名字格式（KO config 用名字）
    let current = initialValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((v) => {
        if (pool.some((o) => o.value === v)) return v; // 已经是名字
        const byId = (options?.monsters ?? []).find((m) => String(m.id) === v);
        return byId?.name ?? v; // 旧 ID → 名字；找不到保留原值
      })
      .join(", ");
    // 如果发生了转换，无声回写到数据源（不触发 markDirty）
    if (current !== initialValue) onChange(current, true);
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
    /** true 表示物品值是自由文本（名称）；false 表示物品值必须是 option 的映射值（ID）。 */
    itemFreeText = false,
  ): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "ke-cond-expr ke-cond-item";

    // 含逗号（多项）或无法解析为单条「物品 op 数值」时回退为纯文本输入，保留原文不丢失。
    // 数字部分用严格小数格式，避免把 "1..5" 之类误吞为单个数字
    const match = initialText.trim().match(/^(.+?)\s*([<>=!]+)\s*(\d+(?:\.\d+)?)$/);
    if (!match || !match[1] || !match[2] || !match[3] || initialText.includes(",")) {
      const fallback = document.createElement("input");
      fallback.type = "text";
      fallback.value = initialText;
      fallback.placeholder = "格式：物品 > 数量";
      fallback.addEventListener("input", () =>
        onChange(normalizeFullWidth(fallback.value)),
      );
      wrapper.appendChild(fallback);
      return wrapper;
    }

    let item = match[1].trim();
    let op: string = match[2];
    let num: string = match[3];

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
    }, false, "搜索物品…", itemFreeText);

    opSelect.addEventListener("change", sync);
    numInput.addEventListener("input", sync);

    wrapper.append(itemPicker, opSelect, numInput);
    return wrapper;
  }

  function mapOptions(): PickerOption[] {
    return (options?.maps ?? []).map((m) => ({ label: m.code, value: m.code }));
  }

  // —— 地图预设数据（选图后按需加载） ——
  let mapMobsCache: Promise<MapMobsData> | null = null;
  function loadMapMobs(): Promise<MapMobsData> {
    mapMobsCache ??= fetch("/ke/map-mobs.json", { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<MapMobsData>;
      })
      .catch((err: unknown) => {
        mapMobsCache = null;
        throw err;
      });
    return mapMobsCache;
  }

  // —— 选图后的「添加地图预设」询问浮层 ——

  /** 各规则文件的兜底行名称：自动添加的预设行插到它们之前，保证兜底行永远在文件末尾。 */
  const PRESET_FALLBACK_NAMES: Record<string, readonly string[]> = {
    "mon_control.txt": ["all_miniboss", "all_mvp", "all"],
    "pickupitems.txt": ["all"],
    "items_control.txt": ["all"],
  };

  /**
   * 最近一次应用过预设的地图。换图时据此清空上一张地图留下的规则行，
   * 保证规则表只反映当前挂机地图（换角色/换方案时重置）。
   */
  let appliedMapPreset: { code: string; entry: MapMobsEntry } | null = null;

  /**
   * 把预设行并入规则文件：跳过已存在的同名行（不覆盖用户已配的值），
   * 新行插入到兜底行（all / all_mvp / all_miniboss）之前。返回实际新增条数。
   */
  function insertPresetRows(file: string, newRows: ControlRow[]): number {
    const rows = (controlDoc[file] ??= []);
    const present = new Set(rows.map((row) => row.name));
    const fresh = newRows.filter((row) => !present.has(row.name));
    if (fresh.length === 0) return 0;
    const fallback = new Set(PRESET_FALLBACK_NAMES[file] ?? []);
    const boundary = rows.findIndex((row) => fallback.has(row.name));
    if (boundary < 0) rows.push(...fresh);
    else rows.splice(boundary, 0, ...fresh);
    return fresh.length;
  }

  /** 移除规则文件中名字在 names 里的行。返回移除条数。 */
  function removePresetRows(file: string, names: ReadonlySet<string>): number {
    if (names.size === 0) return 0;
    const rows = controlDoc[file];
    if (!rows) return 0;
    const kept = rows.filter((row) => !names.has(row.name));
    if (kept.length === rows.length) return 0;
    controlDoc[file] = kept;
    return rows.length - kept.length;
  }

  /**
   * 清空上一张地图预设写入、且新地图用不到的规则行（两张地图共有的行保留，
   * 避免动到用户已改的值）。nextMobs / nextItems 为新地图的怪物/掉落物 ID 集合；
   * 新地图无数据时传空集即全部清空。返回移除总数，调用方负责更新 appliedMapPreset。
   */
  function clearStalePresetRows(nextMobs: ReadonlySet<string>, nextItems: ReadonlySet<string>): number {
    if (!appliedMapPreset) return 0;
    const previous = appliedMapPreset.entry;
    let removed = removePresetRows(
      "mon_control.txt",
      new Set(previous.mobs.map(String).filter((name) => !nextMobs.has(name))),
    );
    const staleItems = new Set(
      previous.drops.map(String).filter((name) => !nextItems.has(name)),
    );
    removed += removePresetRows("pickupitems.txt", staleItems);
    removed += removePresetRows("items_control.txt", staleItems);
    return removed;
  }

  /** 应用地图预设：怪物 → 怪物规则（默认自动攻击），掉落物 → 拾取物品（拾取）+ 物品规则（默认值）。 */
  function applyMapPreset(code: string, entry: MapMobsEntry): void {
    const monSchema = CONTROL_SCHEMAS.find((s) => s.file === "mon_control.txt")!;
    const pickSchema = CONTROL_SCHEMAS.find((s) => s.file === "pickupitems.txt")!;
    const itemSchema = CONTROL_SCHEMAS.find((s) => s.file === "items_control.txt")!;
    // 换图时先清空上一张地图的预设行（仅删新图没有的，共有行原样保留）。
    let changed = clearStalePresetRows(
      new Set(entry.mobs.map(String)),
      new Set(entry.drops.map(String)),
    );
    changed += insertPresetRows(
      "mon_control.txt",
      entry.mobs.map((id) => ({ ...newControlRow(monSchema), name: String(id) })),
    );
    const itemRows = entry.drops.map((id) => String(id));
    changed += insertPresetRows(
      "pickupitems.txt",
      itemRows.map((name) => ({ ...newControlRow(pickSchema), name })),
    );
    changed += insertPresetRows(
      "items_control.txt",
      itemRows.map((name) => ({ ...newControlRow(itemSchema), name })),
    );
    appliedMapPreset = { code, entry };
    if (changed > 0) {
      markDirty();
      refreshAll();
    }
  }

  /**
   * 挂机地图选定后询问是否添加地图预设：怪物 → 怪物规则，掉落物 → 拾取物品与物品规则。
   * 换到无怪图（城镇等）时不询问，但会清空上一张地图的预设行；数据加载失败时静默跳过。
   */
  function askMapPreset(code: string, trigger: HTMLElement): void {
    void loadMapMobs()
      .then((data) => {
        const entry = data.maps[code];
        if (!entry || entry.mobs.length === 0) {
          // 换到无怪图（城镇等）：没有新预设可加，上一张地图的预设行直接清空。
          if (
            appliedMapPreset &&
            appliedMapPreset.code !== code &&
            clearStalePresetRows(new Set(), new Set()) > 0
          ) {
            appliedMapPreset = null;
            markDirty();
            refreshAll();
          }
          return;
        }
        openMapPresetDialog(code, entry, trigger);
      })
      .catch(() => {
        // 预设数据不可用时静默跳过：选图本身已成功，不影响手动配置。
      });
  }

  function openMapPresetDialog(
    code: string,
    entry: MapMobsEntry,
    trigger: HTMLElement,
  ): void {
    root.querySelector(".ke-preset-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "ke-preset-overlay";
    overlay.innerHTML = `
      <section class="ke-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="ke-preset-title">
        <h2 class="ke-preset-title" id="ke-preset-title">添加地图预设</h2>
        <p class="ke-preset-body"></p>
        <div class="ke-preset-mobs" role="list"></div>
        <div class="ke-preset-actions">
          <button type="button" class="ke-preset-yes">是，添加至预设</button>
          <button type="button" class="ke-preset-no">暂不添加</button>
        </div>
      </section>`;
    root.appendChild(overlay);

    const mapLabel = mapNames[code] ? `${mapNames[code]}（${code}）` : code;
    const body = overlay.querySelector<HTMLElement>(".ke-preset-body")!;
    body.append(
      document.createTextNode("已选定挂机地图 "),
      (() => {
        const strong = document.createElement("strong");
        strong.textContent = mapLabel;
        return strong;
      })(),
      document.createTextNode(
        `。这张地图上有 ${entry.mobs.length} 只怪物、${entry.drops.length} 件掉落物品。` +
        "是否将它们添加至预设？怪物会加入「怪物规则」，掉落物会加入「拾取物品」与「物品规则」（默认值，可随时在规则表中调整）。",
      ),
    );
    // 上一张地图的预设行会在确认后被清空，提前告知，避免规则悄悄变化。
    if (appliedMapPreset && appliedMapPreset.code !== code) {
      const previousCode = appliedMapPreset.code;
      const previousLabel = mapNames[previousCode]
        ? `${mapNames[previousCode]}（${previousCode}）`
        : previousCode;
      body.append(
        document.createTextNode(`上一张地图 ${previousLabel} 自动添加的规则将被清空。`),
      );
    }

    // 怪物名单预览：按 options.json 解析中文名，超出上限时折叠为「等 N 只」。
    const mobsEl = overlay.querySelector<HTMLElement>(".ke-preset-mobs")!;
    const MOB_CHIP_LIMIT = 24;
    entry.mobs.slice(0, MOB_CHIP_LIMIT).forEach((id) => {
      const chip = document.createElement("span");
      chip.className = "ke-preset-mob";
      chip.setAttribute("role", "listitem");
      chip.textContent = options?.monsters.find((m) => m.id === id)?.name ?? String(id);
      mobsEl.appendChild(chip);
    });
    if (entry.mobs.length > MOB_CHIP_LIMIT) {
      const more = document.createElement("span");
      more.className = "ke-preset-mob ke-preset-more";
      more.textContent = `…等 ${entry.mobs.length} 只`;
      mobsEl.appendChild(more);
    }

    const close = () => {
      overlay.remove();
      trigger.focus();
    };
    overlay.querySelector<HTMLButtonElement>(".ke-preset-yes")!.addEventListener("click", () => {
      applyMapPreset(code, entry);
      close();
    });
    overlay.querySelector<HTMLButtonElement>(".ke-preset-no")!.addEventListener("click", close);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    });
    overlay.querySelector<HTMLButtonElement>(".ke-preset-yes")!.focus();
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

  /** 图标映射就绪后异步抠掉洋红底再重绘角色卡；失败时保留原图/字首，不阻塞渲染。 */
  function refreshCharacterIcons(): void {
    if (characters.length === 0) return;
    void prewarmPticons(
      root.ownerDocument,
      characters.map((c) => c.job_id),
    ).then(() => {
      if (characters.length === 0) return;
      renderCharCard();
      renderCharacterStrip();
    });
  }

  function renderCharCard(): void {
    const character = selectedCharacter();
    if (!character) {
      charCard.hidden = true;
      return;
    }
    charCard.hidden = false;
    // 职业图标
    const src = iconSrc(character.job_id);
    if (src) {
      avatarImg.src = src;
      avatarImg.hidden = false;
      avatarFallback.hidden = true;
      charWm.src = src;
      charWm.hidden = false;
    } else {
      avatarImg.hidden = true;
      avatarFallback.hidden = false;
      avatarFallback.textContent = character.char_name.slice(0, 1) || "?";
      charWm.removeAttribute("src");
      charWm.hidden = true;
    }
    charName.textContent = character.char_name;
    avatarLive.hidden = !(character.last_seen_at > Date.now() - 5 * 60_000);
    const jobName =
      character.job_id !== null
        ? (options?.jobs_zh?.[String(character.job_id)] ??
          options?.jobs[String(character.job_id)])
        : undefined;
    jobChip.hidden = !jobName;
    jobChip.textContent = jobName ?? "";
    charMeta.replaceChildren();
    if (jobName) charMeta.appendChild(jobChip);
    if (character.map_name) {
      const mapChip = document.createElement("span");
      mapChip.className = "ke-chip ke-chip--map";
      mapChip.textContent = character.map_name;
      charMeta.appendChild(mapChip);
      const mapZh = mapNames[character.map_name];
      if (mapZh) {
        const zhChip = document.createElement("span");
        zhChip.className = "ke-chip ke-chip--map-zh";
        zhChip.textContent = mapZh;
        charMeta.appendChild(zhChip);
      }
    }
    if (character.last_seen_at) {
      const seenChip = document.createElement("span");
      seenChip.className = "ke-chip ke-chip--seen";
      seenChip.textContent = `最近在线 ${relativeTime(character.last_seen_at)}`;
      charMeta.appendChild(seenChip);
    }
    statChars.textContent = String(characters.length);
  }

  // —— Profile 列表 ——

  function renderProfiles(profiles: ProfileSummary[]): void {
    profilesHead.hidden = false;
    profileList.hidden = false;
    profileList.innerHTML = "";
    const ch = selectedCharacter();
    profilesWho.textContent = ch ? `${ch.char_name} · ${profiles.length} 套方案` : "";
    statProfiles.textContent = String(profiles.length);
    statActive.textContent = String(profiles.filter((p) => p.is_active).length);
    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ke-empty";
      empty.style.gridColumn = "1 / -1";
      const orbit = document.createElement("span");
      orbit.className = "ke-empty-orbit";
      orbit.textContent = "＋";
      const title = document.createElement("b");
      title.textContent = "该角色还没有配置方案";
      const sub = document.createElement("span");
      sub.textContent = "新建一套方案，选好挂机地图和技能，就能开始自动挂机。";
      const steps = document.createElement("div");
      steps.className = "ke-empty-steps";
      steps.innerHTML = "<span>① 选地图</span><span>② 选技能</span><span>③ 保存即激活</span>";
      empty.append(orbit, title, sub, steps);
      const btnRow = document.createElement("div");
      btnRow.className = "ke-empty-actions";
      const newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "ke-btn-primary";
      newBtn.textContent = "＋ 新建第一套方案";
      newBtn.addEventListener("click", () => {
        if (confirmDiscard()) window.location.assign(newProfileHref());
      });
      const hallBtn = document.createElement("a");
      hallBtn.className = "ke-btn-ghost ke-empty-hall";
      hallBtn.href = "/ke/hall";
      hallBtn.textContent = "一键抄袭大佬们的方案";
      btnRow.append(newBtn, hallBtn);
      empty.appendChild(btnRow);
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
      if (profile.sharing) {
        const sharing = document.createElement("div");
        sharing.className = "ke-profile-share-row";
        const state = document.createElement("span");
        state.textContent = profile.sharing.status === "PUBLISHED" ? "已共享" : "已撤回";
        const shareCode = document.createElement("span");
        shareCode.className = "ke-profile-share-code";
        shareCode.textContent = `分享码 ${profile.sharing.share_code}`;
        shareCode.dataset.shareCode = profile.sharing.share_code;
        sharing.append(state, shareCode);
        if (profile.sharing.status === "PUBLISHED") {
          const hallLink = document.createElement("a");
          hallLink.href = demo
            ? "/ke/hall?demo=1"
            : `/ke/hall?code=${encodeURIComponent(profile.sharing.share_code)}`;
          hallLink.textContent = demo ? "预览配置大厅" : "查看大厅";
          sharing.appendChild(hallLink);
        }
        const copyCode = document.createElement("button");
        copyCode.type = "button";
        copyCode.className = "ke-btn-ghost";
        copyCode.textContent = "复制分享码";
        copyCode.addEventListener("click", () => {
          void navigator.clipboard.writeText(profile.sharing!.share_code).then(
            () => { status.textContent = "分享码已复制。"; },
            () => { status.textContent = "复制失败，请手动复制分享码。"; },
          );
        });
        sharing.appendChild(copyCode);
        card.appendChild(sharing);
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
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ke-btn-ghost";
      copy.textContent = "复制";
      copy.addEventListener("click", (event) => {
        openCopyDialog(profile, event.currentTarget as HTMLElement);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ke-btn-danger";
      remove.textContent = "删除";
      remove.addEventListener("click", () => void deleteProfile(profile.id));
      actions.append(edit, copy, activate, remove);
      const meta = document.createElement("div");
      meta.className = "ke-profile-meta";
      meta.textContent = "CONFIG.TXT · 4 个规则文件";
      // 共享行在构建时已先插入，把方案名提到卡片最前，保证「名称 → 共享 → 档案 → 操作」的阅读顺序。
      card.prepend(name);
      card.append(meta, actions);
      profileList.appendChild(card);
    }
    const newCard = document.createElement("button");
    newCard.type = "button";
    newCard.className = "ke-profile-new";
    newCard.innerHTML =
      '<span class="ke-profile-new-ring">＋</span><b>新建方案</b><small>使用配置向导，几分钟完成</small>';
    newCard.addEventListener("click", () => {
      if (confirmDiscard()) window.location.assign(newProfileHref());
    });
    profileList.appendChild(newCard);
    const hallCard = document.createElement("a");
    hallCard.className = "ke-profile-hall";
    hallCard.href = "/ke/hall";
    hallCard.innerHTML =
      "<span>配置大厅</span><small>看看大佬们的方案</small>";
    profileList.appendChild(hallCard);
  }

  // —— 复制方案到其他角色 ——

  function uniqueProfileName(base: string, taken: readonly string[]): string {
    const limit = 64;
    const clean = base.trim().slice(0, limit) || "复制的方案";
    if (!taken.includes(clean)) return clean;
    for (let n = 1; n < 100; n += 1) {
      const suffix = n === 1 ? "（副本）" : `（副本 ${n}）`;
      const candidate = `${clean.slice(0, Math.max(1, limit - suffix.length))}${suffix}`;
      if (!taken.includes(candidate)) return candidate;
    }
    return `${clean.slice(0, 50)}（副本 ${Date.now()}）`.slice(0, limit);
  }

  /** 把 sourceId 的方案完整复制到 target 角色名下（不会带走共享状态）。 */
  async function duplicateProfile(
    sourceId: number,
    target: KeCharacter,
  ): Promise<string> {
    if (demo) {
      const source = demoProfiles.find((profile) => profile.id === sourceId);
      if (!source) throw new Error("找不到这套演示方案，请刷新后重试。");
      const targetProfiles = demoProfiles.filter(
        (profile) =>
          profile.aid === target.aid &&
          profile.cid === target.cid &&
          profile.nid === target.nid,
      );
      const name = uniqueProfileName(
        source.name,
        targetProfiles.map((profile) => profile.name),
      );
      const id = Math.max(0, ...demoProfiles.map((profile) => profile.id)) + 1;
      demoProfiles = [
        ...demoProfiles,
        {
          ...source,
          id,
          aid: target.aid,
          cid: target.cid,
          nid: target.nid,
          name,
          is_active: false,
          sharing: null,
        },
      ];
      return name;
    }
    const [source, targetProfiles] = await Promise.all([
      keFetch<ProfileDetail>(`/api/v1/ke/profiles/${sourceId}`),
      keFetch<{ profiles: ProfileSummary[] }>(
        `/api/v1/ke/profiles?aid=${target.aid}&cid=${target.cid}&nid=${target.nid}`,
      ),
    ]);
    const name = uniqueProfileName(
      source.name,
      targetProfiles.profiles.map((profile) => profile.name),
    );
    await keFetch<{ id: number }>("/api/v1/ke/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aid: target.aid,
        cid: target.cid,
        nid: target.nid,
        name,
        config_text: source.config_text,
        mon_control: source.mon_control ?? "",
        pickupitems: source.pickupitems ?? "",
        items_control: source.items_control ?? "",
        timeouts: source.timeouts,
      }),
    });
    return name;
  }

  const copyOverlay = document.createElement("div");
  copyOverlay.className = "ke-copy-overlay";
  copyOverlay.hidden = true;
  copyOverlay.innerHTML = `
    <section class="ke-copy-dialog" role="dialog" aria-modal="true" aria-labelledby="ke-copy-title">
      <h2 class="ke-copy-title" id="ke-copy-title">复制方案到其他角色</h2>
      <p class="ke-copy-sub" id="ke-copy-sub"></p>
      <div class="ke-copy-list" id="ke-copy-list" role="list"></div>
      <p class="ke-copy-error" id="ke-copy-error" role="alert" hidden></p>
      <div class="ke-copy-actions">
        <button type="button" class="ke-btn-ghost" id="ke-copy-cancel">取消</button>
        <button type="button" class="ke-btn-primary" id="ke-copy-confirm">确认复制</button>
      </div>
    </section>`;
  root.appendChild(copyOverlay);
  const copyList = copyOverlay.querySelector<HTMLElement>("#ke-copy-list")!;
  const copySub = copyOverlay.querySelector<HTMLElement>("#ke-copy-sub")!;
  const copyError = copyOverlay.querySelector<HTMLElement>("#ke-copy-error")!;
  const copyCancel =
    copyOverlay.querySelector<HTMLButtonElement>("#ke-copy-cancel")!;
  const copyConfirm =
    copyOverlay.querySelector<HTMLButtonElement>("#ke-copy-confirm")!;
  let copySourceId: number | null = null;
  let copyTargetKey: string | null = null;
  let copyTrigger: HTMLElement | null = null;

  function renderCopyTargets(): void {
    const ch = selectedCharacter();
    copyTargetKey = null;
    copyConfirm.disabled = true;
    copyList.replaceChildren();
    const others = characters.filter(
      (c) =>
        !ch || `${c.aid}:${c.cid}:${c.nid}` !== `${ch.aid}:${ch.cid}:${ch.nid}`,
    );
    if (others.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ke-copy-empty";
      empty.textContent = "当前账号没有其他已绑定角色，暂时无处可复制。";
      copyList.appendChild(empty);
      return;
    }
    for (const c of others) {
      const key = `${c.aid}:${c.cid}:${c.nid}`;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ke-copy-char";
      row.setAttribute("role", "listitem");
      row.dataset.key = key;
      const src = iconSrc(c.job_id);
      if (src) {
        const icon = document.createElement("img");
        icon.alt = "";
        icon.className = "ke-copy-char-icon";
        icon.src = src;
        row.appendChild(icon);
      } else {
        const fallback = document.createElement("span");
        fallback.className = "ke-copy-char-icon-fallback";
        fallback.textContent = c.char_name.slice(0, 1) || "?";
        row.appendChild(fallback);
      }
      const text = document.createElement("span");
      text.className = "ke-copy-char-text";
      const name = document.createElement("span");
      name.className = "ke-copy-char-name";
      name.textContent = c.char_name;
      const job = document.createElement("span");
      job.className = "ke-copy-char-job";
      job.textContent =
        options?.jobs_zh?.[String(c.job_id)] ??
        options?.jobs[String(c.job_id)] ??
        "未知职业";
      text.append(name, job);
      row.appendChild(text);
      row.addEventListener("click", () => {
        copyTargetKey = key;
        copyConfirm.disabled = false;
        for (const item of Array.from(
          copyList.querySelectorAll<HTMLElement>(".ke-copy-char"),
        )) {
          item.classList.toggle("is-on", item.dataset.key === key);
        }
      });
      copyList.appendChild(row);
    }
  }

  function closeCopyDialog(): void {
    copyOverlay.hidden = true;
    copySourceId = null;
    copyTargetKey = null;
    copyTrigger?.focus();
    copyTrigger = null;
  }

  function openCopyDialog(profile: ProfileSummary, trigger: HTMLElement): void {
    copySourceId = profile.id;
    copyTrigger = trigger;
    copyError.hidden = true;
    copySub.textContent = `把「${profile.name}」完整复制到所选角色名下，包括 config.txt 与全部规则文件；复制不会带走共享状态。`;
    renderCopyTargets();
    copyOverlay.hidden = false;
    copyCancel.focus();
  }

  async function confirmCopy(): Promise<void> {
    const target = characters.find(
      (c) => `${c.aid}:${c.cid}:${c.nid}` === copyTargetKey,
    );
    if (copySourceId === null || !target) {
      copyError.hidden = false;
      copyError.textContent = "请先选择要复制到的角色。";
      return;
    }
    copyError.hidden = true;
    copyConfirm.disabled = true;
    copyConfirm.textContent = "复制中…";
    try {
      const name = await duplicateProfile(copySourceId, target);
      closeCopyDialog();
      status.textContent = `已复制到「${target.char_name}」：${name}`;
    } catch (error) {
      copyError.hidden = false;
      copyError.textContent =
        error instanceof Error ? error.message : "复制失败";
      copyConfirm.disabled = false;
    } finally {
      copyConfirm.textContent = "确认复制";
    }
  }

  copyCancel.addEventListener("click", closeCopyDialog);
  copyConfirm.addEventListener("click", () => void confirmCopy());
  copyOverlay.addEventListener("mousedown", (event) => {
    if (event.target === copyOverlay) closeCopyDialog();
  });
  copyOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeCopyDialog();
    }
  });

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
      // legacy 兼容键（如 sitAuto_over_50）不展示，只在解析/序列化时保留。
      const scalars = CONFIG_SCALARS.filter((s) => s.group === group && !s.legacy);
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
        false,
        "搜索并选择…",
        true, // 物品名是自由文本：输入/清空必须同步（teleportAuto_item1 清空修复）
      );
      field.appendChild(picker);
      return field;
    }
    if (scalar.type === "maps") {
      const editor = createMapChipsEditor(
        configDoc.scalars[scalar.key] ?? "",
        (csv) => {
          configDoc.scalars[scalar.key] = csv;
          markDirty();
          updatePreview();
        },
      );
      field.appendChild(editor);
      return field;
    }
    if (scalar.type === "map") {
      // 输入框显示中文名，配置里始终保存地图代码；@picker worldmap 额外提供「选择地图」按钮。
      const row = document.createElement("div");
      row.className = "ke-mapline";
      const picker = createMapPicker(configDoc.scalars[scalar.key] ?? "", (code) => {
        configDoc.scalars[scalar.key] = code;
        markDirty();
        updatePreview();
      });
      row.appendChild(picker.root);
      if (scalar.picker === "worldmap") {
        const pickBtn = document.createElement("button");
        pickBtn.type = "button";
        pickBtn.className = "ke-btn-ghost ke-wmap-open";
        pickBtn.textContent = "选择地图";
        pickBtn.addEventListener("click", () => {
          openWorldmapPicker(root, {
            title: scalar.label,
            value: configDoc.scalars[scalar.key] ?? "",
            onSelect: (code) => {
              const previous = configDoc.scalars[scalar.key] ?? "";
              picker.setValue(code);
              configDoc.scalars[scalar.key] = code;
              markDirty();
              updatePreview();
              // 挂机地图选定后，询问是否把该图怪物/掉落物加入预设（回城地图不询问）。
              if (scalar.key === "lockMap" && code !== "" && code !== previous) {
                askMapPreset(code, pickBtn);
              }
            },
            trigger: pickBtn,
          });
        });
        row.appendChild(pickBtn);
      }
      field.appendChild(row);
      return field;
    }
    const input = document.createElement("input");
    input.type = scalar.type === "int" ? "number" : "text";
    input.inputMode = scalar.type === "int" ? "decimal" : "text";
    input.step = "any";
    input.placeholder = scalar.default ?? "未设置";
    input.value = configDoc.scalars[scalar.key] ?? "";
    input.addEventListener("input", () => {
      // 全角符号/数字即时转半角，用户能直接看到输入被修正（替换后保持光标位置）。
      const value = normalizeFullWidth(input.value);
      if (value !== input.value) {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = value;
        // type=number 不支持 selectionStart/SetRange，需跳过以免抛错。
        if (start !== null && end !== null && input.type !== "number") {
          input.setSelectionRange(start, end);
        }
      }
      configDoc.scalars[scalar.key] = value;
      markDirty();
      updatePreview();
    });
    if (scalar.suffix) {
      const affix = document.createElement("div");
      affix.className = "ke-affix";
      affix.appendChild(input);
      affix.appendChild(suffixEl(scalar.suffix));
      field.appendChild(affix);
    } else {
      field.appendChild(input);
    }
    return field;
  }

  // —— 技能分区（block 卡片） ——

  function renderSkillsTab(entry: NavEntry): void {
    const isMainSkillTab = entry.id === "skills";
    const tabHint = BLOCK_TAB_HINTS[entry.id];
    if (tabHint) {
      const hintEl = document.createElement("p");
      hintEl.className = "ke-hint";
      hintEl.style.margin = "4px 0 0";
      hintEl.textContent = tabHint;
      tabPanels.appendChild(hintEl);
    }
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
    const smartScalars = isMainSkillTab ? CONFIG_SCALARS.filter((s) => s.group === "技能" && !s.legacy) : [];
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

  /** 正在拖拽的 block（同类型卡片之间才允许 drop）。 */
  let blockDragState: { type: string; block: BlockValue } | null = null;

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
    const tail = document.createElement("span");
    tail.className = "ke-b-tail";

    // —— 排序：KE 先到先得，上面的卡片优先执行。提供 ↑↓ 按钮 + 拖拽把手。 ——
    const moveBlock = (delta: number): void => {
      const arr = configDoc.blocks[def.type];
      if (!arr) return;
      const idx = arr.indexOf(block);
      const target = idx + delta;
      if (idx < 0 || target < 0 || target >= arr.length) return;
      arr.splice(idx, 1);
      arr.splice(target, 0, block);
      markDirty();
      updatePreview();
      renderActivePanel();
    };
    const mkMove = (
      label: string,
      delta: number,
      title: string,
    ): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ke-block-move";
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        moveBlock(delta);
      });
      return btn;
    };
    const grip = document.createElement("span");
    grip.className = "ke-block-grip";
    grip.textContent = "⠿";
    grip.title = "拖拽调整顺序（排在上面的卡片优先执行）";
    grip.draggable = true;
    grip.addEventListener("dragstart", (ev) => {
      blockDragState = { type: def.type, block };
      ev.dataTransfer?.setData("text/plain", def.type);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
    });
    grip.addEventListener("dragend", () => {
      blockDragState = null;
    });
    card.addEventListener("dragover", (ev) => {
      if (!blockDragState || blockDragState.type !== def.type) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      card.classList.toggle("is-drop-before", before);
      card.classList.toggle("is-drop-after", !before);
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("is-drop-before", "is-drop-after");
    });
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      card.classList.remove("is-drop-before", "is-drop-after");
      if (!blockDragState || blockDragState.type !== def.type) return;
      const arr = configDoc.blocks[def.type];
      if (!arr) {
        blockDragState = null;
        return;
      }
      const from = arr.indexOf(blockDragState.block);
      let to = arr.indexOf(block);
      if (from < 0 || to < 0) {
        blockDragState = null;
        return;
      }
      const rect = card.getBoundingClientRect();
      if (ev.clientY >= rect.top + rect.height / 2) to += 1;
      arr.splice(from, 1);
      if (from < to) to -= 1;
      arr.splice(to, 0, blockDragState.block);
      blockDragState = null;
      markDirty();
      updatePreview();
      renderActivePanel();
    });
    tail.appendChild(grip);
    tail.appendChild(
      mkMove("↑", -1, `上移这条${def.label}（提高优先级，更早被检查）`),
    );
    tail.appendChild(
      mkMove("↓", 1, `下移这条${def.label}（降低优先级，更晚被检查）`),
    );

    const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chev.setAttribute("class", "ke-chev");
    chev.setAttribute("width", "14");
    chev.setAttribute("height", "14");
    chev.setAttribute("viewBox", "0 0 24 24");
    chev.setAttribute("fill", "none");
    chev.setAttribute("stroke", "currentColor");
    chev.setAttribute("stroke-width", "2");
    chev.innerHTML = '<path d="M6 9l6 6 6-6"/>';
    tail.appendChild(chev);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ke-block-del";
    delBtn.setAttribute("aria-label", `删除 ${def.label}`);
    delBtn.title = `删除这条${def.label}规则`;
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // confirm 在 jsdom 等无头环境可能不存在，此时跳过确认直接删
      if (typeof confirm === "function" && !confirm(`确认删除这条${def.label}规则吗？`)) return;
      const arr = configDoc.blocks[def.type];
      if (arr) {
        const idx = arr.indexOf(block);
        if (idx >= 0) arr.splice(idx, 1);
      }
      card.remove();
      markDirty();
      updatePreview();
      updateNavCounts();
    });
    tail.appendChild(delBtn);
    head.appendChild(tail);
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
      if (def.selectorKind === "monsters") {
        field.appendChild(
          helpTip(
            "触发怪物",
            "遇到这些怪物时自动切这套装备（逗号分隔，如：High Orc, Black Mushroom）。",
          ),
        );
        field.appendChild(
          createMonsterChipsEditor(
            block.selector ?? "",
            (csv, silent) => {
              block.selector = csv;
              if (!silent) markDirty();
              updatePreview();
              renderFields();
            },
            "未指定，对所有怪物生效",
          ),
        );
      } else {
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
        }, false, "搜索并选择…", def.selectorKind === "item"); // 物品名自由文本；技能存 ID 仅选项提交
        field.appendChild(picker);
      }
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
          (csv, silent) => {
            if (csv === "") delete block.fields[fieldDef.key];
            else block.fields[fieldDef.key] = csv;
            if (!silent) markDirty();
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
          false,
          "搜索并选择…",
          true, // 装备槽位接受物品 ID/名称/片段，自由文本
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
      block.fields[fieldDef.key] = normalizeFullWidth(input.value);
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
      function setValue(value: string, silent = false): void {
        const normalized = normalizeFullWidth(value);
        if (normalized === "") delete block.conditions[currentKey];
        else block.conditions[currentKey] = normalized;
        if (!silent) markDirty();
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
            createItemAmountEditor(currentValue, setValue, itemNameOptions(), true),
          );
        } else if (widget === "itemAmountId") {
          valueSlot.appendChild(
            createItemAmountEditor(currentValue, setValue, itemOptions()),
          );
        } else if (widget === "map") {
          valueSlot.appendChild(
            createPicker(mapOptions(), currentValue, setValue, false, "搜索地图…", true),
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
      // 预填各列默认值，保证新行即便用户不动也能序列化为合法的最小参数行。
      rows.push(newControlRow(schema));
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
      const specialOptions: PickerOption[] = isMonster
        ? [
            {
              label: "all（所有怪物兜底）",
              value: "all",
            },
            {
              label: "all_mvp（所有 MVP）",
              value: "all_mvp",
            },
            {
              label: "all_miniboss（所有小 Boss）",
              value: "all_miniboss",
            },
          ]
        : [{ label: "all（所有物品兜底）", value: "all" }];
      const picker = createPicker(
        [...specialOptions, ...base],
        row.name,
        (value) => {
          row.name = normalizeFullWidth(value);
          syncName();
          markDirty();
          updateSideStats();
          updatePreview();
        },
        false,
        isMonster
          ? "搜索怪物，或输入名称 / class id / 通配符（兽人*、Por*g）/ all / all_mvp / all_miniboss…"
          : "搜索物品，或输入名称 / item id / 通配符（红*药、*药草）/ all…",
        true, // 全部支持自由文本：数字 ID、中文名称、通配符 * ?、保留名 all / all_mvp / all_miniboss
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
      values[column.key] = normalizeFullWidth(input.value);
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
    const segOptions: SegOption[] = (column.options ?? []).map((o) => ({
      value: o.value,
      label: o.label,
      hint: o.hint ?? column.help,
    }));
    const raw = values[column.key] ?? "";
    return segEl(
      segOptions,
      raw,
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
      values[column.key] = normalizeFullWidth(input.value);
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
    appliedMapPreset = null;
    editorTitle.textContent = id === null ? "新建方案" : "编辑方案";
    if (id === null) {
      sharingControls.reset(null);
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
    if (demo) {
      const profile = demoProfiles.find((item) => item.id === id);
      if (!profile) {
        editor.hidden = true;
        status.textContent = "找不到这套演示方案，请刷新后重试。";
        return;
      }
      sharingControls.reset(profile.sharing ?? null);
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
        controlDoc[schema.file] = parseControl(schema, profileText[schema.file] ?? "");
      ensureAllFallback(controlDoc);
      if ((controlDoc["timeouts.txt"] ?? []).length === 0) fillTimeoutRows();
      clearDirty();
      renderNav();
      renderActivePanel();
      refreshAll();
      status.textContent = "演示方案已在内存中打开；操作不会写入账号。";
      return;
    }
    status.textContent = "正在加载方案…";
    try {
      const profile = await keFetch<ProfileDetail>(`/api/v1/ke/profiles/${id}`);
      sharingControls.reset(profile.sharing ?? null);
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
    if (demo) {
      renderProfiles(demoProfilesForSelected());
      return;
    }
    const query = `aid=${character.aid}&cid=${character.cid}&nid=${character.nid}`;
    const body = await keFetch<{ profiles: ProfileSummary[] }>(
      `/api/v1/ke/profiles?${query}`,
    );
    renderProfiles(body.profiles);
  }

  async function withdrawSharing(): Promise<void> {
    if (editingId === null || !window.confirm("撤回后，其他玩家将无法在配置大厅查看或复制这套配置。已复制到他人账号的方案不受影响。确定撤回吗？")) return;
    sharingControls.setBusy(true);
    sharingControls.message("正在撤回共享配置…");
    try {
      if (demo) {
        const profile = demoProfiles.find((item) => item.id === editingId);
        if (profile?.sharing) {
          profile.sharing = { ...profile.sharing, status: "WITHDRAWN", updated_at: Date.now() };
          sharingControls.markWithdrawn();
          sharingControls.message("演示中已撤回；实际账号和共享条目没有变化。");
          renderProfiles(demoProfilesForSelected());
        }
        return;
      }
      await keFetch<void>(`/api/v1/ke/profiles/${editingId}/sharing`, { method: "DELETE" });
      sharingControls.markWithdrawn();
      sharingControls.message("已撤回。保存时重新勾选可恢复原分享码。");
      await reloadProfiles();
    } catch (error) {
      sharingControls.message(error instanceof Error ? error.message : "撤回失败");
    } finally {
      sharingControls.setBusy(false);
    }
  }

  async function activateProfile(id: number): Promise<void> {
    if (demo) {
      // 激活只影响当前角色，其他角色的激活状态保持不变。
      const ch = selectedCharacter();
      demoProfiles = demoProfiles.map((profile) =>
        ch && profile.aid === ch.aid && profile.cid === ch.cid && profile.nid === ch.nid
          ? { ...profile, is_active: profile.id === id }
          : profile,
      );
      renderProfiles(demoProfilesForSelected());
      status.textContent = "已在演示中模拟激活；不会写入账号。";
      return;
    }
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
    if (demo) {
      demoProfiles = demoProfiles.filter((profile) => profile.id !== id);
      if (editingId === id) hideForm();
      renderProfiles(demoProfilesForSelected());
      status.textContent = "演示方案已从本次预览移除；刷新后会恢复。";
      return;
    }
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
    // 同步校验 control 文件：每行必须选择对象且必填列齐全（items≥4 项、pickup≥2 项、mon≥2 项）。
    const controlErrors = validateControlDoc(controlDoc);
    const allErrors = [...configErrors, ...controlErrors];
    if (allErrors.length > 0) {
      formError.hidden = false;
      formError.textContent =
        `发现 ${allErrors.length} 处配置问题，请修正后再保存：\n` +
        allErrors.map((message, index) => `${index + 1}. ${message}`).join("\n");
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
      sharing: sharingControls.value(),
    };
    sharingControls.setBusy(true);
    try {
      if (demo) {
        const existing = demoProfiles.find((profile) => profile.id === editingId);
        const id = editingId ?? Math.max(0, ...demoProfiles.map((profile) => profile.id)) + 1;
        const currentSharing = existing?.sharing ?? null;
        const sharing: ProfileSharingMetadata | null = values.sharing.enabled
          ? {
            id: currentSharing?.id ?? id,
            share_code: currentSharing?.share_code ?? `DEM-${String(id).padStart(4, "0")}`,
            status: "PUBLISHED",
            updated_at: Date.now(),
            description: values.sharing.description ?? "",
          }
          : currentSharing;
        const demoProfile: ProfileDetail = {
          id, aid: character.aid, cid: character.cid, nid: character.nid,
          name: values.name, is_active: existing?.is_active ?? false, sharing,
          config_text: values.config_text, mon_control: values.mon_control,
          pickupitems: values.pickupitems, items_control: values.items_control,
          timeouts: values.timeouts,
        };
        const existingIndex = demoProfiles.findIndex((profile) => profile.id === id);
        if (existingIndex === -1) demoProfiles = [...demoProfiles, demoProfile];
        else demoProfiles[existingIndex] = demoProfile;
        hideForm();
        renderProfiles(demoProfilesForSelected());
        status.textContent = "仅在演示中模拟保存；刷新后恢复，未写入账号。";
        return;
      }
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
    } finally {
      sharingControls.setBusy(false);
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
    syncPreviewVisibility();
  });
  previewAdv.addEventListener("click", () => {
    advancedEdit = !advancedEdit;
    previewCollapsed = false;
    updatePreview();
    syncPreviewVisibility();
    if (advancedEdit) previewEditor.focus();
  });
  previewEditor.addEventListener("input", applyPreviewEdit);
  previewEditor.addEventListener("blur", () => {
    // 失焦时把文本规范化（去掉注释/无法识别的键），与表单模型保持一致。
    const content = currentPreview();
    preview.textContent =
      content.text === "" ? content.emptyText : content.text;
    previewEditor.value = content.text;
  });
  syncPreviewVisibility();
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

  // —— 初始化 ——

  async function init(): Promise<void> {
    options = await keFetch<KeOptions>("/ke/options.json").catch(() => null);
    // 中文地图名表：缺失时退化为直接显示地图代码，不影响手动填写。
    const mapNamesFile = await keFetch<MapNamesFile>("/ke/mapnames.json").catch(() => null);
    mapNames = mapNamesFile?.names ?? {};
    mapCodeByName = new Map(
      Object.entries(mapNames).map(([code, name]) => [name, code]),
    );
    if (demo) {
      root.querySelector<HTMLElement>("#ke-demo-chip")!.hidden = false;
      characters = buildDemoCharacters();
      demoProfiles = buildDemoProfiles(options);
      const first = characters[0]!;
      selectedKey = `${first.aid}:${first.cid}:${first.nid}`;
      selectedJobId = first.job_id ?? null;
      renderCharacterStrip();
      renderCharCard();
      status.textContent = "演示模式：示例数据只在当前页面模拟，不会写入账号。";
      renderProfiles(demoProfilesForSelected());
      refreshCharacterIcons();
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
      const query = new URLSearchParams(window.location.search);
      const target = characters.find((character) => character.aid === Number(query.get("aid"))
        && character.cid === Number(query.get("cid")) && character.nid === Number(query.get("nid"))) ?? characters[0]!;
      selectedKey = `${target.aid}:${target.cid}:${target.nid}`;
      selectedJobId = target.job_id ?? null;
      status.textContent = "";
      renderCharacterStrip();
      renderCharCard();
      refreshCharacterIcons();
      await reloadProfiles();
      const requestedProfile = Number(query.get("profile"));
      if (Number.isSafeInteger(requestedProfile) && requestedProfile > 0) {
        const profileList = await keFetch<{ profiles: ProfileSummary[] }>(`/api/v1/ke/profiles?aid=${target.aid}&cid=${target.cid}&nid=${target.nid}`);
        if (profileList.profiles.some((profile) => profile.id === requestedProfile)) await openEditor(requestedProfile);
      }
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
