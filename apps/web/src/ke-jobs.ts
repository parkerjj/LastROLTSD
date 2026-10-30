// 职业数据构建：从 /ke/options.json 推导每个职业的挂机参数（远程判定 / 坐骑 / 生存档位 / 技能池）。
// 纯逻辑，不依赖 DOM 与页面状态，可脱离游戏账号做全职业覆盖测试。

export type AuxCat = "buff" | "ground" | "heal" | "survival";
export type SurvKind = "tank" | "healer" | "ranged" | "caster" | "melee";
export type JobScope = "self" | "other";
export type JobBranch = 1 | 2 | 3 | 4;

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
  /** 自动打怪时是否默认使用武器普攻（法师等施法职业默认关）。 */
  basic: boolean;
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

/* ========== 职业系列与服务器档位 ========== */

export interface JobSeriesStep {
  branch: JobBranch;
  /** 是否需要转生（高阶/进阶职业及其后的三转、四转）。 */
  reborn: boolean;
  /** 同一档位的职业 ID：第一个是规范 ID，其余是 options.json 里的重复/宝宝别名。 */
  jobs: number[];
}
export interface JobSeries {
  key: string;
  name: string;
  steps: JobSeriesStep[];
}
export interface ServerCap {
  nid: number;
  label: string;
  maxBranch: JobBranch;
  rebirth: boolean;
}
export interface JobClamp {
  jobId: string;
  /** 是否因为服务器档位限制，显示成了较低的职业。 */
  capped: boolean;
  cap: ServerCap;
  series?: JobSeries;
}
export interface JobSeriesOption {
  key: string;
  name: string;
  jobId: string;
  capped: boolean;
}

const step = (branch: JobBranch, reborn: boolean, jobs: number[]): JobSeriesStep => ({ branch, reborn, jobs });

// 只维护「职业系列」：同一系列里的每一步是该档位的代表职业（别名并入同一步）。
// 用户角色按 nid 截断到该服务器最高档位，技能池直接用截断后职业的 job_skill_groups。
export const JOB_SERIES: JobSeries[] = [
  { key: "novice", name: "初心者", steps: [
    step(1, false, [0]),
    step(1, true, [161, 4001]),
  ] },
  { key: "super_novice", name: "超级初心者", steps: [
    step(1, false, [23, 4190, 4045, 4191]),
  ] },
  { key: "knight", name: "骑士 / 龙骑士", steps: [
    step(1, false, [1]),
    step(1, true, [162, 4002]),
    step(2, false, [7, 13]),
    step(2, true, [168, 174, 4008, 4014]),
    step(3, true, [4054, 4060, 4080, 4081, 4088, 4089, 4090, 4091, 4092, 4093, 4094, 4095, 4096, 4109]),
    step(4, true, [4252]),
  ] },
  { key: "crusader", name: "十字军 / 帝国卫士", steps: [
    step(1, false, [1]),
    step(1, true, [162, 4002]),
    step(2, false, [14, 21]),
    step(2, true, [175, 4022, 4015]),
    step(3, true, [4066, 4073, 4082, 4083, 4102, 4110]),
    step(4, true, [4258]),
  ] },
  { key: "wizard", name: "巫师 / 大法师", steps: [
    step(1, false, [2]),
    step(1, true, [163, 4003]),
    step(2, false, [9]),
    step(2, true, [170, 4010]),
    step(3, true, [4055, 4061, 4097]),
    step(4, true, [4255]),
  ] },
  { key: "sage", name: "贤者 / 元素支配者", steps: [
    step(1, false, [2]),
    step(1, true, [163, 4003]),
    step(2, false, [16]),
    step(2, true, [177, 4017]),
    step(3, true, [4067, 4074, 4103]),
    step(4, true, [4261]),
  ] },
  { key: "hunter", name: "猎人 / 风鹰", steps: [
    step(1, false, [3]),
    step(1, true, [164, 4004]),
    step(2, false, [11]),
    step(2, true, [172, 4012]),
    step(3, true, [4056, 4062, 4084, 4085, 4098, 4111]),
    step(4, true, [4257]),
  ] },
  { key: "bard", name: "吟游诗人 / 游唱诗人", steps: [
    step(1, false, [3]),
    step(1, true, [164, 4004]),
    step(2, false, [19]),
    step(2, true, [180, 4020]),
    step(3, true, [4068, 4075, 4104]),
    step(4, true, [4263]),
  ] },
  { key: "dancer", name: "舞娘 / 游侠舞者", steps: [
    step(1, false, [3]),
    step(1, true, [164, 4004]),
    step(2, false, [20]),
    step(2, true, [181, 4021]),
    step(3, true, [4069, 4076, 4105]),
    step(4, true, [4264]),
  ] },
  { key: "priest", name: "牧师 / 红衣主教", steps: [
    step(1, false, [4]),
    step(1, true, [165, 4005]),
    step(2, false, [8]),
    step(2, true, [169, 4009]),
    step(3, true, [4057, 4063, 4099]),
    step(4, true, [4256]),
  ] },
  { key: "monk", name: "武僧 / 十字驱魔师", steps: [
    step(1, false, [4]),
    step(1, true, [165, 4005]),
    step(2, false, [15]),
    step(2, true, [176, 4016]),
    step(3, true, [4070, 4077, 4106]),
    step(4, true, [4262]),
  ] },
  { key: "smith", name: "铁匠 / 机甲师", steps: [
    step(1, false, [5]),
    step(1, true, [166, 4006]),
    step(2, false, [10]),
    step(2, true, [171, 4011]),
    step(3, true, [4058, 4064, 4086, 4087, 4100, 4112]),
    step(4, true, [4253]),
  ] },
  { key: "alchemist", name: "炼金术士 / 生物学家", steps: [
    step(1, false, [5]),
    step(1, true, [166, 4006]),
    step(2, false, [18]),
    step(2, true, [179, 4019]),
    step(3, true, [4071, 4078, 4107]),
    step(4, true, [4259]),
  ] },
  { key: "assassin", name: "刺客 / 影十字", steps: [
    step(1, false, [6]),
    step(1, true, [167, 4007]),
    step(2, false, [12]),
    step(2, true, [173, 4013]),
    step(3, true, [4059, 4065, 4101]),
    step(4, true, [4254]),
  ] },
  { key: "rogue", name: "流氓 / 深渊追迹者", steps: [
    step(1, false, [6]),
    step(1, true, [167, 4007]),
    step(2, false, [17]),
    step(2, true, [178, 4018]),
    step(3, true, [4072, 4079, 4108]),
    step(4, true, [4260]),
  ] },
  { key: "gunslinger", name: "神枪手 / 叛乱者", steps: [
    step(1, false, [24]),
    step(2, false, [4215]),
  ] },
  { key: "kagerou", name: "忍者 / 影狼", steps: [
    step(1, false, [25]),
    step(2, false, [4211]),
  ] },
  { key: "oboro", name: "忍者 / 胧", steps: [
    step(1, false, [25]),
    step(2, false, [4212]),
  ] },
  { key: "stargladiator", name: "拳圣 / 星帝", steps: [
    step(1, false, [4046]),
    step(2, false, [4047, 4048]),
    step(3, false, [4239, 4241, 4243]),
  ] },
  { key: "soullinker", name: "悟灵士 / 灵魂收割者", steps: [
    step(1, false, [4046]),
    step(2, false, [4049]),
    step(3, false, [4240, 4242, 4244]),
  ] },
  { key: "summoner", name: "召唤师", steps: [
    step(1, false, [4218]),
  ] },
];

