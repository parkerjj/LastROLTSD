// KoreEngine config.txt 的 schema（数据驱动）：标量 + 有序 block + 条件 key。
// 每个字段带 label（中文名）+ help（通俗解释）+ 可选 suffix（单位后缀，如 %）。
// 字段与默认值以 KE 的 M6 设计（config.txt 精确范围）为准。

export interface ScalarOption {
  value: string;
  label: string;
}

export interface ScalarDef {
  key: string;
  label: string;
  help: string;
  type: "enum" | "int" | "string" | "map" | "maps";
  options?: ScalarOption[];
  default?: string;
  suffix?: string;
  group: string;
  /** 特殊输入控件：'item' = 道具搜索选择器（存道具名称）；'worldmap' = 世界地图选图浮层（存地图代码）。 */
  picker?: "item" | "worldmap";
  /** 兼容遗留键：不在表单展示，但解析/序列化时原样保留（避免旧 profile 保存时丢键）。 */
  legacy?: boolean;
}

const ON_OFF: ScalarOption[] = [
  { value: "0", label: "关闭" },
  { value: "1", label: "开启" },
];

export const CONFIG_SCALARS: ScalarDef[] = [
  // —— 攻击 ——
  {
    key: "attackAuto",
    label: "自动攻击",
    help: "是否自动打怪。0=完全手动；1=只打主动打你的怪；2=打范围内所有怪（挂机推荐）。",
    type: "enum",
    default: "2",
    group: "攻击",
    options: [
      { value: "0", label: "关闭" },
      { value: "1", label: "仅攻击主动怪" },
      { value: "2", label: "攻击范围内所有怪" },
    ],
  },
  {
    key: "attackUseWeapon",
    label: "使用武器攻击",
    help: "是否用武器普攻。拳刃/法杖等也要普攻的话保持开启。",
    type: "enum",
    default: "1",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackCanSnipe",
    label: "边退边打",
    help: "边后退边攻击（放风筝）。远程职业想拉开距离时开启。",
    type: "enum",
    default: "0",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackCheckLOS",
    label: "检查视线",
    help: "攻击前检查目标是否被墙/障碍挡住。避免隔着墙傻站，保持开启。",
    type: "enum",
    default: "1",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackAuto_routeToLock",
    label: "回城途中攻击",
    help: "从出生点/回城点走去挂机地图的路上，遇到怪是否打。",
    type: "enum",
    default: "1",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackAuto_outOfLock",
    label: "锁图外攻击",
    help: "挂机地图之外（如误走进邻图）是否继续打怪。",
    type: "enum",
    default: "1",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackAuto_party",
    label: "攻击队友目标",
    help: "队友正在打的怪，你是否也上去打。",
    type: "enum",
    default: "1",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackAuto_followTarget",
    label: "攻击跟随目标",
    help: "你跟随的人打的怪，是否也打。",
    type: "enum",
    default: "1",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackAuto_notInTown",
    label: "城镇内不攻击",
    help: "在城镇/安全区不主动打怪，避免误伤NPC或守卫。",
    type: "enum",
    default: "1",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackDistanceAuto",
    label: "自动调整攻击距离",
    help: "按武器/技能自动调整站多远打怪。",
    type: "enum",
    default: "1",
    group: "攻击",
    options: ON_OFF,
  },
  {
    key: "attackDistance",
    label: "攻击距离",
    help: "手动指定攻击距离（格）。留空则用自动距离。",
    type: "int",
    group: "攻击",
  },
  {
    key: "attackMaxDistance",
    label: "最大攻击距离",
    help: "追怪的最远距离，超过就放弃这个目标。",
    type: "int",
    group: "攻击",
  },
  {
    key: "attackMaxRouteTime",
    label: "最大寻路时间",
    help: "追怪找路的最大秒数，超时放弃。",
    type: "int",
    suffix: "秒",
    group: "攻击",
  },
  {
    key: "attackRouteMaxPathDistance",
    label: "追击路程上限",
    help: "选目标和挑落脚点共用的路程上限（格），追击路程超过即放弃该目标。KE 默认 20。",
    type: "int",
    suffix: "格",
    group: "攻击",
  },
  {
    key: "clientSight",
    label: "视野半径",
    help: "客户端视野半径（格），用于判断目标是否即将离开视野。KE 默认 17。",
    type: "int",
    suffix: "格",
    group: "攻击",
  },
  {
    key: "avoidHiddenMonsters",
    label: "不打隐匿怪",
    help: "开启后不攻击隐匿/隐身状态的怪物。",
    type: "enum",
    options: ON_OFF,
    group: "攻击",
  },
  {
    key: "antiKS",
    label: "不抢怪",
    help: "开启后不抢别人正在打的怪。",
    type: "enum",
    default: "0",
    options: ON_OFF,
    group: "攻击",
  },
  {
    key: "aggressiveAntiKS",
    label: "严格防抢怪",
    help: "更严格的防抢怪：即使怪没打过自己也避开。",
    type: "enum",
    options: ON_OFF,
    group: "攻击",
  },
  {
    key: "attackEquip_topHead",
    label: "攻击装备：上头部",
    help: "开打前切换的上头部装备（道具名）。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_midHead",
    label: "攻击装备：中头部",
    help: "开打前切换的中头部装备。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_lowHead",
    label: "攻击装备：下头部",
    help: "开打前切换的下头部装备。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_leftHand",
    label: "攻击装备：左手",
    help: "开打前切换的左手武器。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_rightHand",
    label: "攻击装备：右手",
    help: "开打前切换的右手武器。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_leftAccessory",
    label: "攻击装备：左饰品",
    help: "开打前切换的左饰品。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_rightAccessory",
    label: "攻击装备：右饰品",
    help: "开打前切换的右饰品。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_robe",
    label: "攻击装备：披肩",
    help: "开打前切换的披肩。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_armor",
    label: "攻击装备：铠甲",
    help: "开打前切换的铠甲。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_shoes",
    label: "攻击装备：鞋子",
    help: "开打前切换的鞋子。",
    type: "string",
    group: "攻击",
  },
  {
    key: "attackEquip_arrow",
    label: "攻击装备：箭矢",
    help: "开打前切换的箭矢。",
    type: "string",
    group: "攻击",
  },
  // autoSwitch 兜底：未命中任何 autoSwitch block 的怪物时使用此武器
  {
    key: "autoSwitch_default_rightHand",
    label: "默认右手武器",
    help: "未命中 autoSwitch 怪物名单时默认右手武器。写 [NONE] 表示空手。",
    type: "string",
    group: "攻击",
    picker: "item",
  },
  {
    key: "autoSwitch_default_leftHand",
    label: "默认左手武器/盾",
    help: "未命中 autoSwitch 怪物名单时默认左手装备。双手武器请留空。",
    type: "string",
    group: "攻击",
    picker: "item",
  },
  {
    key: "autoSwitch_default_arrow",
    label: "默认箭矢",
    help: "未命中 autoSwitch 怪物名单时默认箭矢（远程职业）。",
    type: "string",
    group: "攻击",
    picker: "item",
  },

  // —— 路线 ——
  {
    key: "lockMap",
    label: "挂机地图",
    help: "自动挂机的地图代码（如 prt_fild08）。进入该图后才开始挂机。",
    type: "map",
    group: "路线",
    picker: "worldmap",
  },
  {
    key: "saveMap",
    label: "回城地图",
    help: "死亡/补给后回城的城镇代码（如 prontera）。",
    type: "map",
    group: "路线",
    picker: "worldmap",
  },
  {
    key: "lockMap_x",
    label: "挂机基准坐标 X",
    help: "随机行走在挂机图中的基准坐标 X，留空则随机取点。",
    type: "int",
    group: "路线",
  },
  {
    key: "lockMap_y",
    label: "挂机基准坐标 Y",
    help: "随机行走在挂机图中的基准坐标 Y，留空则随机取点。",
    type: "int",
    group: "路线",
  },
  {
    key: "lockMap_randX",
    label: "基准随机半径 X",
    help: "以基准坐标为中心的 X 方向随机半径，KE 默认 0。",
    type: "int",
    suffix: "格",
    group: "路线",
  },
  {
    key: "lockMap_randY",
    label: "基准随机半径 Y",
    help: "以基准坐标为中心的 Y 方向随机半径，KE 默认 0。",
    type: "int",
    suffix: "格",
    group: "路线",
  },
  {
    key: "route_randomWalk",
    label: "走动寻怪",
    help: "在挂机图里怎么找怪。关闭=站在原地等怪；KE模式=随机走动；优化模式=沿地图路线系统扫图。",
    type: "enum",
    default: "2",
    group: "路线",
    options: [
      { value: "0", label: "关闭" },
      { value: "1", label: "KE 模式" },
      { value: "2", label: "优化模式" },
    ],
  },
  {
    key: "route_randomWalk_inTown",
    label: "城镇内随机行走",
    help: "是否允许在城镇里随机走动。",
    type: "enum",
    options: ON_OFF,
    group: "路线",
  },
  {
    key: "route_randomWalk_inLockOnly",
    label: "仅锁图内随机行走",
    help: "开启后只在挂机地图内随机行走，别的图不乱走。",
    type: "enum",
    options: ON_OFF,
    group: "路线",
  },
  {
    key: "route_randomWalk_maxRouteTime",
    label: "随机行走路线时限",
    help: "单次随机行走路线耗时上限（秒），0=不限。KE 默认 75。",
    type: "int",
    suffix: "秒",
    group: "路线",
  },
  {
    key: "route_step",
    label: "路线分段步数",
    help: "路线分段长度：每次下发的最大步数（1-32，默认 10）。KE 实际下发不会超过 17——LastRO 服务器单次步行请求最远 17 格（实测 17 格能走、18 格被忽略）。建议保持默认 10。",
    type: "int",
    suffix: "格",
    group: "路线",
  },
  {
    key: "route_teleport",
    label: "瞬移赶路",
    help: "去锁图路上是否用传送快速赶路。",
    type: "enum",
    default: "1",
    group: "路线",
    options: ON_OFF,
  },
  {
    key: "route_teleport_minDistance",
    label: "大于此距离使用瞬移赶路",
    help: "离目标超过这个距离就用瞬移赶路，否则走过去。",
    type: "int",
    default: "150",
    suffix: "格",
    group: "路线",
  },
  {
    key: "route_teleport_maxTries",
    label: "瞬移最大尝试次数",
    help: "瞬移赶路最多试几次，避免无限瞬移。",
    type: "int",
    default: "30",
    group: "路线",
  },
  {
    key: "route_teleport_notInMaps",
    label: "不瞬移的地图",
    help: "这些地图里不瞬移赶路（如城镇，避免误操作），逗号分隔。",
    type: "string",
    group: "路线",
  },
  {
    key: "lastro_airshipRoute",
    label: "允许直接传送",
    help: "路线规划时允许使用直接传送（KE 默认开启）。关闭后跨图赶路不走直接传送。",
    type: "enum",
    default: "1",
    options: ON_OFF,
    group: "路线",
  },
  {
    key: "lastro_airshipRoute_timeout",
    label: "直接传送超时",
    help: "直接传送等待确认的最长秒数，超时算失败。",
    type: "int",
    suffix: "秒",
    group: "路线",
  },
  {
    key: "lastro_airshipRoute_extraMaps",
    label: "直接传送额外白名单地图",
    help: "追加允许直接传送到达的地图，与内置白名单合并，对路线规划和补给回城都生效。大小写和 .gat 后缀不敏感，可搜索添加多张地图。",
    type: "maps",
    group: "路线",
  },
  {
    key: "lastro_airship_recovery_timeout",
    label: "直接传送恢复超时",
    help: "直接传送失败后的恢复等待秒数。",
    type: "int",
    suffix: "秒",
    group: "路线",
  },
  {
    key: "lastro_airship_failure_cooldown",
    label: "直接传送失败冷却",
    help: "直接传送失败后多久内不再重试。",
    type: "int",
    suffix: "秒",
    group: "路线",
  },

  // —— 传送 ——
  {
    key: "teleportAuto_hp",
    label: "HP 低于（%）传送",
    help: "HP 掉到这个百分比以下就瞬移逃跑保命。",
    type: "int",
    default: "30",
    suffix: "%",
    group: "传送",
  },
  {
    key: "teleportAuto_sp",
    label: "SP 低于（%）传送",
    help: "SP 掉到这个百分比以下就瞬移。",
    type: "int",
    default: "0",
    suffix: "%",
    group: "传送",
  },
  {
    key: "teleportAuto_deadly",
    label: "致命状态传送",
    help: "中了致命状态（如冰冻、石化）是否瞬移。",
    type: "enum",
    default: "1",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_useSkill",
    label: "使用技能传送",
    help: "用「瞬间移动」技能瞬移（需要学会该技能）；关闭则用蝴蝶翅膀/苍蝇翅膀道具。",
    type: "enum",
    default: "1",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_idle",
    label: "瞬移寻怪",
    help: "空闲没怪时是否瞬移到别处找怪。",
    type: "enum",
    default: "0",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_maxDmg",
    label: "受击伤害上限传送",
    help: "单次受到的伤害超过这个值就瞬移。",
    type: "int",
    default: "500",
    group: "传送",
  },
  {
    key: "teleportAuto_unstuck",
    label: "卡住时传送",
    help: "被卡住走不动时是否瞬移脱离。",
    type: "enum",
    default: "1",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_portal",
    label: "遇到传送点瞬移",
    help: "走到传送点/传送门时是否直接瞬移过去（而非走过去）。",
    type: "enum",
    default: "1",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_search",
    label: "专注模式(只打怪物规则中标记为专注模式的指定怪)",
    help: "只打指定怪、其它怪一律瞬移跳过（适合只刷 BOSS/指定怪的场景）。",
    type: "enum",
    default: "0",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_minAggressives",
    label: "被围攻数触发传送",
    help: "同时被多少只怪围攻就瞬移（0=关闭）。",
    type: "int",
    default: "0",
    group: "传送",
  },
  {
    key: "teleportAuto_minAggressivesInLock",
    label: "锁图内被围攻数触发",
    help: "挂机图内被围攻到多少只就瞬移。",
    type: "int",
    default: "0",
    group: "传送",
  },
  {
    key: "teleportAuto_maxDmgInLock",
    label: "锁图内受击上限",
    help: "挂机图内单次受击超过此值瞬移。",
    type: "int",
    default: "0",
    group: "传送",
  },
  {
    key: "teleportAuto_atkCount",
    label: "攻击次数触发传送",
    help: "连续攻击多少次还没打死就瞬移（0=关闭）。",
    type: "int",
    default: "0",
    group: "传送",
  },
  {
    key: "teleportAuto_atkMiss",
    label: "未命中次数触发",
    help: "连续攻击未命中多少次就瞬移（10=默认）。",
    type: "int",
    default: "10",
    group: "传送",
  },
  {
    key: "teleportAuto_lostTarget",
    label: "目标丢失传送",
    help: "打的怪突然消失（被抢/传送）时是否瞬移。",
    type: "enum",
    default: "0",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_dropTarget",
    label: "目标被抢传送",
    help: "目标被别人抢走时是否瞬移。",
    type: "enum",
    default: "0",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_dropTargetEngaged",
    label: "被抢且战斗中传送",
    help: "目标被抢且你还在被其它怪打时是否瞬移。",
    type: "enum",
    default: "1",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_dropTargetKS",
    label: "目标被抢杀传送",
    help: "目标被别人抢杀（KS）时是否瞬移。",
    type: "enum",
    default: "0",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_dropTargetHidden",
    label: "目标隐身传送",
    help: "目标隐身/消失时是否瞬移。",
    type: "enum",
    default: "0",
    group: "传送",
    options: ON_OFF,
  },
  {
    key: "teleportAuto_attackedWhenSitting",
    label: "坐下被攻击传送",
    help: "坐下回血时被攻击是否瞬移。「即使 0 伤害也传送」= 被摸到（哪怕没掉血）也立刻瞬移。",
    type: "enum",
    default: "0",
    group: "传送",
    options: [
      { value: "0", label: "关闭" },
      { value: "1", label: "被打就传送" },
      { value: "2", label: "即使 0 伤害也传送" },
    ],
  },
  {
    key: "teleportAuto_totalDmg",
    label: "累计伤害传送",
    help: "累计受到的伤害超过此值瞬移（0=关闭）。",
    type: "int",
    default: "0",
    group: "传送",
  },
  {
    key: "teleportAuto_totalDmgInLock",
    label: "锁图内累计伤害",
    help: "挂机图内累计受击超过此值瞬移。",
    type: "int",
    default: "0",
    group: "传送",
  },
  {
    key: "teleportAuto_equip_leftAccessory",
    label: "传送用左饰品",
    help: "瞬移时切换的左饰品（如瞬移夹）。",
    type: "string",
    group: "传送",
  },
  {
    key: "teleportAuto_equip_rightAccessory",
    label: "传送用右饰品",
    help: "瞬移时切换的右饰品。",
    type: "string",
    group: "传送",
  },
  {
    key: "teleportAuto_item1",
    label: "苍蝇翅膀或代替道具名称",
    help: "随机瞬移时优先使用这个道具代替苍蝇翅膀（输入关键字搜索选择）。留空则使用苍蝇翅膀。",
    type: "string",
    group: "传送",
    picker: "item",
  },
  {
    key: "teleportAuto_item2",
    label: "蝴蝶翅膀或代替道具名称",
    help: "回到储存点时优先使用这个道具代替蝴蝶翅膀（输入关键字搜索选择）。留空则使用蝴蝶翅膀。",
    type: "string",
    group: "传送",
    picker: "item",
  },

  // —— 坐下 ——
  {
    key: "sitAuto_hp_lower",
    label: "HP 低于（%）坐下",
    help: "HP 低于这个百分比就坐下回血。",
    type: "int",
    default: "40",
    suffix: "%",
    group: "坐下",
  },
  {
    key: "sitAuto_hp_upper",
    label: "HP 高于（%）站起",
    help: "HP 回到这个百分比以上就站起继续打。",
    type: "int",
    default: "100",
    suffix: "%",
    group: "坐下",
  },
  {
    key: "sitAuto_sp_lower",
    label: "SP 低于（%）坐下",
    help: "SP 低于这个百分比就坐下回蓝。",
    type: "int",
    default: "15",
    suffix: "%",
    group: "坐下",
  },
  {
    key: "sitAuto_sp_upper",
    label: "SP 高于（%）站起",
    help: "SP 回到这个百分比以上就站起。",
    type: "int",
    default: "80",
    suffix: "%",
    group: "坐下",
  },
  {
    key: "sitAuto_idle",
    label: "空闲时坐下",
    help: "没怪打、空闲时是否坐下加速回血回蓝。",
    type: "enum",
    default: "0",
    group: "坐下",
    options: ON_OFF,
  },
  {
    key: "sitAuto_follow",
    label: "跟随中坐下",
    help: "跟随别人时，对方坐下你是否也坐下。",
    type: "enum",
    default: "0",
    group: "坐下",
    options: ON_OFF,
  },
  {
    key: "sitAuto_overWeight",
    label: "超重仍坐下",
    help: "负重超重（70%/90% 状态）时是否仍允许坐下。",
    type: "enum",
    default: "0",
    group: "坐下",
    options: ON_OFF,
  },
  // sitAuto_over_50 是 overWeight 的旧兼容别名（KE 中 overWeight 优先）：不在表单展示，但旧 profile 里的值要原样保留。
  {
    key: "sitAuto_over_50",
    label: "负重超 50% 坐下",
    help: "sitAuto_overWeight 的兼容别名。",
    type: "enum",
    group: "坐下",
    options: ON_OFF,
    legacy: true,
  },

  // —— 拾取 ——
  {
    key: "itemsTakeAuto",
    label: "自动拾取",
    help: "是否自动捡地上的掉落物。0=不捡；1=捡身边的；2=追过去捡所有。",
    type: "enum",
    default: "2",
    group: "拾取",
    options: [
      { value: "0", label: "关闭" },
      { value: "1", label: "拾取范围内" },
      { value: "2", label: "拾取所有" },
    ],
  },
  {
    key: "itemsTakeAuto_party",
    label: "拾取队友物品",
    help: "是否捡队友（队伍）掉的东西。",
    type: "enum",
    default: "0",
    group: "拾取",
    options: ON_OFF,
  },
  {
    key: "itemsGatherAuto",
    label: "拾取无主物品",
    help: "捡那些不是自己打掉的、无主的地面物品。",
    type: "enum",
    default: "2",
    group: "拾取",
    options: [
      { value: "0", label: "关闭" },
      { value: "1", label: "范围内" },
      { value: "2", label: "所有" },
    ],
  },
  {
    key: "itemsMaxWeight",
    label: "拾取负重上限",
    help: "负重超过这个百分比就停止拾取/收集任何物品，并触发自动出售/存仓（触发存售的阈值可被下方「出售/存仓负重阈值」单独覆盖）。",
    type: "int",
    suffix: "%",
    default: "90",
    group: "拾取",
  },
  {
    key: "itemsMaxWeight_sellOrStore",
    label: "出售/存仓负重阈值",
    help: "负重达到这个百分比就触发去出售/存仓清包。",
    type: "int",
    suffix: "%",
    default: "70",
    group: "拾取",
  },

  // —— 跟随 ——
  {
    key: "follow",
    label: "跟随",
    help: "是否自动跟随别人。",
    type: "enum",
    default: "0",
    group: "跟随",
    options: ON_OFF,
  },
  {
    key: "followTarget",
    label: "跟随目标名称",
    help: "跟随的玩家角色名。",
    type: "string",
    group: "跟随",
  },
  {
    key: "followDistanceMax",
    label: "跟随最大距离",
    help: "和目标超过这个距离就追上去。",
    type: "int",
    default: "6",
    suffix: "格",
    group: "跟随",
  },
  {
    key: "followDistanceMin",
    label: "跟随最小距离",
    help: "和目标小于这个距离就停一下，避免贴太近。",
    type: "int",
    default: "3",
    suffix: "格",
    group: "跟随",
  },
  {
    key: "followLostStep",
    label: "丢失步数",
    help: "走了多少步还找不到跟随目标就停下。",
    type: "int",
    default: "12",
    group: "跟随",
  },
  {
    key: "followSitAuto",
    label: "跟随坐下",
    help: "跟随目标坐下时你是否也坐下。",
    type: "enum",
    default: "0",
    group: "跟随",
    options: ON_OFF,
  },

  // —— 修理 ——
  {
    key: "repairAuto",
    label: "自动修理",
    help: "装备耐久掉了是否自动去找 NPC 修理。",
    type: "enum",
    default: "0",
    group: "修理",
    options: ON_OFF,
  },
  {
    key: "repairAuto_list",
    label: "修理物品列表",
    help: "要修理的装备列表（逗号分隔）。",
    type: "string",
    group: "修理",
  },
  {
    key: "repairAuto_npc",
    label: "修理 NPC 位置",
    help: "修理 NPC 的坐标（格式：地图 x y，如 prontera 123 45）。OpenKore 只需要坐标，不需要 NPC 名字。",
    type: "string",
    group: "修理",
  },
  {
    key: "repairAuto_npc_steps",
    label: "修理对话步骤",
    help: "与修理 NPC 的对话指令序列（如 c r0 c r0 n）。",
    type: "string",
    group: "修理",
  },

  // —— 技能 ——
  {
    key: "useSelf_skill_smartHeal",
    label: "智能治疗",
    help: "根据 HP/SP 情况智能决定用哪个治疗技能，而不是按固定顺序。",
    type: "enum",
    default: "1",
    group: "技能",
    options: ON_OFF,
  },

  // —— 商店仓库 ——
  {
    key: "sellAuto",
    label: "自动出售",
    help: "是否自动把不需要的物品卖给 NPC。",
    type: "enum",
    default: "1",
    group: "商店仓库",
    options: ON_OFF,
  },
  {
    key: "sellAuto_npc",
    label: "出售 NPC 位置",
    help: "卖东西的 NPC 坐标（格式：地图 x y，如 prontera 105 87）。OpenKore 只需要坐标，不需要 NPC 名字。",
    type: "string",
    default: "prontera 105 87",
    group: "商店仓库",
  },
  {
    key: "sellAuto_distance",
    label: "出售距离",
    help: "离 NPC 多远就触发出售。",
    type: "int",
    default: "3",
    group: "商店仓库",
  },
  {
    key: "sellAuto_npc_steps",
    label: "出售对话步骤",
    help: "与出售 NPC 的对话指令（默认 s）。",
    type: "string",
    default: "s",
    group: "商店仓库",
  },
  {
    key: "storageAuto",
    label: "自动存仓",
    help: "是否自动把物品存入仓库。",
    type: "enum",
    default: "1",
    group: "商店仓库",
    options: ON_OFF,
  },
  {
    key: "storageAuto_npc",
    label: "仓库 NPC 位置",
    help: "仓库 NPC 的坐标（格式：地图 x y，如 prontera 146 89）。OpenKore 只需要坐标，不需要 NPC 名字。",
    type: "string",
    default: "prontera 146 89",
    group: "商店仓库",
  },
  {
    key: "storageAuto_npc_type",
    label: "仓库 NPC 类型",
    help: "仓库 NPC 的类型编号。",
    type: "int",
    default: "1",
    group: "商店仓库",
  },
  {
    key: "storageAuto_type",
    label: "仓库类型",
    help: "仓库类型编号。",
    type: "int",
    default: "0",
    group: "商店仓库",
  },
  {
    key: "storageAuto_npc_steps",
    label: "仓库对话步骤",
    help: "与仓库 NPC 的对话指令（如 c r1 n）。",
    type: "string",
    group: "商店仓库",
  },
  {
    key: "storageAuto_distance",
    label: "仓库距离",
    help: "离仓库 NPC 多远就触发存仓。",
    type: "int",
    group: "商店仓库",
  },
  {
    key: "storageAuto_password",
    label: "仓库密码",
    help: "仓库密码（若设置了密码）。",
    type: "string",
    group: "商店仓库",
  },

  // —— NPC 对话 ——
  {
    key: "autoTalkCont",
    label: "自动继续对话",
    help: "NPC 对话出现「继续」时自动点击继续。KE 默认开启。",
    type: "enum",
    default: "1",
    options: ON_OFF,
    group: "NPC 对话",
  },
  {
    key: "npcTimeResponse",
    label: "NPC 响应等待",
    help: "等待 NPC 响应的秒数，KE 默认 5（实际不会低于 5）。",
    type: "int",
    suffix: "秒",
    group: "NPC 对话",
  },
  {
    key: "npcWrongStepsMethod",
    label: "对话步骤出错处理",
    help: "预设的 NPC 对话步骤与实际对话不符时怎么办。KE 仅支持 0/1/2。",
    type: "enum",
    options: [
      { value: "0", label: "清空剩余步骤，等待手动处理" },
      { value: "1", label: "跳过出错步骤，继续下一步" },
      { value: "2", label: "尝试取消对话（自动继续直到结束）" },
    ],
    group: "NPC 对话",
  },
];

