// control 文件（mon_control / pickupitems / items_control / timeouts）的 schema + 序列化/解析。
// 怪物/物品用数字 ID 存储（与 KE 默认 control 文件一致，KE 按 name → 数字 ID → all 匹配）。

export interface ControlOption {
  value: string;
  label: string;
  /** 分段按钮的悬停说明（缺省用列级 help）。 */
  hint?: string;
}

export interface ControlColumn {
  key: string;
  label: string;
  help: string;
  type: "int" | "enum";
  options?: ControlOption[];
  /** 输入框占位文案（如「不限」）。 */
  placeholder?: string;
}

export interface ControlSchema {
  file: string;
  label: string;
  nameKind: "monster" | "item" | "timeout";
  columns: ControlColumn[];
}

export interface ControlRow {
  name: string;
  values: Record<string, string>;
}

const ON_OFF: ControlOption[] = [
  { value: "0", label: "否" },
  { value: "1", label: "是" },
];

export const CONTROL_SCHEMAS: ControlSchema[] = [
  {
    file: "mon_control.txt",
    label: "怪物规则",
    nameKind: "monster",
    columns: [
      {
        key: "attack_auto",
        label: "攻击策略",
        help: "对这只怪物的攻击方式（OpenKore mon_control 第 1 列）。",
        type: "enum",
        options: [
          {
            value: "-1",
            label: "忽略",
            hint: "完全无视这只怪，当作不存在（连围攻计数都不算它）。",
          },
          {
            value: "0",
            label: "仅反击",
            hint: "平时不主动打，但它攻击你时才会还手。",
          },
          { value: "1", label: "自动攻击", hint: "见到就打（默认行为）。" },
          {
            value: "2",
            label: "打坐也攻击",
            hint: "把这种怪视作主动怪：坐下回血时也会起身追打它。",
          },
          {
            value: "3",
            label: "练怪模式",
            hint: "mob-training 特殊玩法用，一般不要选。",
          },
        ],
      },
      {
        key: "teleport_auto",
        label: "遇怪传送",
        help: "遇到这只怪物时是否瞬移躲避（第 2 列）。",
        type: "enum",
        options: [
          { value: "0", label: "不传送", hint: "遇到也不躲。" },
          {
            value: "1",
            label: "见到就飞",
            hint: "这种怪一出现在屏幕上就立刻瞬移。",
          },
          { value: "2", label: "被打才飞", hint: "要被它攻击命中时才瞬移。" },
        ],
      },
      {
        key: "teleport_search",
        label: "搜索标记",
        help: "标记为「搜索目标」：配合瞬移找怪开关，屏幕上出现这种怪时才激活自动攻击（用于主动瞬移寻找稀有怪）。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "skillcancel_auto",
        label: "打断咏唱",
        help: "这种怪物施法时尝试打断：切换目标去打它，或躲开范围技能。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "attack_lvl",
        label: "最低基础等级",
        help: "自身基础等级 ≥ 此值才会攻击该怪物。留空不限。",
        type: "int",
        placeholder: "不限",
      },
      {
        key: "attack_jlvl",
        label: "最低职业等级",
        help: "自身职业等级 ≥ 此值才会攻击。留空不限。",
        type: "int",
        placeholder: "不限",
      },
      {
        key: "attack_hp",
        label: "最低 HP",
        help: "当前 HP ≥ 此值才攻击（绝对数值，不是百分比）。留空不限。",
        type: "int",
        placeholder: "不限",
      },
      {
        key: "attack_sp",
        label: "最低 SP",
        help: "当前 SP ≥ 此值才攻击（绝对数值，不是百分比）。留空不限。",
        type: "int",
        placeholder: "不限",
      },
      {
        key: "weight",
        label: "计怪权重",
        help: "统计「围攻数」时这只怪算几只：支持小数（如 0.2），-1 表示不计入围攻，0 视作 1 只。配合 teleportAuto_minAggressives 使用。",
        type: "int",
        placeholder: "默认按 1 只",
      },
    ],
  },
  {
    file: "pickupitems.txt",
    label: "拾取物品",
    nameKind: "item",
    columns: [
      {
        key: "flag",
        label: "拾取",
        help: "该物品是否拾取：0（或 -1）=不拾取，1=拾取，2=出现立刻捡。",
        type: "enum",
        options: [
          {
            value: "-1",
            label: "不拾取",
            hint: "不捡这个物品（-1 与 0 效果相同）。",
          },
          {
            value: "0",
            label: "不拾取",
            hint: "不捡这个物品（-1 与 0 效果相同）。",
          },
          { value: "1", label: "拾取", hint: "路过时顺手捡起。" },
          { value: "2", label: "优先拾取", hint: "物品一出现就马上去捡。" },
        ],
      },
    ],
  },
  {
    file: "items_control.txt",
    label: "物品规则",
    nameKind: "item",
    columns: [
      {
        key: "keep",
        label: "身上保留",
        help: "身上至少保留的数量；放推车 / 取推车 / 存仓出售都以它为基准（多于它才处理、少于它补回）。",
        type: "int",
        placeholder: "0",
      },
      {
        key: "storage",
        label: "存仓",
        help: "去仓库时如何处理这个物品：0=不存仓，1=把身上超过「保留」的部分存进仓库。",
        type: "enum",
        options: [
          { value: "0", label: "不存仓", hint: "这个物品不进仓库。" },
          {
            value: "1",
            label: "存仓库",
            hint: "把身上超过「保留」的部分存进仓库。",
          },
        ],
      },
      {
        key: "sell",
        label: "出售",
        help: "去商店时是否卖掉这个物品（卖掉「身上保留」以外的部分）。",
        type: "enum",
        options: [
          { value: "0", label: "不出售", hint: "这个物品不卖给 NPC。" },
          { value: "1", label: "出售", hint: "卖掉「身上保留」以外的部分。" },
        ],
      },
      {
        key: "cart_add",
        label: "放进推车",
        help: "身上的数量超过「身上保留」时，自动把多余的放进推车。",
        type: "enum",
        options: ON_OFF,
      },
      {
        key: "cart_get",
        label: "从车取出",
        help: "身上的数量少于「身上保留」时，自动从推车补回来。",
        type: "enum",
        options: ON_OFF,
      },
    ],
  },
  {
    file: "timeouts.txt",
    label: "超时",
    nameKind: "timeout",
    columns: [
      {
        key: "value",
        label: "秒",
        help: "该动作的等待/重试秒数（支持小数，如 0.4）。",
        type: "int",
      },
    ],
  },
];