const JOB_STEP_INDEX = new Map<number, { series: JobSeries; step: JobSeriesStep }>();
for (const series of JOB_SERIES) {
  for (const item of series.steps) {
    for (const job of item.jobs) {
      if (!JOB_STEP_INDEX.has(job)) JOB_STEP_INDEX.set(job, { series, step: item });
    }
  }
}

// 牧师系职业：治愈术对他们既是治疗技，也是打不死系的攻击技（武僧系不算）。
const PRIEST_JOB_IDS = new Set<number>(
  JOB_SERIES.filter((series) => series.key === "priest")
    .flatMap((series) => series.steps)
    .flatMap((item) => item.jobs),
);

/** nid 语义：3=三转服、5=进阶二转服、6=App 服（不能转生）；未知 nid 不截断。 */
export function serverCapOf(nid: number | string | null | undefined): ServerCap {
  const value = typeof nid === "number" ? nid : Number(nid);
  if (value === 3) return { nid: 3, label: "三转服", maxBranch: 3, rebirth: true };
  if (value === 5) return { nid: 5, label: "进阶二转服", maxBranch: 2, rebirth: true };
  if (value === 6) return { nid: 6, label: "App服", maxBranch: 2, rebirth: false };
  return {
    nid: Number.isFinite(value) ? value : 0,
    label: "",
    maxBranch: 4,
    rebirth: true,
  };
}

function stepAllowed(item: JobSeriesStep, cap: ServerCap): boolean {
  return item.branch <= cap.maxBranch && (cap.rebirth || !item.reborn);
}

/** 把角色职业截断到当前服务器能达到的最高档位（龙骑士 → 符文骑士 / 骑士领主 / 骑士）。 */
export function clampJobForNid(jobId: number | string, nid: number | string | null | undefined): JobClamp {
  const id = typeof jobId === "number" ? jobId : Number(jobId);
  const cap = serverCapOf(nid);
  const found = Number.isFinite(id) ? JOB_STEP_INDEX.get(id) : undefined;
  if (!found) return { jobId: String(jobId), capped: false, cap };
  const { series, step: current } = found;
  if (stepAllowed(current, cap)) {
    return { jobId: String(current.jobs[0]), capped: false, cap, series };
  }
  const targetBranch = Math.min(current.branch, cap.maxBranch) as JobBranch;
  const wantReborn = current.reborn && cap.rebirth;
  const candidates = series.steps.filter((item) => item.branch === targetBranch);
  const target =
    candidates.find((item) => item.reborn === wantReborn) ??
    candidates.find((item) => !item.reborn) ??
    candidates[0];
  if (!target) return { jobId: String(jobId), capped: false, cap, series };
  return {
    jobId: String(target.jobs[0]),
    capped: target !== current,
    cap,
    series,
  };
}

/** demo 职业列表：每个系列一条，按 nid 自动取该服务器能显示的最高职业。 */
export function listJobSeries(nid: number | string | null | undefined): JobSeriesOption[] {
  const cap = serverCapOf(nid);
  const options: JobSeriesOption[] = [];
  for (const series of JOB_SERIES) {
    const allowed = series.steps.filter((item) => stepAllowed(item, cap));
    const top = allowed[allowed.length - 1] ?? series.steps[0];
    if (!top) continue;
    options.push({
      key: series.key,
      name: series.name,
      jobId: String(top.jobs[0]),
      capped: top !== series.steps[series.steps.length - 1],
    });
  }
  return options;
}