export type ConfigValues = Record<string, string>;

// —— block ——

export type ConditionGroup =
  | "self"
  | "monster"
  | "player"
  | "equipSelf"
  | "equipMonster";

export interface BlockFieldDef {
  key: string;
  label: string;
  help: string;
  type: "int" | "string" | "enum" | "monsters";
  options?: ScalarOption[];
  /** 特殊输入控件：'item' = 道具搜索选择器（存道具名称）。 */
  picker?: "item";
}

export interface BlockDef {
  type: string;
  label: string;
  help: string;
  selectorKind: "skill" | "item" | "none" | "monsters";
  fields: BlockFieldDef[];
  conditions: ConditionGroup[];
  /** 新增卡片时预填的字段/条件（如 buyAuto 默认指向普隆德拉道具商人）。 */
  defaults?: {
    fields?: Record<string, string>;
    conditions?: Record<string, string>;
  };
}

export interface BlockValue {
  selector: string;
  fields: Record<string, string>;
  conditions: Record<string, string>;
}

export interface ConditionKeyDef {
  key: string;
  label: string;
  hint?: string;
  help: string;
  /**
   * 条件值的输入控件类型，默认 'text'：
   * - comparisonPercent：操作符 + 数值 + % 后缀（默认 %）
   * - comparisonNum：操作符 + 数值
   * - status：Buff 状态搜索选择器
   * - bool：是/否分段开关（存 0/1）
   * - monsters：怪物多选（chips + 搜索，存逗号分隔 ID）
   * - itemAmount：物品单选 + 操作符 + 数值（存 "名称 > 1"）
   * - itemAmountId：同上，但物品存 ID（存 "501 > 1"）
   * - map：地图搜索选择器
   * - job：职业搜索选择器（存职业英文名）
   * - skill：技能搜索选择器（存技能 ID）
   * - enum：options 分段选择
   */
  widget?:
    | "text"
    | "comparisonPercent"
    | "comparisonNum"
    | "status"
    | "bool"
    | "monsters"
    | "itemAmount"
    | "itemAmountId"
    | "map"
    | "job"
    | "skill"
    | "enum";
  /** widget 为 'enum' 时的选项。 */
  options?: ScalarOption[];
}

