// 职业数据构建：从 /ke/options.json 推导每个职业的挂机参数（远程判定 / 坐骑 / 生存档位 / 技能池）。
// 纯逻辑，不依赖 DOM 与页面状态，可脱离游戏账号做全职业覆盖测试。

export type AuxCat = "buff" | "ground" | "heal" | "survival";
export type SurvKind = "tank" | "healer" | "ranged" | "caster" | "melee";
export type JobScope = "self" | "other";

export interface JobCond {
  k: string;
  v: string;
}
export interface AuxSeed {
  n: string;
  c: AuxCat;
}
export interface JobData {
  name: string;
  ranged: boolean;
  surv: SurvKind;
  mount: false | "combat";
  mountSkill: boolean;
  atk: string[];
  aux: AuxSeed[];
}
export interface AuxPresetScope {
  on?: boolean;
  conds?: JobCond[];
}
export interface AuxPreset {
  re: RegExp;
  cat: AuxCat;
  scopes: Partial<Record<JobScope, AuxPresetScope>>;
}
export interface JobSkillOpt {
  id: number;
  name?: string;
  nameZh?: string;
  handle?: string;
}
export interface JobOptions {
  jobs?: Record<string, string>;
  jobs_zh?: Record<string, string>;
  skills?: JobSkillOpt[];
  job_skills?: Record<string, number[]>;
  job_skill_groups?: Record<string, Record<string, number[]>>;
}
/** skill-types.json 的技能分类表：handle → 'active' | 'passive' | 'Quest' | '—' 等。 */
export type SkillKinds = Record<string, string>;

// 辅助技能预设表：按技能语义统一预设施放规则（类别 / 启用范围 / 条件），首个命中的生效；
// 未命中的技能回落 baseConds 类别通用默认。%NAME% 占位 = 技能自身的状态名。
export const AUX_PRESETS: AuxPreset[] = [
  { re: /治愈|治疗/, cat: "heal", scopes: {
    self: { on: true, conds: [{ k: "hp", v: "< 70%" }, { k: "timeout", v: "1" }] },
    other: { on: true, conds: [{ k: "target_hp", v: "< 70%" }, { k: "timeout", v: "1" }] } } },
  { re: /隐匿|隐身|伪装|遁/, cat: "survival", scopes: {
    self: { on: true, conds: [{ k: "hp", v: "< 35%" }, { k: "aggressives", v: ">= 2" }] },
    other: { on: false } } },
  // 服侍系「瞬间移动」属于逃生位移技，归辅助池保命类，不再占用攻击技能卡池
  { re: /瞬间移动/, cat: "survival", scopes: {
    self: { on: true, conds: [{ k: "hp", v: "< 40%" }, { k: "aggressives", v: ">= 2" }] },
    other: { on: false } } },
  { re: /涂毒|狂暴|速度激发|强化|集中/, cat: "buff", scopes: {
    self: { on: true }, other: { on: false } } },
  { re: /加速|祝福|天使|圣母|颂歌|神威|幸运|洒水/, cat: "buff", scopes: {
    self: { on: true },
    other: { on: true, conds: [{ k: "target_whenStatusInactive", v: "%NAME%" }, { k: "timeout", v: "10" }] } } },
  { re: /光耀|领域|障壁/, cat: "ground", scopes: {
    self: { on: true }, other: { on: false } } },
  { re: /冥想/, cat: "buff", scopes: {
    self: { on: true, conds: [{ k: "sp", v: "< 50%" }, { k: "timeout", v: "5" }] },
    other: { on: false } } },
];

// 内置演示职业表：options.json 加载失败时回退（与原型一致）。
export const FALLBACK_JOBS: Record<string, JobData> = {
  "3": { name: "弓箭手", ranged: true, surv: "ranged", mount: false, mountSkill: false,
    atk: ["二连矢", "冲锋箭", "箭雨", "三角射击"],
    aux: [{ n: "伪装", c: "survival" }, { n: "集中", c: "buff" }] },
  "6": { name: "盗贼", ranged: false, surv: "melee", mount: false, mountSkill: false,
    atk: ["施毒", "投掷石块"],
    aux: [{ n: "隐匿", c: "survival" }, { n: "伪装", c: "survival" }] },
  "7": { name: "骑士", ranged: false, surv: "tank", mount: "combat", mountSkill: true,
    atk: ["骑乘攻击", "连刺攻击"],
    aux: [{ n: "挑衅", c: "survival" }, { n: "霸体", c: "buff" }] },
  "11": { name: "猎人", ranged: true, surv: "ranged", mount: false, mountSkill: false,
    atk: ["二连矢", "冲锋箭", "箭雨", "驯狼术"],
    aux: [{ n: "伪装", c: "survival" }, { n: "集中", c: "buff" }] },
};
export const CAT_ORDER: Record<AuxCat, number> = { survival: 0, buff: 1, ground: 2, heal: 3 };