/* ========== 技能归类 ========== */

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
  // 蓄气/狂蓄气是攒气弹的自身增益：气弹 < 5 就补，冷却 1 秒（狂蓄气满级只有 1 级）
  { re: /蓄气/, cat: "buff", scopes: {
    self: { on: true, conds: [{ k: "spirit", v: "< 5" }, { k: "timeout", v: "1" }] },
    other: { on: false } } },
  // 光耀/领域/障壁是地面类：自身脚下没有就补
  { re: /光耀|领域|障壁/, cat: "ground", scopes: {
    self: { on: true }, other: { on: false } } },
  { re: /冥想/, cat: "buff", scopes: {
    self: { on: true, conds: [{ k: "sp", v: "< 50%" }, { k: "timeout", v: "5" }] },
    other: { on: false } } },
];

// 特殊施放规则：这些技能不能套用类别通用条件（如治疗类的「HP < 70%」），必须按真实用法单独生成。
// 条件里的 %NAME% 占位 = 技能自身的状态名，由页面按角色状态表解析。
export interface SkillSpecial {
  /** 自身块条件，覆盖类别/预设默认。 */
  selfConds?: JobCond[];
  /** KE 条件之间是「且」，一个技能要覆盖多个状态就只能拆成多个自身块（痊愈术）。 */
  selfStatusConds?: JobCond[][];
  /** 额外的队友块条件；有值就同时生成 partySkill。 */
  partyConds?: JobCond[];
  /** 只对队友释放，不生成自身块（复活术目标必须是死亡队友）。 */
  partyOnly?: boolean;
  /** 攻击块额外字段（maxUses / maxDist 等）。 */
  atkFields?: Record<string, string>;
  /** 攻击块额外条件（target_whenStatusInactive / spirit 等）。 */
  atkConds?: Record<string, string>;
  /** 技能卡上的规律说明。 */
  hint?: string;
}

export const SKILL_SPECIALS: Record<string, SkillSpecial> = {
  // 挑衅是对敌人用的拉怪/降防技，不是自身 buff；每只怪只用 1 次。
  "挑衅": {
    atkFields: { maxUses: "1" },
    hint: "对怪用 · 每只怪 1 次",
  },
  // 天使之怒是给怪挂增伤标记的攻击技：目标身上没有标记才放，同目标 3 秒一次。
  "天使之怒": {
    atkConds: { target_whenStatusInactive: "EFST_LEXAETERNA", target_timeout: "3" },
    hint: "目标没标记才放 · 同目标 3 秒",
  },
  // 弹指神通是远程气功：要有气弹，最远 9 格。
  "弹指神通": {
    atkFields: { maxDist: "9" },
    atkConds: { spirit: "> 0" },
    hint: "需气弹 · 最远 9 格",
  },
  // 盗贼系解毒：只有自己中毒时才用，不能套用「HP < 70%」。
  "解毒": {
    selfConds: [{ k: "whenStatusActive", v: "EFST_HEALTHSTATE_POISON" }, { k: "timeout", v: "1" }],
    hint: "中毒时对自己用",
  },
  // 缓毒术是中毒后防止持续掉血的续命技，同样只在中毒状态使用。
  "缓毒术": {
    selfConds: [{ k: "whenStatusActive", v: "EFST_HEALTHSTATE_POISON" }, { k: "timeout", v: "1" }],
    hint: "中毒时续上缓毒",
  },
  // 痊愈术只能解沉默/混乱/黑暗（rAthena AL_CURE），按状态拆成三个块。
  "痊愈术": {
    selfStatusConds: [
      [{ k: "whenStatusActive", v: "EFST_HEALTHSTATE_SILENCE" }, { k: "timeout", v: "1" }],
      [{ k: "whenStatusActive", v: "EFST_HEALTHSTATE_CONFUSION" }, { k: "timeout", v: "1" }],
      [{ k: "whenStatusActive", v: "EFST_HEALTHSTATE_BLIND" }, { k: "timeout", v: "1" }],
    ],
    hint: "沉默 / 混乱 / 黑暗时用",
  },
  // 复活术只能对死亡队友放：partySkill 默认拒绝死亡目标，必须显式 target_dead 1。
  "复活术": {
    partyOnly: true,
    partyConds: [{ k: "target_dead", v: "1" }, { k: "timeout", v: "1" }, { k: "target_timeout", v: "30" }],
    hint: "对死亡队友用",
  },
  // 治疗/增益既要顾自己也要顾队友：自身块沿用治疗/增益预设，队友块按目标状态判断。
  "治愈术": {
    partyConds: [{ k: "target_hp", v: "< 70%" }, { k: "timeout", v: "1" }, { k: "target_timeout", v: "30" }],
    hint: "HP < 70% 时给自己和队友",
  },
  "加速术": { partyConds: [{ k: "target_whenStatusInactive", v: "%NAME%" }, { k: "timeout", v: "10" }, { k: "target_timeout", v: "30" }] },
  "天使之赐福": { partyConds: [{ k: "target_whenStatusInactive", v: "%NAME%" }, { k: "timeout", v: "10" }, { k: "target_timeout", v: "30" }] },
  "神威祈福": { partyConds: [{ k: "target_whenStatusInactive", v: "%NAME%" }, { k: "timeout", v: "10" }, { k: "target_timeout", v: "30" }] },
  "牺牲祈福": { partyConds: [{ k: "target_whenStatusInactive", v: "%NAME%" }, { k: "timeout", v: "10" }, { k: "target_timeout", v: "30" }] },
  "霸邪之阵": { partyConds: [{ k: "target_whenStatusInactive", v: "%NAME%" }, { k: "timeout", v: "10" }, { k: "target_timeout", v: "30" }] },
  "圣母之颂歌": { partyConds: [{ k: "target_whenStatusInactive", v: "%NAME%" }, { k: "timeout", v: "10" }, { k: "target_timeout", v: "30" }] },
  "幸运之颂歌": { partyConds: [{ k: "target_whenStatusInactive", v: "%NAME%" }, { k: "timeout", v: "10" }, { k: "target_timeout", v: "30" }] },
};