export const BLOCK_DEFS: BlockDef[] = [
  {
    type: "attackSkillSlot",
    label: "攻击技能",
    selectorKind: "skill",
    help: "用技能攻击怪物。可以加多个，配条件决定什么时候用哪个技能。",
    fields: [
      {
        key: "lvl",
        label: "技能等级",
        help: "使用该技能的等级（1-10）。",
        type: "int",
      },
      {
        key: "dist",
        label: "施放距离",
        help: "逼近到与目标距离不超过此值时开始放技能。",
        type: "int",
      },
      {
        key: "maxDist",
        label: "最大距离",
        help: "最远能放多远，不写则等于施放距离。",
        type: "int",
      },
      {
        key: "maxCastTime",
        label: "最大咏唱（秒）",
        help: "咏唱超过这个时间的技能不自动放。",
        type: "int",
      },
      {
        key: "minCastTime",
        label: "最小咏唱（秒）",
        help: "咏唱低于这个时间的技能不自动放。",
        type: "int",
      },
      {
        key: "maxAttempts",
        label: "最大尝试次数",
        help: "这个技能最多连续尝试几次。",
        type: "int",
      },
      {
        key: "maxUses",
        label: "最大使用次数",
        help: "这个技能最多用几次。",
        type: "int",
      },
      {
        key: "isSelfSkill",
        label: "目标是自己",
        help: "是否对自己放（治疗/增益）。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "isStartSkill",
        label: "起手技能",
        help: "是否作为开打的第一招。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "monsters",
        label: "仅对怪物",
        help: "只对这里列的怪物用这个技能。",
        type: "monsters",
      },
      {
        key: "notMonsters",
        label: "排除怪物",
        help: "对这些怪物不用这个技能。",
        type: "monsters",
      },
      {
        key: "equip_topHead",
        label: "放技能换装：上头部",
        help: "释放该技能前换上的上头部装备（物品名）。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_midHead",
        label: "放技能换装：中头部",
        help: "释放该技能前换上的中头部装备。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_lowHead",
        label: "放技能换装：下头部",
        help: "释放该技能前换上的下头部装备。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_leftHand",
        label: "放技能换装：左手",
        help: "释放该技能前换上的左手武器。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_rightHand",
        label: "放技能换装：右手",
        help: "释放该技能前换上的右手武器。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_leftAccessory",
        label: "放技能换装：左饰品",
        help: "释放该技能前换上的左饰品。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_rightAccessory",
        label: "放技能换装：右饰品",
        help: "释放该技能前换上的右饰品。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_robe",
        label: "放技能换装：披肩",
        help: "释放该技能前换上的披肩。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_armor",
        label: "放技能换装：铠甲",
        help: "释放该技能前换上的铠甲。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_shoes",
        label: "放技能换装：鞋子",
        help: "释放该技能前换上的鞋子。",
        type: "string",
        picker: "item",
      },
      {
        key: "equip_arrow",
        label: "放技能换装：箭矢",
        help: "释放该技能前换上的箭矢。",
        type: "string",
        picker: "item",
      },
    ],
    conditions: ["self", "monster"],
  },
  {
    type: "useSelf_skill",
    label: "自身增益/治疗技能",
    selectorKind: "skill",
    help: "对自己放的增益或治疗技能（如加速、治愈）。",
    fields: [
      {
        key: "lvl",
        label: "技能等级",
        help: "使用该技能的等级。",
        type: "int",
      },
      {
        key: "maxCastTime",
        label: "最大咏唱（秒）",
        help: "咏唱超过这个时间不自动放。",
        type: "int",
      },
      {
        key: "minCastTime",
        label: "最小咏唱（秒）",
        help: "咏唱低于这个时间不自动放。",
        type: "int",
      },
      {
        key: "smartEncore",
        label: "自动安可",
        help: "舞娘/诗人专用：演奏技能结束后自动对自己使用安可，重复上一首演奏。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "noSmartHeal",
        label: "不使用智能治疗",
        help: "开启后该技能不使用智能治疗，按固定规则放。默认关闭（即使用智能治疗）。",
        type: "enum",
        options: ON_OFF,
      },
    ],
    conditions: ["self"],
  },
  {
    type: "partySkill",
    label: "队伍技能",
    selectorKind: "skill",
    help: "对队友放的技能（如给队友加血、加速）。",
    fields: [
      {
        key: "lvl",
        label: "技能等级",
        help: "使用该技能的等级。",
        type: "int",
      },
      {
        key: "dist",
        label: "施放距离",
        help: "逼近到与队友距离不超过此值时开始放技能。",
        type: "int",
      },
      {
        key: "maxDist",
        label: "最大距离",
        help: "最远能放多远，不写则等于施放距离。",
        type: "int",
      },
      {
        key: "maxCastTime",
        label: "最大咏唱（秒）",
        help: "咏唱超过这个时间不自动放。",
        type: "int",
      },
      {
        key: "minCastTime",
        label: "最小咏唱（秒）",
        help: "咏唱低于这个时间不自动放。",
        type: "int",
      },
      {
        key: "target",
        label: "目标",
        help: "对哪个队友放（角色名）。",
        type: "string",
      },
      {
        key: "notPartyOnly",
        label: "不限于队伍",
        help: "是否也对非队友的玩家放。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "isSelfSkill",
        label: "目标是自己",
        help: "是否也对自己放。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "noSmartHeal",
        label: "不使用智能治疗",
        help: "开启后该技能不使用智能治疗，按固定规则放。默认关闭（即使用智能治疗）。",
        type: "enum",
        options: ON_OFF,
      },
    ],
    conditions: ["self", "player"],
  },
  {
    type: "useSelf_item",
    label: "自身使用物品",
    selectorKind: "item",
    help: "自动使用消耗品（如药水）。",
    fields: [
      {
        key: "dcOnEmpty",
        label: "用完断线",
        help: "物品用完时是否断线下线保护。",
        type: "enum",
        options: ON_OFF,
      },
    ],
    conditions: ["self"],
  },
  {
    type: "buyAuto",
    label: "自动购买",
    selectorKind: "item",
    help: "自动从 NPC 买补给（如药水、箭矢）。",
    fields: [
      {
        key: "npc",
        label: "NPC 位置",
        help: "卖这个物品的 NPC 坐标（格式：地图 x y，默认是普隆德拉道具商人 prt_in 126 76）。OpenKore 只需要坐标，不需要 NPC 名字。",
        type: "string",
      },
      {
        key: "npc_steps",
        label: "对话步骤",
        help: "与 NPC 的对话指令（如 b 打开商店）。",
        type: "string",
      },
      {
        key: "isMarket",
        label: "市场商人",
        help: "开启后按市场商人流程购买（LastRO 市场摊位类 NPC）。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "onlyIdentified",
        label: "只买已鉴定",
        help: "开启后只购买已鉴定的物品。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "distance",
        label: "距离",
        help: "离 NPC 多远触发购买。",
        type: "int",
      },
      {
        key: "minDistance",
        label: "最小距离",
        help: "触发购买距离的下限，默认 0。",
        type: "int",
      },
      {
        key: "maxDistance",
        label: "最大距离",
        help: "离 NPC 多远算到达（上限 32）；填写后优先于「距离」。",
        type: "int",
      },
      {
        key: "price",
        label: "价格上限",
        help: "超过这个单价就不买。",
        type: "int",
      },
      {
        key: "minAmount",
        label: "最小数量",
        help: "库存低于这个数量就补货。",
        type: "int",
      },
      {
        key: "maxAmount",
        label: "最大数量",
        help: "补货补到这个数量。",
        type: "int",
      },
      {
        key: "batchSize",
        label: "批量大小",
        help: "一次买多少。",
        type: "int",
      },
      {
        key: "dcOnEmpty",
        label: "买空断线",
        help: "NPC 没货时是否断线。",
        type: "enum",
        options: ON_OFF,
      },
    ],
    conditions: ["self"],
    defaults: {
      fields: {
        npc: "prt_in 126 76",
        npc_steps: "b",
        distance: "3",
        minAmount: "0",
        maxAmount: "10",
      },
      conditions: { zeny: "> 25000" },
    },
  },
  {
    type: "getAuto",
    label: "自动取物（仓库）",
    selectorKind: "item",
    help: "自动从仓库取补给。",
    fields: [
      {
        key: "minAmount",
        label: "最小数量",
        help: "身上低于这个数量就从仓库取。",
        type: "int",
      },
      {
        key: "maxAmount",
        label: "最大数量",
        help: "取到身上达到这个数量。",
        type: "int",
      },
      {
        key: "batchSize",
        label: "批量大小",
        help: "一次取多少。",
        type: "int",
      },
      {
        key: "passive",
        label: "被动",
        help: "只在顺路时取，不主动去仓库。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "dcOnEmpty",
        label: "取空断线",
        help: "仓库没货时是否断线。",
        type: "enum",
        options: ON_OFF,
      },
    ],
    conditions: ["self"],
  },
  {
    type: "equipAuto",
    label: "自动换装",
    selectorKind: "none",
    help: "按条件自动换装备：每个槽位写要换上的物品名（留空或写 0 表示不管该槽位），满足自身/怪物条件时触发。",
    fields: [
      {
        key: "topHead",
        label: "头上",
        help: "换上的上头部装备（物品名/ID）。留空或 0 表示不管。",
        type: "string",
        picker: "item",
      },
      {
        key: "midHead",
        label: "头中",
        help: "换上的中头部装备。",
        type: "string",
        picker: "item",
      },
      {
        key: "lowHead",
        label: "头下",
        help: "换上的下头部装备。",
        type: "string",
        picker: "item",
      },
      {
        key: "rightHand",
        label: "右手",
        help: "换上的右手武器。",
        type: "string",
        picker: "item",
      },
      {
        key: "leftHand",
        label: "左手",
        help: "换上的左手武器/盾牌。",
        type: "string",
        picker: "item",
      },
      {
        key: "leftAccessory",
        label: "左饰品",
        help: "换上的左饰品。",
        type: "string",
        picker: "item",
      },
      {
        key: "rightAccessory",
        label: "右饰品",
        help: "换上的右饰品。",
        type: "string",
        picker: "item",
      },
      {
        key: "robe",
        label: "披肩",
        help: "换上的披肩。",
        type: "string",
        picker: "item",
      },
      {
        key: "armor",
        label: "铠甲",
        help: "换上的铠甲。",
        type: "string",
        picker: "item",
      },
      {
        key: "shoes",
        label: "鞋子",
        help: "换上的鞋子。",
        type: "string",
        picker: "item",
      },
      {
        key: "arrow",
        label: "箭矢",
        help: "换上的箭矢。",
        type: "string",
        picker: "item",
      },
      {
        key: "weight",
        label: "负重触发条件",
        help: "纯数字如 50 表示负重 ≥50% 触发；也可写比较式如 < 80%。带 < > % 时当作通用负重条件。",
        type: "string",
      },
      {
        key: "whileSitting",
        label: "只在坐下时触发",
        help: "开启后只在坐下时触发换装。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "target",
        label: "攻击目标限定",
        help: "必须正在攻击名单里的怪物才触发（逗号分隔，all 表示任意）。没在攻击时不触发。",
        type: "monsters",
      },
    ],
    conditions: ["equipSelf", "equipMonster"],
  },
  // autoSwitch：按怪物名单触发的自动换武器（OpenKore 传统机制，equipAuto 是更灵活的现代版）
  {
    type: "autoSwitch",
    label: "自动切换武器",
    selectorKind: "monsters",
    help: "遇到指定怪物时自动切换武器/盾牌/箭矢。未命中任何 autoSwitch 块的怪物，会退回 autoSwitch_default_* 默认武器。distance 会临时覆盖攻击距离，useWeapon 会临时覆盖「使用武器攻击」，切到别的怪物后复原。",
    fields: [
      {
        key: "rightHand",
        label: "右手武器",
        help: "切换的右手武器名称。写 [NONE] 表示空手。",
        type: "string",
        picker: "item",
      },
      {
        key: "leftHand",
        label: "左手装备",
        help: "切换的左手武器/盾牌。双手武器请留空。",
        type: "string",
        picker: "item",
      },
      {
        key: "arrow",
        label: "箭矢",
        help: "切换的箭矢（远程职业）。",
        type: "string",
        picker: "item",
      },
      {
        key: "distance",
        label: "临时攻击距离",
        help: "命中此怪物时临时改成这个攻击距离（覆盖全局 attackDistance），切走复原。留空则不改。",
        type: "int",
      },
      {
        key: "useWeapon",
        label: "临时使用武器攻击",
        help: "命中此怪物时临时覆盖全局「使用武器攻击」开关，切走复原。留空则不改。",
        type: "enum",
        options: ON_OFF,
      },
    ],
    conditions: [],
  },
];

