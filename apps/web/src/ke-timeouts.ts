// timeouts.txt 的展示元数据：中文名、用途说明、分组与「常用」层级。
// 数值默认值以 TIMEOUT_DEFAULT_OVERRIDES / options.json 为准，这里的 def 仅作兜底。

export type TimeoutTier = "core" | "common" | "adv";

export interface TimeoutMeta {
  key: string;
  /** 中文参数名 */
  cn: string;
  /** 兜底默认值（秒）；实际默认值优先取 LastRO 覆盖表或 KE 默认值 */
  def: number;
  /** 建议可调范围下限 / 上限（秒） */
  lo: number;
  hi: number;
  /** 所属分组 id */
  group: string;
  tier: TimeoutTier;
  /** 一句话说明 */
  desc: string;
}

export interface TimeoutGroup {
  id: string;
  name: string;
  note: string;
}

export const TIMEOUT_GROUPS: TimeoutGroup[] = [
  { id: "combat", name: "战斗与目标", note: "找怪、攻击节奏、卡住与放弃" },
  { id: "teleport", name: "瞬移与逃生", note: "空闲 / 低血瞬移、逃生、传送门" },
  { id: "move", name: "移动与寻路", note: "移动重试、卡住脱困、路线重算" },
  { id: "pickup", name: "拾取", note: "捡东西的等待与放弃" },
  { id: "skill", name: "技能 · 物品 · 装备", note: "技能、喝药、换装、物品转移" },
  { id: "supply", name: "买卖 · 存仓 · 修理", note: "买 / 卖 / 存仓 / 推车 / 修理" },
  { id: "npc", name: "NPC 对话", note: "与 NPC 对话的等待" },
  { id: "misc", name: "恢复与其他", note: "复活、坐下、跟随与可达性预判" },
];