// 显式归类：名称一眼能确定是自身 buff / 地面 / 治疗 / 保命，不再靠宽泛正则猜。
// 这里覆盖设计稿里梳理过的 buff，以及三转/四转常见增益；未列出的默认按攻击技能处理。
const AUX_NAMES: Record<AuxCat, readonly string[]> = {
  buff: [
    // 剑士 / 骑士 / 十字军
    "霸体", "狂暴状态", "反击", "双手剑攻击速度增加", "单手剑攻击速度增加",
    "灵气剑", "双剑格挡", "集中攻击", "极速恢复", "狂怒之枪", "Fury",
    "自动防御", "反射盾", "光之盾", "长矛加速术", "神佑之光", "牺牲", "圣音",
    "坚盾护体", "虔诚", "聚集", "威信", "灵感", "王的恩典", "盾咒", "先锋部队",
    "所有化学武器保护",
    // 魔法师 / 巫师 / 贤者
    "火狩", "能量外套", "魔力增幅", "魔法醒悟", "魔力冻结", "阅读魔法书",
    "属性附加", "火焰属性附加", "水属性附加", "风属性附加", "地属性附加",
    "HP转换", "心神互换", "速读术", "双倍投掷",
    "元素更换(水)", "元素更换(地)", "元素更换(火)", "元素更换(风)",
    "火焰步", "电流步", "魔力拳", "打击强化", "加热术", "极限空虚", "精灵激发",
    "精灵控制", "精灵交流", "火之纹章", "水之纹章", "风之纹章", "地之纹章", "精灵结界",
    // 服侍 / 牧师 / 武僧
    "天使之赐福", "天使之障壁", "加速术", "神威祈福", "牺牲祈福", "洒水祈福", "圣之祈福",
    "霸邪之阵", "圣母之颂歌", "幸运之颂歌", "圣母之祈福", "冥想",
    "赎罪", "圣典", "奉献颂", "安希拉", "纯白百合花", "圣灵降临祈祷", "感恩歌",
    "羔羊歌颂", "折枝赞颂", "感恩祈祷", "静寂", "集结",
    "蓄气", "狂蓄气", "金刚不坏", "爆气", "闪电步", "吸气", "全气注入",
    "点穴-默", "点穴-快", "点穴-球", "点穴-反", "点穴-活",
    // 弓箭手 / 猎人 / 诗人 / 舞娘
    "心神凝聚", "风之步", "狙杀瞄准", "敏锐嗅觉", "伪装战术", "精英狙击",
    "疾狼术", "召狼术", "骑狼术",
    "吹口哨", "刺客的黄昏", "布莱奇之诗", "伊登的苹果", "不死神齐格弗里德",
    "仙境传说", "战鼓震天", "尼贝隆根之戒指", "洛奇的悲鸣", "触媒之所",
    "经验值倍增", "永远的混沌", "安可", "和声演奏",
    "重金属音乐", "支配动力", "循环的大自然之音", "不确定要素的语言",
    "羞怯一天的忧郁", "魔力之歌", "与狼共舞", "狂欢周末夜", "战嚎的彼端",
    "无限哼唱声", "丰年颂", "Stage Manner", "Retrospection", "Mystic Symphony", "Kvasir Sonata",
    // 商人 / 铁匠 / 炼金术士
    "大声呐喊", "速度激发", "无视体型攻击", "凶砍", "极限攻击", "所有速度激发",
    "手推车加速", "凶砍最大值", "手推车改良",
    "悬停", "主体改造", "形态转换", "紧急冷却", "中性防护罩", "隐形力场", "解析",
    "化学武器保护", "化学盾牌保护", "化学铠甲保护", "化学头盔保护", "幻觉禁药",
    "The Whole Protection", "Advance Protection",
    // 盗贼 / 刺客 / 流氓
    "涂毒", "致命涂毒", "毒性反弹", "幻影步", "自动魅影念咒", "魅影形态", "血腥欲望",
    // 三转/四转常见主动增益（站点把一部分标成 active，需显式归 buff）
    "魔力剑", "Climax", "Spell Enchanting", "Dragonic Aura", "Holy Shield",
    "Guard Stance", "Attack Stance", "Rebound Shield", "千年神盾", "自由保护",
    "Firm Faith", "First Faith Power", "Powerful Faith", "Sincere Faith", "Second Faith",
    "Religio", "Presens Acies", "力量成长", "提升斗志", "振气注入",
    "Activity Burn", "Increasing Activity", "生命激化",
    // 逐条核对 options.json 后补上的三转/四转自身增益（此前被误分到攻击池）
    "烈火战车", "岩石皮肤", "丰足", "剧毒武器", "二道圣光", "微风恐惧",
    "终极念力", "潜龙升天", "暗影追踪", "喵喵不休",
    "哼唱之音", "女神之吻", "为您服务", "回音之歌", "恋人交响乐",
    "摇摆舞", "月光小夜曲", "音乐插曲", "Musical Interlude", "Jawaii Serenade", "Pron March",
    "投掷硬币", "菠色克投掷",
    // 悟灵士的灵魂链接：给队友的增益，不是攻击
    "炼金术士的灵魂", "武僧的灵魂", "拳圣的灵魂", "贤者的灵魂", "十字军的灵魂",
    "超级初心者的灵魂", "骑士的灵魂", "巫师的灵魂", "牧师的灵魂", "诗人和舞娘的灵魂",
    "流氓的灵魂", "刺客的灵魂", "铁匠的灵魂", "猎人的灵魂", "悟灵士的灵魂",
    "一转上等职业的灵魂", "死亡骑士之魂", "黑暗搜集者之魂", "忍者之魂", "神枪手之魂",
    // 元素支配者的精灵护甲/防护
    "El Flamearmor", "El Crystal Armor", "El Poison Shield", "El Strong Protection",
    "El Deep Poisoning", "El Grace Breeze", "El Earth Care", "Elemental Veil",
    // 帝国卫士 / 红衣主教 / 影十字 / 龙骑士 四转增益
    "Guardian Shield", "Ultimate Sacrifice", "Mediale Votum",
    "Enchanting Shadow", "Potent Venom", "Shadow Exceed", "Vigor",
    // 拳圣/星帝的架势与准备动作
    "回旋准备", "砸踢准备", "踢准备", "还击准备", "落法",
    // 其他显式核对出的自身增益
    "霸王魂",
    // 神枪手 / 叛乱者
    "装满硬币", "疯狂凯斯乐", "终极闪躲", "命中率递增", "富翁的财货",
    "闪烁信号", "瞬速子弹", "白金祭坛", "堕落天使", "加速子弹",
    // 忍者
    "金蝉脱壳", "幻影分身", "水遁", "念", "明镜止水", "幻术-残影", "法术-施展",
    "灵魂阻隔", "虚无缥缈之影", "影子武士",
    // 跆拳 / 拳圣 / 悟灵士
    "温暖的风", "加油", "平安的休息", "快乐的休息", "太拳任务",
    "太阳的温暖", "月亮的温暖", "星星的温暖", "太阳的平安感", "月亮的平安感", "星星的平安感",
    "太阳和月亮和星星的感觉", "太阳和月亮和星星的融合",
    "太阳的祝福", "月亮的祝福", "星星的祝福",
    "凯易哲", "凯阿希", "凯诬仆", "凯易特", "凯易娜",
    "月亮光辉", "月亮英姿", "星星光辉", "星星英姿", "太阳光辉", "太阳英姿",
    "宇宙英姿", "星帝降临", "重力调整", "次元之书", "创星之书",
    "太阳和月亮和星星的记录", "太阳和月亮和星星的净化",
    "巨人灵魂", "影子灵魂", "隼鹰灵魂", "精灵灵魂",
    "灵魂集结", "灵魂分裂", "灵魂循环", "灵魂蓄积", "凯沃特",
    // 召唤师
    "灵魂魔珠", "大地力量", "生命力量", "海洋力量",
    "生命之魂", "大地之魂", "海洋之魂", "喵喵", "野猪之魂",
  ],
  ground: [
    "暗之障壁", "光之障壁", "光耀之堂", "神圣殿堂", "薄雾墙", "易燃之网",
    "火元素领域", "水元素领域", "风元素领域", "地元素领域",
    "祈祷文", "荆棘之壁",
    // 地面减益/力场：脚下没有就补，不进攻击池
    "极限空虚", "泥沼地", "深渊沼地", "咒缚阵", "混沌恐慌",
  ],
  heal: [
    "治愈术", "治疗术", "缓毒术", "痊愈术", "复活术", "慈悲术", "高阶治愈术",
    "净化", "解毒", "治愈生命体", "复活生命体", "精灵治愈", "雷拉多露水",
    "纤细药水投掷", "舔毛", "咕噜咕噜", "喵喵草",
    // 补上被误归攻击的治疗技能
    "灿烂圣光", "药水投掷", "Reparatio", "Dilectio Heal", "Gentletouch",
  ],
  survival: [
    "装死", "隐匿", "伪装", "瞬间移动", "后退回避", "潜遁", "影子跳跃", "跳高",
    "紧急脱身", "透明术", "弓身弹影", "跑步", "大步前进", "前侧滑行",
    "大步后退", "后侧滑行", "大步前进、前侧滑行", "大步后退、后侧滑行",
    "躲藏", "跳跃", "怒吼", "人孔", "暗云",
  ],
};
const EXPLICIT_AUX = new Map<string, AuxCat>();
for (const cat of Object.keys(AUX_NAMES) as AuxCat[]) {
  for (const name of AUX_NAMES[cat]) EXPLICIT_AUX.set(name, cat);
}