// 真实 options.json 的 job_skill_groups 只有「通用/一转/二转」这类分段名，没有原型里
// 「远程/攻击/治疗/增益」的语义分组，因此真实数据下按职业族 + 技能名归类，保持与原型相同的取舍：
// 远程（弓/枪/诗人/舞娘系）、治疗（服事系）、施法（法系）、坐骑（骑士/十字军/守护系）。
const JOB_RANGED_RE = /Archer|Hunter|Sniper|Ranger|Windhawk|Bard|Clown|Minstrel|Troubadour|Dancer|Gypsy|Wanderer|Trouvere|Gunslinger|Rebellion|Mercenary Archer|弓箭手|猎人|神射手|游侠|诗人|吟游诗人|舞娘|神枪手|反叛者|宫廷乐师|风鹰/;
const JOB_HEALER_RE = /Acolyte|Priest|Bishop|Cardinal|Monk|Champion|Sura|Inquisitor|服侍|服事|牧师|祭司|主教|武僧|修罗|修士/;
const JOB_CASTER_RE = /Mage|Magician|Wizard|Sage|Professor|Sorcerer|Warlock|Arch Mage|Elemental Master|Ninja|Kagerou|Oboro|Soul Linker|Soul Reaper|Summoner|魔法师|巫师|贤者|教授|术士|咒术师|忍者|影狼|胧|灵术师|魂之收割者|召唤师|元素大师|大法师/;
const JOB_MOUNT_RE = /Knight|Crusader|Paladin|Guard|骑士|十字军|圣殿|皇家/;
// 被动/功能技能不划进攻击技能池（修炼、制作、商店、制作箭等功能技放进 attackSkillSlot 只会浪费 SP）
const PASSIVE_SKILL_RE = /基本技能|紧急治疗|熟练度|修炼|掌握|之眼|快速恢复|禅心|移动时恢复|攻击弱点|Selfprovoke|负重量|低价买进|高价卖出|手推车|物品鉴定|露天商店|开设购买商店|大声呐喊|制作|制造|研究|保有|寻找矿石|修理|强化火属性|贪婪|抄袭|偷窃|偷钱|捡石头|解毒|解除|卸除|陷阱探查|陷阱移除|涂鸦|旗帜|清洗|约束|强制减价|胁持|认养|召唤魔物|变换成|升级|完全恢复|死亡|灵魂|跑步|准备|加油|温暖的风|跳高|太拳任务|宿命|死身|问号|GRAVITY|属性附加|属性更换|宠物|进化之书|取消施法|魔法惩罚|念咒拆除|自由施法|自动念咒|随机技能|装填|装满硬币|命中率递增|终极闪躲|飞刀修炼|残影|毒性反弹|移花接木|六合拳|吸魂术|猎鹰突击|被动/;
// options.json 没有被动标记，以下按 handle 补充常见被动（名称不一定命中上面的正则）。
const PASSIVE_SKILL_HANDLES = new Set([
  "SM_SWORD", "SM_TWOHAND", "SM_RECOVERY", "SM_MOVINGRECOVERY", "SM_FATALBLOW",
  "MC_INCCARRY", "AC_OWL", "AC_VULTURE", "MG_SRECOVERY", "SM_AUTOBERSERK",
  "KN_SPEARMASTERY", "KN_TWOHANDQUICKEN", "KN_CAVALIERMASTERY", "KN_ONEHAND",
  "PR_MACEMASTERY", "AS_RIGHT", "AS_LEFT", "AS_KATAR", "ASC_KATAR",
  "AM_AXEMASTERY", "SA_FULLRECOVERY", "LK_TENSIONRELAX", "HW_MAGICPOWER",
  "GS_BULLSEYE", "GS_SNAKEEYE", "NJ_TOBIDOUGU", "NJ_NINPOU", "DE_RESET",
  "NPC_GRADUAL_GRAVITY", "RK_REFRESH", "NC_TRAININGAXE",
  "SO_STRIKING", "GN_TRAINING_SWORD", "KO_RIGHT", "KO_LEFT", "KO_ZANZOU",
  "HFLI_FLEET", "MER_REGAIN", "EL_PYROTECHNIC", "EL_GUST", "GD_GUARDUP",
  "TF_MISS", "AS_POISONREACT", "MO_TRIPLEATTACK", "MO_DODGE", "HW_SOULDRAIN",
  "HT_BLITZBEAT",
]);
// 名字明确是攻击技的（避免「天使」类预设把 天使之击/天使之光 误判成增益）
const ATTACK_NAME_RE = /(之击|攻击)$|天使之光|隐身攻击|毒刃|音速投掷|超音速投掷|强酸火烟瓶投掷/;