export const CONDITION_KEYS: Record<ConditionGroup, ConditionKeyDef[]> = {
  self: [
    {
      key: "hp",
      label: "自身 HP",
      widget: "comparisonPercent",
      help: "自身 HP 满足这个条件才触发（用 <、>、= 加数值和 %）。",
    },
    {
      key: "sp",
      label: "自身 SP",
      widget: "comparisonPercent",
      help: "自身 SP 满足这个条件才触发。",
    },
    {
      key: "weight",
      label: "负重",
      widget: "comparisonPercent",
      help: "负重满足这个条件才触发。",
    },
    {
      key: "zeny",
      label: "金币",
      widget: "comparisonNum",
      help: "身上金币满足这个条件才触发。",
    },
    {
      key: "spirit",
      label: "气弹数",
      widget: "comparisonNum",
      help: "气弹（念气）数量满足这个条件才触发。",
    },
    {
      key: "aggressives",
      label: "被围攻数量",
      widget: "comparisonNum",
      help: "正在围攻你的怪物数量满足条件才触发。",
    },
    {
      key: "whenStatusActive",
      label: "状态生效时",
      widget: "status",
      help: "身上有某个 Buff 状态时才触发。",
    },
    {
      key: "whenStatusInactive",
      label: "状态未生效时",
      widget: "status",
      help: "身上没有某个 Buff 状态时才触发。",
    },
    {
      key: "inMap",
      label: "在地图内",
      widget: "map",
      help: "在当前地图时才触发。",
    },
    {
      key: "notInMap",
      label: "不在地图内",
      widget: "map",
      help: "不在某个地图时才触发。",
    },
    {
      key: "monstersCount",
      label: "周围可见怪物数量",
      widget: "comparisonNum",
      help: "周围可见怪物数量满足条件才触发。",
    },
    {
      key: "monstersCountDist",
      label: "怪物数量统计范围",
      hint: "例：5",
      help: "统计多少格范围内的怪物数量（配合周围可见怪物数量使用）。",
    },
    {
      key: "timeout",
      label: "冷却时间",
      hint: "例：10",
      help: "上次使用后至少隔这么多秒才再次触发。",
    },
    {
      key: "disabled",
      label: "禁用此规则",
      widget: "bool",
      help: "开启后禁用这个技能/物品规则，不用删除卡片就能停用。",
    },
    {
      key: "manualAI",
      label: "AI 模式",
      widget: "enum",
      options: [
        { value: "0", label: "全自动模式" },
        { value: "1", label: "半自动模式" },
        { value: "2", label: "全模式下启用" },
      ],
      help: "0（默认）只在全自动时生效，1 只在半自动，2 两者都行。",
    },
    {
      key: "ap",
      label: "自身 AP",
      widget: "comparisonPercent",
      help: "自身 AP 满足这个条件才触发（可带 %）。",
    },
    {
      key: "partyAggressives",
      label: "队友被围攻数量",
      widget: "comparisonNum",
      help: "正在攻击队友的怪物数量满足条件才触发。",
    },
    {
      key: "whenIdle",
      label: "空闲时",
      widget: "bool",
      help: "开启后要求 AI 空闲才触发。",
    },
    {
      key: "whenNotIdle",
      label: "非空闲时",
      widget: "bool",
      help: "开启后要求 AI 不空闲才触发。",
    },
    {
      key: "notWhileSitting",
      label: "坐着时禁用",
      widget: "bool",
      help: "开启后：坐着时不触发。",
    },
    {
      key: "whenFollowing",
      label: "跟随中时",
      widget: "bool",
      help: "开启后要求正在跟随才触发。",
    },
    {
      key: "stopWhenHit",
      label: "被打时禁用",
      widget: "bool",
      help: "开启后：有怪物正在攻击你时不触发。",
    },
    {
      key: "whenGround",
      label: "地面技能在场",
      widget: "skill",
      help: "你释放的该地面技能在场才触发。",
    },
    {
      key: "whenNotGround",
      label: "地面技能不在场",
      widget: "skill",
      help: "你释放的该地面技能不在场才触发。",
    },
    {
      key: "defendMonsters",
      label: "必须被这些怪攻击",
      widget: "monsters",
      help: "正在攻击你的怪里必须有名单里的怪才触发。",
    },
    {
      key: "inInventory",
      label: "背包物品（名称）",
      widget: "itemAmount",
      help: "背包里某物品数量满足条件（如 红色药水 > 1），逗号分隔多项必须都满足。",
    },
    {
      key: "inInventoryID",
      label: "背包物品（ID）",
      widget: "itemAmountId",
      help: "按物品 ID 判断背包数量（如 501 > 1），逗号分隔多项必须都满足。",
    },
  ],
  monster: [
    {
      key: "target_hp",
      label: "目标 HP",
      widget: "comparisonPercent",
      help: "目标的 HP 满足条件才触发。",
    },
    {
      key: "target_dist",
      label: "目标距离",
      widget: "comparisonNum",
      help: "和目标距离满足条件才触发。",
    },
    {
      key: "target_deltaHp",
      label: "目标掉血",
      widget: "comparisonNum",
      help: "目标掉血量满足条件才触发。",
    },
    {
      key: "target_whenStatusActive",
      label: "目标状态生效",
      widget: "status",
      help: "目标身上有某个状态才触发。",
    },
    {
      key: "target_timeout",
      label: "目标冷却",
      hint: "例：5",
      help: "对同一目标隔这么多秒才再次触发。",
    },
    {
      key: "previousDamage",
      label: "已造成伤害",
      widget: "comparisonNum",
      help: "对目标已造成的累计伤害满足条件才放技能（OpenKore previousDamage，如 > 1000）。",
    },
    {
      key: "target_misses",
      label: "连续打偏次数",
      widget: "comparisonNum",
      help: "目标连续打偏你的次数满足条件才触发。",
    },
    {
      key: "target_totalMisses",
      label: "累计 Miss 次数",
      widget: "comparisonNum",
      help: "目标累计 Miss 次数满足条件才触发。",
    },
    {
      key: "target_whenStatusInactive",
      label: "目标状态未生效",
      widget: "status",
      help: "目标身上没有某个状态才触发。",
    },
    {
      key: "target_whenGround",
      label: "目标脚下有技能",
      widget: "skill",
      help: "目标脚下有该地面技能才触发。",
    },
    {
      key: "target_whenNotGround",
      label: "目标脚下无技能",
      widget: "skill",
      help: "目标脚下没有该地面技能才触发。",
    },
    {
      key: "target_is_aggressive",
      label: "目标主动攻击你",
      widget: "bool",
      help: "开启表示目标正在攻击你，关闭表示没有。",
    },
    {
      key: "target_is_aggressive_party",
      label: "目标主动攻击队友",
      widget: "bool",
      help: "开启表示目标正在攻击队友，关闭表示没有。",
    },
  ],
  player: [
    {
      key: "target_hp",
      label: "目标 HP",
      widget: "comparisonPercent",
      help: "目标玩家 HP 满足条件才触发。",
    },
    {
      key: "target_dist",
      label: "目标距离",
      widget: "comparisonNum",
      help: "和目标玩家距离满足条件才触发。",
    },
    {
      key: "target_isJob",
      label: "目标职业",
      widget: "job",
      help: "目标玩家是某个职业才触发。",
    },
    {
      key: "target_whenStatusActive",
      label: "目标状态生效",
      widget: "status",
      help: "目标玩家身上有某个状态才触发。",
    },
    {
      key: "target_timeout",
      label: "目标冷却",
      hint: "例：5",
      help: "对同一目标玩家隔这么多秒才再次触发。",
    },
    {
      key: "target_whenStatusInactive",
      label: "目标状态未生效",
      widget: "status",
      help: "目标玩家身上没有某个状态才触发（如祝福没了就补祝福）。",
    },
    {
      key: "target_deltaHp",
      label: "目标掉血",
      widget: "comparisonNum",
      help: "目标玩家累计掉血量满足条件才触发。",
    },
    {
      key: "target_isNotJob",
      label: "排除目标职业",
      widget: "job",
      help: "目标玩家不是某个职业才触发。",
    },
    {
      key: "target_aggressives",
      label: "目标被围攻数量",
      widget: "comparisonNum",
      help: "正在攻击目标的怪物数量满足条件才触发。",
    },
    {
      key: "target_monsters",
      label: "目标周围怪物名单",
      widget: "monsters",
      help: "目标周围的怪里有名单里的怪才触发。",
    },
    {
      key: "target_whenGround",
      label: "目标脚下有技能",
      widget: "skill",
      help: "目标脚下有该地面技能才触发。",
    },
    {
      key: "target_whenNotGround",
      label: "目标脚下无技能",
      widget: "skill",
      help: "目标脚下没有该地面技能才触发。",
    },
    {
      key: "target_dead",
      label: "目标已死亡",
      widget: "bool",
      help: "开启后要求目标已死亡（用于复活类技能）。",
    },
    {
      key: "target_spirit",
      label: "目标气弹数",
      widget: "comparisonNum",
      help: "目标的气弹数量满足条件才触发。",
    },
  ],
  // equipAuto 专用：自身条件（每个块都判断）
  equipSelf: [
    {
      key: "disabled",
      label: "禁用此规则",
      widget: "bool",
      help: "开启后禁用这个换装块。",
    },
    {
      key: "hp",
      label: "自身 HP",
      widget: "comparisonPercent",
      help: "自身 HP 满足条件才触发（可带 %）。",
    },
    {
      key: "sp",
      label: "自身 SP",
      widget: "comparisonPercent",
      help: "自身 SP 满足条件才触发（可带 %）。",
    },
    {
      key: "ap",
      label: "自身 AP",
      widget: "comparisonPercent",
      help: "自身 AP 满足条件才触发（可带 %）。",
    },
    {
      key: "zeny",
      label: "金币",
      widget: "comparisonNum",
      help: "身上金币满足条件才触发。",
    },
    {
      key: "spirit",
      label: "气球/子弹数",
      widget: "comparisonNum",
      help: "气球/子弹数量满足条件才触发，缺失按 0。",
    },
    {
      key: "aggressives",
      label: "被围攻数量",
      widget: "comparisonNum",
      help: "正在攻击你的怪物数量满足条件才触发。",
    },
    {
      key: "partyAggressives",
      label: "队友被围攻数量",
      widget: "comparisonNum",
      help: "正在攻击队友的怪物数量满足条件才触发。",
    },
    {
      key: "stopWhenHit",
      label: "被打时禁用",
      widget: "bool",
      help: "开启后：有怪物正在攻击你时禁用这个块。",
    },
    {
      key: "whenIdle",
      label: "空闲时",
      widget: "bool",
      help: "开启后要求 AI 空闲才触发。",
    },
    {
      key: "whenNotIdle",
      label: "非空闲时",
      widget: "bool",
      help: "开启后要求 AI 不空闲才触发。",
    },
    {
      key: "manualAI",
      label: "AI 模式",
      widget: "enum",
      options: [
        { value: "0", label: "全自动模式" },
        { value: "1", label: "半自动模式" },
        { value: "2", label: "全模式下启用" },
      ],
      help: "0（默认）只在全自动时生效，1 只在半自动，2 两者都行。",
    },
    {
      key: "notWhileSitting",
      label: "坐着时禁用",
      widget: "bool",
      help: "开启后：坐着时不触发。",
    },
    {
      key: "whenFollowing",
      label: "跟随中时",
      widget: "bool",
      help: "开启后要求正在跟随才触发。",
    },
    {
      key: "whenStatusActive",
      label: "状态生效时",
      widget: "status",
      help: "身上有某个状态才触发。",
    },
    {
      key: "whenStatusInactive",
      label: "状态未生效时",
      widget: "status",
      help: "身上没有某个状态才触发（没有状态证据时视为成立）。",
    },
    {
      key: "timeout",
      label: "冷却时间",
      hint: "例：30",
      help: "距离上次触发超过这么多秒才再次触发。",
    },
    {
      key: "monsters",
      label: "攻击者含怪物",
      widget: "monsters",
      help: "正在攻击你的怪里有名单里的怪才触发。",
    },
    {
      key: "notMonsters",
      label: "攻击者不含怪物",
      widget: "monsters",
      help: "正在攻击你的怪里没有名单里的怪才触发。",
    },
    {
      key: "defendMonsters",
      label: "必须被这些怪攻击",
      widget: "monsters",
      help: "正在攻击你的怪里必须有名单里的怪才触发。",
    },
    {
      key: "monstersCount",
      label: "视野内怪物数量",
      widget: "comparisonNum",
      help: "视野内（可被 monsters/notMonsters 过滤）的怪物数量满足条件才触发。",
    },
    {
      key: "monstersCountDist",
      label: "怪物数量统计范围",
      hint: "例：5",
      help: "统计多少格范围内的怪物数量（最大距离）。",
    },
    {
      key: "inInventory",
      label: "背包物品（名称）",
      widget: "itemAmount",
      help: "背包里某物品数量满足条件（如 红色药水 > 1），逗号分隔多项必须都满足。",
    },
    {
      key: "inInventoryID",
      label: "背包物品（ID）",
      widget: "itemAmountId",
      help: "按物品 ID 判断背包数量（如 501 > 1），逗号分隔多项必须都满足。",
    },
    {
      key: "whenGround",
      label: "地面技能在场",
      widget: "skill",
      help: "你释放的该地面技能在场才触发。",
    },
    {
      key: "whenNotGround",
      label: "地面技能不在场",
      widget: "skill",
      help: "你释放的该地面技能不在场才触发。",
    },
    {
      key: "inMap",
      label: "在地图内",
      widget: "map",
      help: "当前地图在列表里才触发。",
    },
    {
      key: "notInMap",
      label: "不在地图内",
      widget: "map",
      help: "当前地图不在列表里才触发。",
    },
  ],
  // equipAuto 专用：怪物条件（只在正在攻击怪物时判断，没攻击时不参与；目标已死则不成立）
  equipMonster: [
    {
      key: "target_hp",
      label: "怪物 HP",
      widget: "comparisonPercent",
      help: "怪物血量满足条件（带 % 按百分比）。需要服务器提供血量，拿不到就不成立。",
    },
    {
      key: "target_dist",
      label: "怪物距离",
      widget: "comparisonNum",
      help: "与怪物的距离（格，取横纵差的较大值）满足条件才触发。",
    },
    {
      key: "target_deltaHp",
      label: "怪物掉血",
      widget: "comparisonNum",
      help: "怪物血量最近一次的变化量满足条件才触发。",
    },
    {
      key: "target_misses",
      label: "连续打偏次数",
      widget: "comparisonNum",
      help: "该怪连续打偏你的次数满足条件才触发。",
    },
    {
      key: "target_totalMisses",
      label: "累计 Miss 次数",
      widget: "comparisonNum",
      help: "累计 Miss 次数满足条件才触发。",
    },
    {
      key: "target_whenStatusActive",
      label: "怪物状态生效",
      widget: "status",
      help: "怪物身上有某状态（名字或 ID，逗号分隔）才触发。",
    },
    {
      key: "target_whenStatusInactive",
      label: "怪物状态未生效",
      widget: "status",
      help: "怪物身上没有某状态才触发。",
    },
    {
      key: "target_whenGround",
      label: "怪物脚下有技能",
      widget: "skill",
      help: "怪物脚下有该地面技能才触发。",
    },
    {
      key: "target_whenNotGround",
      label: "怪物脚下无技能",
      widget: "skill",
      help: "怪物脚下没有该地面技能才触发。",
    },
    {
      key: "target_is_aggressive",
      label: "怪物主动攻击你",
      widget: "bool",
      help: "开启表示该怪正在攻击你，关闭表示没有。",
    },
    {
      key: "target_is_aggressive_party",
      label: "怪物主动攻击队友",
      widget: "bool",
      help: "开启表示该怪正在攻击队友，关闭表示没有。",
    },
  ],
};