// 非战斗功能技能：鉴定/开店/修理/制药/制作/偷窃/陷阱处理/传送/解除等。
// options.json 的 skill-types 会把它们标成 active，因此必须在站点标记之前判定，否则会混进攻击技能池。
const UTILITY_SKILL_NAMES = new Set<string>([
  "物品鉴定", "露天商店", "开设购买商店(BUYING STORE)", "武器修理", "武器精炼", "修复", "金钱铸造",
  "陷阱探查", "陷阱移除", "偷窃", "背包偷窃", "偷钱", "取消施法", "念咒拆除", "魔法效果解除",
  "魔法惩罚", "自由施法", "自动念咒", "随机技能", "传送之阵", "异次元之门", "涂鸦", "旗帜涂鸦",
  "清洗", "自我摧毁", "怪物情报", "元素分析", "红外线扫描", "伪装强化", "武器抵御", "解毒剂",
  "繁殖", "火焰控制", "生命伦理", "游侠主意", "频死之术", "魔力减免", "半径扩大", "课程",
  "解除", "Bionic Pharmacy", "Researchreport", "生命体", "生命体召唤", "安息", "生物调拨",
  "培养", "素材变化", "调配料理", "炸弹制造", "植物栽培", "药剂试验", "融合试验", "FAW解体",
  "召唤地精灵泰拉", "召唤水精灵阿库亚", "召唤火元素", "召唤风精灵梵图斯",
  // Hocus Pocus 的随机效果：不是玩家能主动选择的攻击技
  "变成兽人面孔", "死身", "宿命", "问号", "GRAVITY", "当场死亡", "完全恢复", "升级",
  "召唤魔物", "变换成波利", "变换成Boss级魔物", "认养宠物", "进化之书",
  // 无伤害的减益/控制技：挂机时只会浪费 SP（天使之怒除外：它是攻击池里的增伤标记技）
  "缓速术", "沉默之术", "精神撼动", "精神耗弱术", "冷笑话", "惊声尖叫",
  "丑陋之舞", "勿忘我", "眨眼之诱", "抛戈卸甲", "人体彩绘", "漩涡",
  "摇篮曲", "沉睡摇篮曲", "绝望之歌", "塞壬之音", "消沉旋律", "龙之咆哮",
  "幻术-惊恐", "幻术-迷惑", "幻术-咒死", "临机应变", "光猎", "天使之泪",
  "舍身取义", "致命感染", "公牛之眼", "血色烙印",
  // 面具系列是 PVP 减益
  "面具:无力", "面具-忧郁", "面具-无知", "面具:懒散", "面具-不幸", "面具-衰弱",
  // 无伤害陷阱与陷阱触发器
  "定位陷阱", "滑动陷阱", "魔耗陷阱", "强光陷阱", "睡魔陷阱", "爆破陷阱", "雷管",
  "Hallucination",
  // 无伤害限制/封锁类（挂机时不会主动用，放进攻击池只会浪费 SP）
  "白色监狱", "石化诅咒", "咖般塔音", "冰刃之墙", "真剑百破道", "紧密的约束",
  // 野蛮凶砍是开关式技能（还会损坏自己的武器），挂机不用
  "野蛮凶砍",
]);
const UTILITY_SKILL_RE = /制作|制造|配药|鉴定|修理|精炼|铸造|购买商店|露天商店|陷阱探查|陷阱移除|偷窃|偷钱|取消施法|念咒拆除|魔法效果解除|传送之阵|异次元之门|涂鸦|清洗|自我摧毁|随机技能|怪物情报|元素分析|红外线扫描|伪装强化|武器抵御|解毒剂|繁殖|火焰控制|生命伦理|游侠主意|频死之术|魔力减免|半径扩大|课程|人孔|^解除$|^卸除|卸除武装|卸除武器|卸除盾牌|卸除铠甲|卸除头盔|卸除配件|所有卸除|FAW解体|Bionic Pharmacy|Researchreport/;