export function presetOf(name: string): AuxPreset | null {
  for (const preset of AUX_PRESETS) if (preset.re.test(name)) return preset;
  return null;
}

/** 优先用 ro.dvg.cn 抓取的主动/被动标记（skill-types.json，按 handle）；
 *  站点未收录 / 分类为 Quest、— 的技能再退回名称与 handle 启发式。 */
export function isPassiveSkill(name: string, handle: string, kinds: SkillKinds): boolean {
  const siteKind = handle !== "" ? kinds[handle] : undefined;
  if (siteKind === "passive") return true;
  if (siteKind === "active") return false;
  return PASSIVE_SKILL_RE.test(name) || (handle !== "" && PASSIVE_SKILL_HANDLES.has(handle));
}

/** 辅助技能归类：优先走 AUX_PRESETS 的语义预设；未命中预设但明确是增益/保命的补少量兜底
 *  （对齐原型骑士 挑衅/霸体、猎人 集中）。返回 null 表示这是一条攻击技能。 */
export function auxCatOfName(name: string): AuxCat | null {
  if (PASSIVE_SKILL_RE.test(name) || ATTACK_NAME_RE.test(name)) return null;
  const preset = presetOf(name);
  if (preset) return preset.cat;
  if (/心神凝聚|集中/.test(name)) return "buff";
  if (/挑衅|怒吼/.test(name)) return "survival";
  if (/霸体|铁壁/.test(name)) return "buff";
  return null;
}

/** 按 options.json 的职业技能表构建全部职业数据；没有技能数据时返回 null（页面回退内置 4 职业）。 */
export function buildJobsFromOptions(
  opt: JobOptions,
  kinds: SkillKinds = {},
): { jobs: Record<string, JobData>; list: string[] } | null {
  if (!opt.skills) return null;
  const jobIds = [
    ...new Set([...Object.keys(opt.job_skill_groups ?? {}), ...Object.keys(opt.job_skills ?? {})]),
  ];
  if (!jobIds.length) return null;
  const skillById = new Map<number, JobSkillOpt>();
  for (const skill of opt.skills) skillById.set(skill.id, skill);
  const jobs: Record<string, JobData> = {};
  const list: string[] = [];
  for (const jid of jobIds) {
    const groups = opt.job_skill_groups?.[jid] ?? {};
    const ids = opt.job_skills?.[jid] ?? Object.values(groups).flat();
    const names: string[] = [];
    const entries: { nm: string; handle: string }[] = [];
    for (const sid of ids) {
      const sk = skillById.get(sid);
      const nm = sk ? (sk.nameZh ?? sk.name ?? sk.handle ?? "") : "";
      if (nm && !names.includes(nm)) {
        names.push(nm);
        entries.push({ nm, handle: sk?.handle ?? "" });
      }
    }
    const jnEn = opt.jobs?.[jid] ?? "";
    const jnZh = opt.jobs_zh?.[jid] ?? jnEn;
    const ranged = JOB_RANGED_RE.test(jnEn) || JOB_RANGED_RE.test(jnZh ?? "");
    const atk: string[] = [];
    const aux: AuxSeed[] = [];
    for (const { nm, handle } of entries) {
      if (isPassiveSkill(nm, handle, kinds)) continue;
      const cat = auxCatOfName(nm);
      if (cat) {
        if (aux.every((a) => a.n !== nm)) aux.push({ n: nm, c: cat });
      } else if (!atk.includes(nm)) {
        atk.push(nm);
      }
    }
    aux.sort((a, b) => CAT_ORDER[a.c] - CAT_ORDER[b.c]);
    const mount: false | "combat" = JOB_MOUNT_RE.test(jnEn) || JOB_MOUNT_RE.test(jnZh ?? "") ? "combat" : false;
    const mountSkill = mount === "combat" || names.some((n) => /骑乘术|骑乘技能/.test(n));
    let surv: SurvKind = "melee";
    if (mount === "combat") surv = "tank";
    else if (JOB_HEALER_RE.test(jnEn) || JOB_HEALER_RE.test(jnZh ?? "")) surv = "healer";
    else if (ranged) surv = "ranged";
    else if (JOB_CASTER_RE.test(jnEn) || JOB_CASTER_RE.test(jnZh ?? "")) surv = "caster";
    jobs[jid] = {
      name: jnZh ? String(jnZh) : `职业 ${jid}`,
      ranged, mount, mountSkill, surv, atk: atk.slice(0, 12), aux,
    };
    list.push(jid);
  }
  return list.length ? { jobs, list } : null;
}