export function conditionKeysOf(group: ConditionGroup): ConditionKeyDef[] {
  return CONDITION_KEYS[group];
}

export function conditionGroupLabel(group: ConditionGroup): string {
  if (group === "self") return "自身条件";
  if (group === "monster") return "怪物条件";
  if (group === "equipSelf") return "自身条件";
  if (group === "equipMonster") return "怪物条件";
  return "玩家条件";
}

// —— 序列化 / 解析 ——

export interface ConfigDoc {
  scalars: ConfigValues;
  blocks: Record<string, BlockValue[]>;
}

function isConditionKey(key: string): boolean {
  return Object.values(CONDITION_KEYS).some((keys) =>
    keys.some((k) => k.key === key),
  );
}

export function emptyDoc(): ConfigDoc {
  return { scalars: {}, blocks: {} };
}

/** 新 Profile 的默认配置：标量填默认值，block 留空（由用户按需添加）。 */
export function defaultDoc(): ConfigDoc {
  const scalars: ConfigValues = {};
  for (const scalar of CONFIG_SCALARS) {
    if (scalar.default !== undefined) scalars[scalar.key] = scalar.default;
  }
  return { scalars, blocks: {} };
}

/**
 * 全角符号归一化：把中文输入法下常见的全角符号/数字转成半角。
 * 用户输入「＜５」这类全角写法既会导致保存校验报错，写进配置文件 KE 也解析不了，
 * 因此解析、校验、序列化三处统一归一化；输入框中也会即时替换，用户能立刻看到。
 * 只转换配置语法相关的字符（不含全角括号/引号/字母），避免改动物品名、怪物名。
 */