// 内部子技能/演出标记：Startmark/Endmark、XX Atk、Dotdamage 等不是玩家面板上的技能。
const INTERNAL_SKILL_RE = /Startmark|Endmark|Start Mark|End Mark|^Tribe (Start|End)$|\sAtk2?$|\sDotdamage$|\sAutospell$|\sMelee$|\sMagic$|\sPlusatk$|\sBrandish$|\sRangemeleeatk$|\sDouble Atk$|^Summon Atk |^Tetravortex |^Fire Expansion (Smoke Powder|Tear Gas|Acid)$|Cn Meteor2|Lunaticcarrotbeat2/;

/** 是否为采集/制作/商店/修理/陷阱处理等非战斗技能（不进攻击池）。 */
export function isUtilitySkill(name: string): boolean {
  return UTILITY_SKILL_NAMES.has(name) || UTILITY_SKILL_RE.test(name) || INTERNAL_SKILL_RE.test(name);
}

// AOE 攻击技能：模板里加「被围攻 >= 2」条件，作为被怪围住时的解围技。
// 锐利射击虽然也是 AOE，但一般用来打单体，必须排除。
const AOE_SKILL_NAMES = new Set<string>([
  "怒爆", "怪物互击", "大地之击", "箭雨", "箭雨风暴", "榴霰弹",
  "重力原野", "暴风雪", "怒雷强击", "陨石术", "崩裂术", "雷暴术", "霜冻之术", "冻僵术",
  "碧血陨石", "毁灭彗星", "连锁电击", "地牛翻身", "属性漩涡", "寒冰浓雾",
  "大地坟场", "钻石星尘", "超自然波", "云杀",
  "圣十字审判", "十字驱魔攻击", "审判", "讴歌", "天罚",
  "回旋刀刃", "回旋十字斩", "毒雾", "漩涡", "虚击炸弹",
  "致命爆裂", "龙之气息", "龙之气息-水", "风暴冲击", "风压飞刃", "符文爆发",
  "大暴雨", "巨大共鸣", "毁灭之声", "残响", "死亡峡谷",
  "地雷震", "旋风腿", "天罗地网", "爆气散弹", "破碎柱", "闪光连击", "狮子吼",
  "半月斩", "创世之光", "大地毁灭", "黄昏星之光", "加农炮攻击",
  "粉碎风暴", "圆桌舞蹈", "魔兽摆尾", "火焰暴雨",
  "岩浆喷发", "火焰喷射器", "加农炮", "战斧飓风", "手推车龙卷风", "手推车加农炮",
  "疯狂野草",
  "火炎阵", "爆炎龙", "冰晶落", "雷击碎", "朔风", "八方飞刀", "风魔飞镖之飞舞",
  "新星爆发", "流星陨落", "太阳爆炸",
  "Acidified Zone Water", "Acidified Zone Ground", "Acidified Zone Wind", "Acidified Zone Fire",
  // 核对后补上的解围型范围技
  "磁场", "地狱火焰", "火球术", "火焰之壁", "爆散陷阱",
]);