/** LastRO 调优后的 timeouts 默认值：新方案预填时覆盖 KE 自带默认值（未列出的项仍用 KE 默认）。 */
export const TIMEOUT_DEFAULT_OVERRIDES: Record<string, string> = {
  ai_move_retry: "0.3",
  ai_attack: "0.3",
  ai_attack_after_skill: "0.1",
  ai_attack_auto: "0.4",
  ai_attack_waitAfterKill: "0",
  ai_attack_main: "0.15",
  ai_items_take_delay: "0.1",
  ai_items_take_start: "0",
  ai_items_take_end: "0.3",
  ai_skill_use: "0.5",
  ai_item_use_auto: "0.3",
  ai_teleport: "0.4",
  ai_teleport_idle: "10",
  ai_teleport_delay: "0.2",
  ai_buyAuto: "15",
  ai_sellAuto: "0.2",
  ai_storageAuto: "0.3",
};

export type ControlDoc = Record<string, ControlRow[]>;

export function emptyControlDoc(): ControlDoc {
  const doc: ControlDoc = {};
  for (const schema of CONTROL_SCHEMAS) doc[schema.file] = [];
  return doc;
}

/** 三个规则文件的 all 兜底行：KE 依赖 all 规则作为未匹配条目的默认行为，缺失会导致挂机行为异常。 */
const ALL_FALLBACK_ROWS: Record<string, ControlRow[]> = {
  "mon_control.txt": [
    {
      name: "all",
      values: { attack_auto: "1", teleport_auto: "0", teleport_search: "0" },
    },
  ],
  "pickupitems.txt": [{ name: "all", values: { flag: "1" } }],
  "items_control.txt": [
    { name: "all", values: { keep: "0", storage: "0", sell: "0" } },
  ],
};

/** all 兜底行的深拷贝。 */
export function allFallbackRows(file: string): ControlRow[] {
  return (ALL_FALLBACK_ROWS[file] ?? []).map((row) => ({
    name: row.name,
    values: { ...row.values },
  }));
}

/** 确保 mon/pickup/items 三个规则文件都有 all 兜底行（缺失时插到最前）。 */
export function ensureAllFallback(doc: ControlDoc): void {
  for (const file of Object.keys(ALL_FALLBACK_ROWS)) {
    const rows = doc[file] ?? [];
    if (!rows.some((row) => row.name === "all")) {
      doc[file] = [...allFallbackRows(file), ...rows];
    }
  }
}

/** 新 Profile 的默认 control 文件：all 规则 + 空超时（超时由编辑器按 KE 默认值填充）。 */
export function defaultControlDoc(): ControlDoc {
  const doc = emptyControlDoc();
  for (const file of Object.keys(ALL_FALLBACK_ROWS)) {
    doc[file] = allFallbackRows(file);
  }
  doc["timeouts.txt"] = [];
  return doc;
}

/** 序列化（空格分隔；未设置列省略，仅保留从首列到最后一个已设列）。 */
export function serializeControl(
  schema: ControlSchema,
  rows: ControlRow[],
): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.name === "") continue;
    let lastSet = -1;
    for (let i = 0; i < schema.columns.length; i += 1) {
      const value = row.values[schema.columns[i]!.key];
      if (value !== undefined && value !== "") lastSet = i;
    }
    if (lastSet < 0) continue;
    const parts = [row.name];
    for (let i = 0; i <= lastSet; i += 1) {
      const column = schema.columns[i]!;
      parts.push(row.values[column.key] ?? "");
    }
    lines.push(parts.join(" "));
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** 解析（按空白切分，首列为 name，后续按列顺序取值）。 */
export function parseControl(
  schema: ControlSchema,
  text: string,
): ControlRow[] {
  const rows: ControlRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/u);
    const name = parts[0] ?? "";
    if (name === "") continue;
    const values: Record<string, string> = {};
    for (let i = 0; i < schema.columns.length; i += 1) {
      const value = parts[i + 1];
      if (value !== undefined && value !== "")
        values[schema.columns[i]!.key] = value;
    }
    rows.push({ name, values });
  }
  return rows;
}