const FULL_WIDTH_SYMBOLS: Record<string, string> = {
  "＜": "<",
  "＞": ">",
  "＝": "=",
  "！": "!",
  "～": "~",
  "，": ",",
  "％": "%",
  "＊": "*",
  "？": "?",
  "．": ".",
  "－": "-",
  "＋": "+",
  "　": " ",
};
const FULL_WIDTH_SYMBOL_RE = /[＜＞＝！～，％＊？．－＋\u3000]/gu;
const FULL_WIDTH_DIGIT_RE = /[０-９]/gu;

/** 把全角符号/全角数字转成半角，返回规范化后的文本。 */
export function normalizeFullWidth(value: string): string {
  return value
    .replace(FULL_WIDTH_SYMBOL_RE, (ch) => FULL_WIDTH_SYMBOLS[ch] ?? ch)
    .replace(FULL_WIDTH_DIGIT_RE, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    );
}

/** 把表单模型序列化成 config.txt 文本。 */
export function serializeConfig(doc: ConfigDoc): string {
  const lines: string[] = [];
  for (const scalar of CONFIG_SCALARS) {
    const value = doc.scalars[scalar.key];
    if (value !== undefined && value !== "")
      lines.push(`${scalar.key} ${normalizeFullWidth(value)}`);
  }
  for (const def of BLOCK_DEFS) {
    for (const block of doc.blocks[def.type] ?? []) {
      if (def.selectorKind === "none") {
        lines.push(`${def.type} {`);
      } else if (
        def.selectorKind === "monsters" &&
        block.selector.trim() === ""
      ) {
        // autoSwitch 允许空 monster names = 对所有怪生效
        lines.push(`${def.type} {`);
      } else {
        if (block.selector === "") continue;
        lines.push(`${def.type} ${block.selector} {`);
      }
      for (const field of def.fields) {
        const value = block.fields[field.key];
        if (value !== undefined && value !== "")
          lines.push(`\t${field.key} ${normalizeFullWidth(value)}`);
      }
      for (const [key, value] of Object.entries(block.conditions)) {
        if (value !== undefined && value !== "")
          lines.push(`\t${key} ${normalizeFullWidth(value)}`);
      }
      lines.push("}");
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * 删除所有以 # 开头的整行注释。
 * KE 只把「整行 #」当注释；行内 # 会留在值里（如 `useSelf_skill 8 # 霸体 {`
 * 会被解析成错误技能名），因此保存前统一剥掉注释行。
 */
export function stripConfigComments(text: string): string {
  const kept = text.split(/\r?\n/).filter((line) => !line.trim().startsWith("#"));
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return body === "" ? "" : `${body}\n`;
}

// —— 保存前校验 ——

/** 比较表达式合法格式：> 5、>= 5、< 5%、= 5、3..8、3-8、纯数字（等于）。 */
const COMPARISON_VALUE_PATTERN = /^(?:[<>=!]+\s*)?[\d.]+\s*%?$/;
const RANGE_VALUE_PATTERN = /^[\d.]+%?\s*(?:\.\.|-)\s*[\d.]+%?$/;

function isValidComparisonValue(text: string): boolean {
  const trimmed = normalizeFullWidth(text).trim();
  return (
    COMPARISON_VALUE_PATTERN.test(trimmed) || RANGE_VALUE_PATTERN.test(trimmed)
  );
}

/** text 控件中要求纯数字的条件 key（秒数/格数）。 */
const NUMERIC_TEXT_CONDITION_KEYS = new Set([
  "timeout",
  "target_timeout",
  "monstersCountDist",
]);

/** 数值字段（type 'int'）允许整数或小数（OpenKore 接受 dist 1.5 / minCastTime 0.1）。 */
const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * 保存前校验整个配置文档，返回人类可读的错误列表（空数组 = 通过）。
 * 覆盖：block 未选技能/物品、int 字段非整数、enum 取值越界、比较条件格式、
 * bool 非 0/1、物品数量条件格式、timeout 类非数字、标量 int。
 */
export function validateConfigDoc(doc: ConfigDoc): string[] {
  const errors: string[] = [];
  for (const def of BLOCK_DEFS) {
    const blocks = doc.blocks[def.type] ?? [];
    blocks.forEach((block, index) => {
      const name = `${def.label}${blocks.length > 1 ? ` #${index + 1}` : ""}`;
      // monsters selectorKind 空值合法：autoSwitch 空 selector = 对所有怪生效
      if (
        def.selectorKind !== "none" &&
        def.selectorKind !== "monsters" &&
        block.selector.trim() === ""
      ) {
        const label = def.selectorKind === "skill" ? "技能" : "物品";
        errors.push(`「${name}」未选择${label}，该规则保存后不会生效。`);
      }
      for (const field of def.fields) {
        const raw = block.fields[field.key];
        if (raw === undefined || raw.trim() === "") continue;
        const value = normalizeFullWidth(raw);
        if (field.type === "int" && !NUMBER_PATTERN.test(value.trim())) {
          errors.push(
            `「${name}」的「${field.label}」应为数字，当前值「${value}」。`,
          );
        }
        if (field.type === "enum" && field.options) {
          const trimmedValue = value.trim();
          // KE 布尔字段额外接受 true/false（UI 只写 0/1，但保留旧配置写法不报错）。
          const isBoolOptions = field.options.every(
            (o) => o.value === "0" || o.value === "1",
          );
          const boolAliases = ["0", "1", "true", "false"];
          const valid =
            field.options.some((o) => o.value === trimmedValue) ||
            (isBoolOptions && boolAliases.includes(trimmedValue));
          if (!valid) {
            errors.push(
              `「${name}」的「${field.label}」取值无效：「${value}」。`,
            );
          }
        }
      }
      // 未知条件键一律报错：KE 会把它当成非法条件静默忽略，用户很难发现写错。
      const allKeyDefs = def.conditions.flatMap((g) => conditionKeysOf(g));
      for (const key of Object.keys(block.conditions)) {
        if (!allKeyDefs.some((k) => k.key === key)) {
          errors.push(`「${name}」含未知条件「${key}」，KE 不认识该条件键。`);
        }
      }
      for (const group of def.conditions) {
        const keyDefs = conditionKeysOf(group);
        for (const [key, raw] of Object.entries(block.conditions)) {
          const keyDef = keyDefs.find((k) => k.key === key);
          if (!keyDef) continue;
          // 全角符号先转半角再校验（与序列化保持一致，避免用户输入 ＜５ 时误报）。
          const value = normalizeFullWidth(raw.trim());
          if (value === "") continue;
          const where = `「${name}」条件「${keyDef.label}」`;
          const widget = keyDef.widget ?? "text";
          if (widget === "comparisonPercent" || widget === "comparisonNum") {
            if (!isValidComparisonValue(value)) {
              errors.push(
                `${where}格式错误：「${value}」（支持 > 5、>= 5、< 5、<= 5、= 5、3..8、3-8 或纯数字，可带 %）。`,
              );
            }
          } else if (widget === "bool") {
            if (value !== "0" && value !== "1") {
              errors.push(`${where}应为开启(1)或关闭(0)，当前值「${value}」。`);
            }
          } else if (widget === "enum") {
            if (
              keyDef.options &&
              !keyDef.options.some((o) => o.value === value)
            ) {
              errors.push(`${where}取值无效：「${value}」。`);
            }
          } else if (widget === "itemAmount" || widget === "itemAmountId") {
            const bad = value
              .split(",")
              .map((p) => p.trim())
              .filter((p) => p !== "" && !/^.+?\s*[<>=!]+\s*[\d.]+$/.test(p));
            if (bad.length > 0) {
              errors.push(
                `${where}格式错误：「${bad[0]}」（应为：物品 + 比较符 + 数量，如「红色药水 > 1」）。`,
              );
            }
          } else if (widget === "text") {
            if (
              NUMERIC_TEXT_CONDITION_KEYS.has(key) &&
              !/^-?[\d.]+$/.test(value)
            ) {
              errors.push(`${where}应为数字，当前值「${value}」。`);
            }
          }
        }
      }
    });
  }
  for (const scalar of CONFIG_SCALARS) {
    const raw = doc.scalars[scalar.key];
    if (
      raw !== undefined &&
      raw.trim() !== "" &&
      scalar.type === "int" &&
      !NUMBER_PATTERN.test(normalizeFullWidth(raw).trim())
    ) {
      errors.push(
        `「${scalar.label}」应为数字，当前值「${normalizeFullWidth(raw)}」。`,
      );
    }
  }
  return errors;
}

/** 从 config.txt 文本解析出标量与 block（忽略注释、空行与未支持的 block）。 */
export function parseConfig(text: string): ConfigDoc {
  const doc: ConfigDoc = emptyDoc();
  let current: { type: string; block: BlockValue } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("/*")) continue;
    if (line.endsWith("{")) {
      const head = line.slice(0, -1).trim();
      const spaceIndex = head.indexOf(" ");
      const type = spaceIndex >= 0 ? head.slice(0, spaceIndex) : head;
      const selector = spaceIndex >= 0 ? normalizeFullWidth(head.slice(spaceIndex + 1).trim()) : "";
      const def = BLOCK_DEFS.find((d) => d.type === type);
      if (def) {
        current = { type, block: { selector, fields: {}, conditions: {} } };
        (doc.blocks[type] ??= []).push(current.block);
      } else {
        current = null;
      }
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex <= 0) continue;
    const key = line.slice(0, spaceIndex);
    // 旧配置里可能已有全角符号，读入时直接归一化，保存后即为合法半角写法。
    const value = normalizeFullWidth(line.slice(spaceIndex + 1).trim());
    if (value === "") continue;
    if (current) {
      const def = BLOCK_DEFS.find((d) => d.type === current!.type);
      if (def?.fields.some((f) => f.key === key))
        current.block.fields[key] = value;
      else if (isConditionKey(key)) current.block.conditions[key] = value;
    } else if (CONFIG_SCALARS.some((s) => s.key === key)) {
      doc.scalars[key] = value;
    }
  }
  return doc;
}