/** 是否为需要「被围攻 >= 2」才用的 AOE 攻击技能（锐利射击明确排除）。 */
export function isAoeSkill(name: string): boolean {
  return AOE_SKILL_NAMES.has(name);
}

/* ========== 被动/主动判定 ========== */

// 内置演示职业表：options.json 加载失败时回退（与原型一致）。
export const FALLBACK_JOBS: Record<string, JobData> = {
  "3": { name: "弓箭手", ranged: true, surv: "ranged", mount: false, mountSkill: false, basic: true,
    atk: ["二连矢", "冲锋箭", "箭雨"],
    aux: [{ n: "心神凝聚", c: "buff" }] },
  "6": { name: "盗贼", ranged: false, surv: "melee", mount: false, mountSkill: false, basic: true,
    atk: ["施毒", "喷砂", "投掷石头"],
    aux: [{ n: "隐匿", c: "survival" }] },
  "7": { name: "骑士", ranged: false, surv: "tank", mount: "combat", mountSkill: false, basic: true,
    atk: ["骑乘攻击", "连刺攻击", "挑衅"],
    aux: [{ n: "霸体", c: "buff" }] },
  "11": { name: "猎人", ranged: true, surv: "ranged", mount: false, mountSkill: false, basic: true,
    atk: ["二连矢", "冲锋箭", "箭雨", "闪电冲击"],
    aux: [{ n: "心神凝聚", c: "buff" }] },
};
export const CAT_ORDER: Record<AuxCat, number> = { survival: 0, buff: 1, ground: 2, heal: 3 };

// 真实 options.json 的 job_skill_groups 只有「通用/一转/二转」这类分段名，没有原型里
// 「远程/攻击/治疗/增益」的语义分组，因此真实数据下按职业族 + 技能名归类，保持与原型相同的取舍：
// 远程（弓/枪/诗人/舞娘系）、治疗（服事系）、施法（法系）、坐骑（骑士/十字军/守护系）。
const JOB_RANGED_RE = /Archer|Hunter|Sniper|Ranger|Windhawk|Bard|Clown|Minstrel|Troubadour|Dancer|Gypsy|Wanderer|Trouvere|Gunslinger|Rebellion|Mercenary Archer|弓箭手|猎人|神射手|游侠|诗人|吟游诗人|舞娘|神枪手|反叛者|宫廷乐师|风鹰/;
const JOB_HEALER_RE = /Acolyte|Priest|Bishop|Cardinal|Monk|Champion|Sura|Inquisitor|服侍|服事|牧师|祭司|主教|武僧|修罗|修士/;
const JOB_CASTER_RE = /Mage|Magician|Wizard|Sage|Professor|Sorcerer|Warlock|Arch Mage|Elemental Master|Ninja|Kagerou|Oboro|Soul Linker|Soul Reaper|Summoner|魔法师|巫师|贤者|教授|咒术师|妖术师|忍者|影狼|胧|灵术师|魂之收割者|召唤师|元素大师|大法师/;
const JOB_MOUNT_RE = /Knight|Crusader|Paladin|Guard|骑士|十字军|圣殿|皇家/;