export const TIMEOUT_META: TimeoutMeta[] = [
  // 战斗与目标
  { key: "ai_attack_auto", cn: "找怪频率", def: 0.4, lo: 0.2, hi: 1, group: "combat", tier: "core", desc: "每隔多久看一眼周围有没有能打的怪。调小反应更快，但更吃 CPU。" },
  { key: "ai_attack_main", cn: "战斗思考间隔", def: 0.15, lo: 0.05, hi: 0.2, group: "combat", tier: "core", desc: "战斗逻辑多久跑一次。越小越跟手，CPU 占用也越高。" },
  { key: "ai_attack", cn: "普攻间隔", def: 0.3, lo: 0.2, hi: 2, group: "combat", tier: "core", desc: "两次普通攻击之间至少隔多久。太小可能被判定攻击过快，太大打怪变慢。" },
  { key: "ai_attack_giveup", cn: "放弃打不到的怪", def: 6, lo: 3, hi: 10, group: "combat", tier: "core", desc: "追一只怪这么久还没打到，就先放弃，去处理别的目标。" },
  { key: "ai_attack_after_skill", cn: "技能后恢复普攻", def: 0.1, lo: 0.1, hi: 1, group: "combat", tier: "common", desc: "放完技能后等多久继续普攻。" },
  { key: "ai_attack_unstuck", cn: "攻击卡住脱困", def: 2.75, lo: 2, hi: 5, group: "combat", tier: "common", desc: "攻击时卡住多久触发脱困动作。" },
  { key: "ai_attack_waitAfterKill", cn: "击杀后停顿", def: 0, lo: 0, hi: 0.5, group: "combat", tier: "common", desc: "打死怪后如果没有下一个目标，先停多久。" },
  { key: "ai_attack_failedLOS", cn: "无法靠近时忽略", def: 12, lo: 5, hi: 20, group: "combat", tier: "common", desc: "找不到路走到目标身边时，先忽略它多久。" },
  { key: "ai_attack_unfail", cn: "失败目标重试", def: 12, lo: 5, hi: 20, group: "combat", tier: "adv", desc: "攻击失败后，隔多久重新尝试同一个目标。" },
  { key: "ai_attack_allowed_waitForTarget", cn: "等待进入攻击范围", def: 0.3, lo: 0.2, hi: 0.5, group: "combat", tier: "adv", desc: "目标还没进入攻击范围时，最多再等多久。" },
  // 瞬移与逃生
  { key: "ai_teleport_idle", cn: "空闲瞬移间隔", def: 0.7, lo: 0.5, hi: 8, group: "teleport", tier: "core", desc: "没怪打、闲着的时候，隔多久自动瞬移一次。找怪或防卡点时常用。" },
  { key: "ai_teleport_hp", cn: "低血瞬移间隔", def: 3, lo: 2, hi: 5, group: "teleport", tier: "core", desc: "HP 低于生存页阈值时，隔多久尝试瞬移逃走。" },
  { key: "ai_teleport", cn: "瞬移动作间隔", def: 0.4, lo: 0.3, hi: 2, group: "teleport", tier: "common", desc: "两次瞬移动作之间至少隔多久。" },
  { key: "ai_teleport_away", cn: "逃走后恢复", def: 3, lo: 2, hi: 5, group: "teleport", tier: "common", desc: "瞬移逃走后，隔多久恢复正常行动。" },
  { key: "ai_teleport_retry", cn: "瞬移失败重试", def: 0.5, lo: 0.3, hi: 1, group: "teleport", tier: "adv", desc: "瞬移没成功时，隔多久再试一次。" },
  { key: "ai_teleport_delay", cn: "瞬移后停顿", def: 0.2, lo: 0.2, hi: 1, group: "teleport", tier: "adv", desc: "瞬移落地后先等多久再继续动作。" },
  { key: "ai_teleport_safe_force", cn: "安全区强制瞬移", def: 120, lo: 60, hi: 180, group: "teleport", tier: "adv", desc: "在安全区停留多久后强制瞬移离开。" },
  { key: "ai_teleport_portal", cn: "过门瞬移间隔", def: 2, lo: 1, hi: 4, group: "teleport", tier: "adv", desc: "通过传送门时瞬移的间隔。" },
  { key: "ai_portal_wait", cn: "过门确认等待", def: 0.5, lo: 0.3, hi: 1, group: "teleport", tier: "adv", desc: "进传送门后等多久确认已经过图。" },
  { key: "ai_portal_give_up", cn: "过门放弃时间", def: 10, lo: 5, hi: 15, group: "teleport", tier: "adv", desc: "传送门一直没反应时，多久放弃。" },
  // 移动与寻路
  { key: "ai_move_retry", cn: "移动重发间隔", def: 0.3, lo: 0.2, hi: 1, group: "move", tier: "common", desc: "移动命令没进展时，隔多久重发一次。" },
  { key: "ai_move_giveup", cn: "移动放弃时间", def: 1.2, lo: 1, hi: 5, group: "move", tier: "common", desc: "移动持续没进展多久后放弃当前目标。" },
  { key: "ai_route_unstuck", cn: "走路卡住脱困", def: 2, lo: 1, hi: 5, group: "move", tier: "core", desc: "走路卡住多久后自动脱困并重算路线。" },
  { key: "ai_route_calcRoute", cn: "路线重算间隔", def: 1, lo: 0.5, hi: 2, group: "move", tier: "adv", desc: "多久重新计算一次行走路线。" },
  { key: "ai_route_escape", cn: "逃跑路线重算", def: 8, lo: 5, hi: 15, group: "move", tier: "adv", desc: "逃跑时多久重新计算一次路线。" },
  { key: "ai_route_position_prediction_delay", cn: "位置预测延迟", def: 0.05, lo: 0.03, hi: 0.1, group: "move", tier: "adv", desc: "预测角色位置时的延迟补偿。" },
  // 拾取
  { key: "ai_items_take_delay", cn: "连续拾取间隔", def: 0.1, lo: 0.1, hi: 2, group: "pickup", tier: "common", desc: "捡完一件物品后，隔多久捡下一件。" },
  { key: "ai_take_giveup", cn: "拾取放弃时间", def: 3, lo: 2, hi: 5, group: "pickup", tier: "common", desc: "一直捡不到时，多久放弃这件物品。" },
  { key: "ai_items_take_start", cn: "开始拾取等待", def: 0, lo: 0, hi: 0.5, group: "pickup", tier: "adv", desc: "决定捡东西后，先等多久再动手。" },
  { key: "ai_items_take_end", cn: "拾取收尾等待", def: 0.3, lo: 0.3, hi: 1, group: "pickup", tier: "adv", desc: "捡完东西后等多久再继续别的动作。" },
  { key: "ai_items_gather_giveup", cn: "收集放弃时间", def: 3, lo: 2, hi: 5, group: "pickup", tier: "adv", desc: "捡不到无主物品时，多久放弃继续找。" },
  // 技能 · 物品 · 装备
  { key: "ai_skill_use", cn: "技能施放间隔", def: 0.5, lo: 0.5, hi: 1.5, group: "skill", tier: "common", desc: "连续放技能之间至少隔多久。" },
  { key: "ai_item_use_auto", cn: "自动喝药间隔", def: 0.3, lo: 0.2, hi: 1, group: "skill", tier: "core", desc: "自动使用药水 / 消耗品的检查间隔。太小会频繁尝试喝药。" },
  { key: "ai_skill_use_giveup", cn: "技能放弃时间", def: 1, lo: 0.5, hi: 2, group: "skill", tier: "adv", desc: "技能一直放不出来时，多久放弃。" },
  { key: "ai_item_equip_auto", cn: "自动换装间隔", def: 0.75, lo: 0.5, hi: 1.5, group: "skill", tier: "adv", desc: "自动更换装备的检查间隔。" },
  { key: "ai_equipAuto_skilluse_giveup", cn: "换装后技能放弃", def: 5, lo: 3, hi: 8, group: "skill", tier: "adv", desc: "换装后技能放不出来，多久放弃。" },
  { key: "ai_equip_giveup", cn: "装备放弃时间", def: 2, lo: 1, hi: 4, group: "skill", tier: "adv", desc: "装备一直穿不上时，多久放弃。" },
  { key: "ai_transfer_items", cn: "物品转移间隔", def: 0.15, lo: 0.1, hi: 0.3, group: "skill", tier: "adv", desc: "物品在角色和推车之间转移的间隔。" },
  // 买卖 · 存仓 · 修理
  { key: "ai_buyAuto", cn: "自动购买间隔", def: 15, lo: 5, hi: 30, group: "supply", tier: "common", desc: "自动购买流程多久检查一次。" },
  { key: "ai_sellAuto", cn: "自动出售间隔", def: 0.2, lo: 0.2, hi: 4, group: "supply", tier: "common", desc: "自动出售流程多久检查一次。" },
  { key: "ai_storageAuto", cn: "自动存仓间隔", def: 0.3, lo: 0.3, hi: 4, group: "supply", tier: "common", desc: "自动存仓流程多久检查一次。" },
  { key: "ai_buyAuto_wait", cn: "购买流程等待", def: 2, lo: 1, hi: 4, group: "supply", tier: "adv", desc: "购买过程中每一步的等待时间。" },
  { key: "ai_buyAuto_wait_giveup_npc", cn: "找不到购买 NPC 放弃", def: 15, lo: 10, hi: 20, group: "supply", tier: "adv", desc: "找不到购买 NPC 时，多久放弃。" },
  { key: "ai_buyAuto_wait_before_buy", cn: "购买前等待", def: 2, lo: 1, hi: 4, group: "supply", tier: "adv", desc: "正式购买前等 NPC 多久。" },
  { key: "ai_buyAuto_wait_after_packet_giveup", cn: "购买无响应放弃", def: 15, lo: 10, hi: 20, group: "supply", tier: "adv", desc: "购买请求没有回应时，多久放弃。" },
  { key: "ai_buyAuto_wait_after_restart", cn: "重试购买等待", def: 2, lo: 1, hi: 4, group: "supply", tier: "adv", desc: "重新尝试购买前先等多久。" },
  { key: "ai_sellAuto_wait_giveup_npc", cn: "找不到出售 NPC 放弃", def: 15, lo: 10, hi: 20, group: "supply", tier: "adv", desc: "找不到出售 NPC 时，多久放弃。" },
  { key: "ai_sellAuto_wait_before_sell", cn: "出售前等待", def: 2, lo: 1, hi: 4, group: "supply", tier: "adv", desc: "正式出售前等 NPC 多久。" },
  { key: "ai_sellAuto_wait_after_packet_giveup", cn: "出售无响应放弃", def: 15, lo: 10, hi: 20, group: "supply", tier: "adv", desc: "出售请求没有回应时，多久放弃。" },
  { key: "ai_storageAuto_getAutoCheck", cn: "存仓时取物检查", def: 2, lo: 1, hi: 4, group: "supply", tier: "adv", desc: "存仓过程中检查取物的间隔。" },
  { key: "ai_storageAuto_giveup", cn: "存仓放弃时间", def: 15, lo: 10, hi: 20, group: "supply", tier: "adv", desc: "存仓一直没有回应时，多久放弃。" },
  { key: "ai_storageAuto_wait_before_action", cn: "存仓前等待", def: 2, lo: 1, hi: 4, group: "supply", tier: "adv", desc: "存仓动作开始前先等多久。" },
  { key: "ai_cartAuto", cn: "推车操作间隔", def: 0.15, lo: 0.1, hi: 0.3, group: "supply", tier: "adv", desc: "自动使用手推车的间隔。" },
  { key: "ai_cartAutoCheck", cn: "推车状态检查", def: 3, lo: 2, hi: 5, group: "supply", tier: "adv", desc: "检查推车状态的间隔。" },
  { key: "ai_repair", cn: "自动修理间隔", def: 4, lo: 2, hi: 8, group: "supply", tier: "common", desc: "自动修理装备的检查间隔。" },
  // NPC 对话
  { key: "ai_route_npcTalk", cn: "找 NPC 对话超时", def: 10, lo: 5, hi: 15, group: "npc", tier: "adv", desc: "走到 NPC 旁开始对话的超时时间。" },
  { key: "ai_npc_talk_wait_to_answer", cn: "等待 NPC 回复", def: 1.5, lo: 1, hi: 3, group: "npc", tier: "adv", desc: "发出对话后等 NPC 回复的时间。" },
  { key: "ai_npc_talk_wait_after_close_to_cancel", cn: "关对话到取消", def: 0.5, lo: 0.3, hi: 1, group: "npc", tier: "adv", desc: "关闭对话框后到取消操作的等待。" },
  { key: "ai_npc_talk_wait_after_cancel_to_destroy", cn: "取消到销毁对话", def: 0.5, lo: 0.3, hi: 1, group: "npc", tier: "adv", desc: "取消后到销毁对话框的等待。" },
  { key: "ai_npc_talk_wait_before_continue", cn: "继续前等待", def: 0.7, lo: 0.5, hi: 1.5, group: "npc", tier: "adv", desc: "继续下一句对话前等多久。" },
  // 恢复与其他
  { key: "ai_dead_respawn", cn: "死亡后复活等待", def: 4, lo: 2, hi: 10, group: "misc", tier: "common", desc: "死亡后等多久回城复活。" },
  { key: "ai_sit_idle", cn: "空闲坐下等待", def: 10, lo: 5, hi: 20, group: "misc", tier: "common", desc: "空闲多久后坐下回血 / 回蓝。" },
  { key: "ai_sit", cn: "坐下 / 站起间隔", def: 1, lo: 0.5, hi: 2, group: "misc", tier: "adv", desc: "坐下和站起动作之间的间隔。" },
  { key: "ai_stand_wait", cn: "站起等待", def: 0, lo: 0, hi: 1, group: "misc", tier: "adv", desc: "站起后先等多久再行动。" },
  { key: "ai_sit_wait", cn: "坐下等待", def: 0, lo: 0, hi: 1, group: "misc", tier: "adv", desc: "坐下后先等多久再回血。" },
  { key: "ai_safe_stand_up", cn: "安全站起间隔", def: 2, lo: 1, hi: 3, group: "misc", tier: "adv", desc: "确认安全后站起的间隔。" },
  { key: "ai_follow_lost_end", cn: "跟丢后停止跟随", def: 10, lo: 5, hi: 20, group: "misc", tier: "adv", desc: "跟丢目标多久后停止跟随。" },
  { key: "ai_future_reachability_lookup", cn: "可达性预判", def: 0.7, lo: 0.3, hi: 1, group: "misc", tier: "adv", desc: "预测目标位置是否可达的检查间隔。" },
  { key: "meetingPosition_future_reachability_lookup", cn: "集合点可达性检查", def: 0.3, lo: 0.2, hi: 0.5, group: "misc", tier: "adv", desc: "队伍集合点的可达性检查间隔。" },
];

export const TIMEOUT_META_BY_KEY: ReadonlyMap<string, TimeoutMeta> = new Map(
  TIMEOUT_META.map((item) => [item.key, item]),
);