// 被动/功能技能不划进攻击技能池（修炼、制作、商店、制作箭等功能技放进 attackSkillSlot 只会浪费 SP）。
// 注意：这里只放「确实不会主动施放」的技能；主动 buff / 解围 / 位移技能走显式辅助表。
const PASSIVE_SKILL_RE = /基本技能|紧急治疗|熟练度|修炼|掌握|之眼|快速恢复|禅心|移动时恢复|攻击弱点|Selfprovoke|负重量|低价买进|高价卖出|物品鉴定|露天商店|开设购买商店|制作|制造|研究|保有|寻找矿石|修理|强化火属性|贪婪|抄袭|捡石头|陷阱探查|陷阱移除|涂鸦|旗帜|清洗|强制减价|认养|召唤魔物|变换成|升级|完全恢复|准备|宠物|进化之书|取消施法|魔法惩罚|念咒拆除|自由施法|自动念咒|随机技能|装填|飞刀修炼|残影|移花接木|吸魂术|被动|骑乘术|骑乘技能|知识|配药|培养/;
// 名称不带通用词、但确实是被动的技能。
const PASSIVE_SKILL_NAMES = new Set<string>([
  "偷窃", "手推车使用", "改装手推车", "魔导机甲执照", "铁沙掌", "运气调息",
  "魔力减免", "伪装强化", "繁殖", "课程", "半径扩大", "素材变化", "调配料理",
  "火焰控制", "生命伦理", "解毒剂", "武器抵御", "游侠主意", "频死之术",
]);
// options.json 没有被动标记，以下按 handle 补充常见被动（名称不一定命中上面的正则）。
const PASSIVE_SKILL_HANDLES = new Set([
  "SM_SWORD", "SM_TWOHAND", "SM_RECOVERY", "SM_MOVINGRECOVERY", "SM_FATALBLOW",
  "MC_INCCARRY", "AC_OWL", "AC_VULTURE", "MG_SRECOVERY",
  "KN_SPEARMASTERY", "KN_CAVALIERMASTERY", "KN_ONEHAND",
  "PR_MACEMASTERY", "AS_RIGHT", "AS_LEFT", "AS_KATAR", "ASC_KATAR",
  "AM_AXEMASTERY", "SA_FULLRECOVERY",
  "GS_SNAKEEYE", "NJ_TOBIDOUGU", "NJ_NINPOU", "DE_RESET",
  "NPC_GRADUAL_GRAVITY", "RK_REFRESH", "NC_TRAININGAXE",
  "GN_TRAINING_SWORD", "KO_RIGHT", "KO_LEFT", "KO_ZANZOU",
  "HFLI_FLEET", "MER_REGAIN", "EL_PYROTECHNIC", "EL_GUST", "GD_GUARDUP",
  "TF_MISS", "MO_TRIPLEATTACK", "MO_DODGE", "HW_SOULDRAIN",
  "HT_BLITZBEAT",
]);
// 名字明确是攻击技的（避免「天使」类预设把 天使之击 / 天使之光 / 天使之怒 误判成增益）
const ATTACK_NAME_RE = /(之击|攻击)$|天使之光|天使之怒|隐身攻击|毒刃|音速投掷|超音速投掷|强酸火烟瓶投掷/;

export function presetOf(name: string): AuxPreset | null {
  for (const preset of AUX_PRESETS) if (preset.re.test(name)) return preset;
  return null;
}

/** 优先用 ro.dvg.cn 抓取的主动/被动标记（skill-types.json，按 handle）；
 *  站点未收录 / 分类为 Quest、— 的技能再退回名称与 handle 启发式。
 *  显式辅助表优先：能量外套、魔力增幅这类站点漏标/误标的主动 buff 必须归辅助池。 */
export function isPassiveSkill(name: string, handle: string, kinds: SkillKinds): boolean {
  if (EXPLICIT_AUX.has(name)) return false;
  if (isUtilitySkill(name)) return true;
  const siteKind = handle !== "" ? kinds[handle] : undefined;
  if (siteKind === "passive") return true;
  if (siteKind === "active") return false;
  return PASSIVE_SKILL_RE.test(name) || PASSIVE_SKILL_NAMES.has(name) || (handle !== "" && PASSIVE_SKILL_HANDLES.has(handle));
}

/** 辅助技能归类：显式表 → 语义预设 → 少量兜底；返回 null 表示这是一条攻击技能。 */
export function auxCatOfName(name: string): AuxCat | null {
  const explicit = EXPLICIT_AUX.get(name);
  if (explicit) return explicit;
  if (PASSIVE_SKILL_RE.test(name) || ATTACK_NAME_RE.test(name)) return null;
  const preset = presetOf(name);
  if (preset) return preset.cat;
  if (/心神凝聚|集中/.test(name)) return "buff";
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
    // 牧师系的治愈术既能治疗也能打不死系：作为攻击技能特例保留（允许与辅助池重叠）。
    if (PRIEST_JOB_IDS.has(Number(jid)) && names.includes("治愈术") && !atk.includes("治愈术")) {
      atk.push("治愈术");
    }
    const mount: false | "combat" = JOB_MOUNT_RE.test(jnEn) || JOB_MOUNT_RE.test(jnZh ?? "") ? "combat" : false;
    // 骑乘术是被动技能，KE 里上马靠 useSelf_item 坐骑缰绳（whenStatusInactive EFST_ALL_RIDING），
    // 不存在「用技能上马」的写法，因此所有职业统一走道具。
    const mountSkill = false;
    let surv: SurvKind = "melee";
    if (mount === "combat") surv = "tank";
    else if (JOB_HEALER_RE.test(jnEn) || JOB_HEALER_RE.test(jnZh ?? "")) surv = "healer";
    else if (ranged) surv = "ranged";
    else if (JOB_CASTER_RE.test(jnEn) || JOB_CASTER_RE.test(jnZh ?? "")) surv = "caster";
    jobs[jid] = {
      name: jnZh ? String(jnZh) : `职业 ${jid}`,
      ranged, mount, mountSkill, surv,
      // 法师等施法职业默认不用平A；物理/远程/治疗职业默认开。
      basic: surv !== "caster",
      // 不再截断 12 条：三转/四转职业的技能必须完整展示。
      atk,
      aux,
    };
    list.push(jid);
  }
  return list.length ? { jobs, list } : null;
}
