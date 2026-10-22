// control 文件（mon_control / pickupitems / items_control / timeouts）的 schema + 序列化/解析。
// 怪物/物品用数字 ID 存储（与 KE 默认 control 文件一致，KE 按 name → 数字 ID → all 匹配）。

import { normalizeFullWidth } from "./ke-schema";

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
  /**
   * 序列化补位默认值：当该列未填、但更靠后的列有值时，用此默认值补齐，
   * 避免写出 "name  1" 这类含空段的行被 KE 按空格切分时错位解析。
   */
  defaultValue?: string;
  /**
   * 必填列：保存校验要求该列必须有非空值（未填时阻止保存）。
   * 通常对应 OpenKore 格式里不可或缺的列（如 items_control 的 keep/storage/sell）。
   */
  required?: boolean;
}

export interface ControlSchema {
  file: string;
  label: string;
  nameKind: "monster" | "item" | "timeout";
  columns: ControlColumn[];
  /** 保存时该行序列化后至少包含的空格分隔字段数（含首列 name）。 */
  minTokens?: number;
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
    minTokens: 2,
    columns: [
      {
        key: "attack_auto",
        label: "攻击策略",
        help: "对这只怪物的攻击方式（OpenKore mon_control 第 1 列）。",
        type: "enum",
        defaultValue: "1",
        required: true,
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
        defaultValue: "0",
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
        label: "专注模式标记",
        help: "标记为「专注模式目标」：配合生存页的专注模式开关，屏幕上出现这种怪时才激活自动攻击（用于主动瞬移寻找稀有怪）。",
        type: "enum",
        defaultValue: "0",
        options: ON_OFF,
      },
      {
        key: "skillcancel_auto",
        label: "打断咏唱",
        help: "这种怪物施法时尝试打断：切换目标去打它，或躲开范围技能。",
        type: "enum",
        defaultValue: "0",
        options: ON_OFF,
      },
      {
        key: "attack_lvl",
        label: "最低基础等级",
        help: "自身基础等级 ≥ 此值才会攻击该怪物。留空不限。",
        type: "int",
        placeholder: "不限",
        defaultValue: "0",
      },
      {
        key: "attack_jlvl",
        label: "最低职业等级",
        help: "自身职业等级 ≥ 此值才会攻击。留空不限。",
        type: "int",
        placeholder: "不限",
        defaultValue: "0",
      },
      {
        key: "attack_hp",
        label: "最低 HP",
        help: "当前 HP ≥ 此值才攻击（绝对数值，不是百分比）。留空不限。",
        type: "int",
        placeholder: "不限",
        defaultValue: "0",
      },
      {
        key: "attack_sp",
        label: "最低 SP",
        help: "当前 SP ≥ 此值才攻击（绝对数值，不是百分比）。留空不限。",
        type: "int",
        placeholder: "不限",
        defaultValue: "0",
      },
      {
        key: "weight",
        label: "计怪权重",
        help: "统计「围攻数」时这只怪算几只：支持小数（如 0.2），-1 表示不计入围攻，0 视作 1 只。配合 teleportAuto_minAggressives 使用。",
        type: "int",
        placeholder: "默认按 1 只",
        defaultValue: "0",
      },
    ],
  },
  {
    file: "pickupitems.txt",
    label: "拾取物品",
    nameKind: "item",
    minTokens: 2,
    columns: [
      {
        key: "flag",
        label: "拾取",
        help: "该物品是否拾取：-1=不拾取并丢弃（扔地上），0=不拾取（留在地上），1=拾取，2=出现立刻捡。",
        type: "enum",
        defaultValue: "1",
        required: true,
        options: [
          {
            value: "-1",
            label: "丢弃",
            hint: "不捡这个物品，并让它消失（写入 -1）。",
          },
          {
            value: "0",
            label: "不拾取",
            hint: "不捡这个物品（写入 0，物品留在地上）。",
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
    minTokens: 4,
    columns: [
      {
        key: "keep",
        label: "身上保留",
        help: "身上至少保留的数量；放推车 / 取推车 / 存仓出售都以它为基准（多于它才处理、少于它补回）。",
        type: "int",
        placeholder: "0",
        defaultValue: "0",
        required: true,
      },
      {
        key: "storage",
        label: "存仓",
        help: "去仓库时如何处理这个物品：0=不存仓，1=把身上超过「保留」的部分存进仓库。",
        type: "enum",
        defaultValue: "0",
        required: true,
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
        defaultValue: "0",
        required: true,
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
        defaultValue: "0",
        options: ON_OFF,
      },
      {
        key: "cart_get",
        label: "从车取出",
        help: "身上的数量少于「身上保留」时，自动从推车补回来。",
        type: "enum",
        defaultValue: "0",
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

/**
 * 三个规则文件的兜底行集合：包含最低优先级的 all + 两个按 isBoss 标志位匹配的保留名。
 * 兜底行插入到文件末尾（append），保持用户写的规则在前、兜底在最低优先级位置。
 * 优先级（从高到低）：精确名 → class id / item id → 通配符 → all_mvp / all_miniboss → all。
 */
const ALL_FALLBACK_ROWS: Record<string, ControlRow[]> = {
  "mon_control.txt": [
    {
      name: "all_miniboss",
      values: {
        attack_auto: "1",
        teleport_auto: "0",
        teleport_search: "0",
        skillcancel_auto: "0",
        attack_lvl: "0",
        attack_jlvl: "0",
        attack_hp: "0",
        attack_sp: "0",
        weight: "0",
      },
    },
    {
      name: "all_mvp",
      values: {
        attack_auto: "-1",
        teleport_auto: "1",
        teleport_search: "0",
        skillcancel_auto: "0",
        attack_lvl: "0",
        attack_jlvl: "0",
        attack_hp: "0",
        attack_sp: "0",
        weight: "0",
      },
    },
    {
      name: "all",
      values: {
        attack_auto: "1",
        teleport_auto: "0",
        teleport_search: "0",
        skillcancel_auto: "0",
        attack_lvl: "0",
        attack_jlvl: "0",
        attack_hp: "0",
        attack_sp: "0",
        weight: "0",
      },
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

/** 默认控制文件自带的实用预设行（仅新 profile，用户可修改/删除）。
 *  不存仓也不卖的特殊道具：具名道具在前，通配符在后，最后是卡片兜底——
 *  通配符多条命中时取文件里靠前的一条，所以顺序即优先级。 */
const DEFAULT_PRESET_ROWS: Record<string, ControlRow[]> = {
  "items_control.txt": [
    {
      name: "魔法箭矢筒",
      values: { keep: "1", storage: "0", sell: "0", cart_add: "0", cart_get: "0" },
    },
    {
      name: "魔法苍蝇翅膀",
      values: { keep: "1", storage: "0", sell: "0", cart_add: "0", cart_get: "0" },
    },
    {
      name: "坐骑缰绳",
      values: { keep: "1", storage: "0", sell: "0", cart_add: "0", cart_get: "0" },
    },
    {
      name: "乐园团*",
      values: { keep: "1", storage: "0", sell: "0", cart_add: "0", cart_get: "0" },
    },
    {
      name: "伊甸园*",
      values: { keep: "1", storage: "0", sell: "0", cart_add: "0", cart_get: "0" },
    },
    {
      name: "*卡片",
      values: { keep: "0", storage: "1", sell: "0", cart_add: "0", cart_get: "0" },
    },
  ],
  "pickupitems.txt": [{ name: "*卡片", values: { flag: "2" } }],
};

/** 确保 mon/pickup/items 三个规则文件的兜底行都存在（按 ALL_FALLBACK_ROWS 顺序追加到末尾）。
 *  只补缺失的，不删除已有的；已有顺序不变，缺失的补到所有现有行之后。 */
export function ensureAllFallback(doc: ControlDoc): void {
  for (const file of Object.keys(ALL_FALLBACK_ROWS)) {
    const rows = doc[file] ?? [];
    const present = new Set(rows.map((row) => row.name));
    const missing = allFallbackRows(file).filter((row) => !present.has(row.name));
    if (missing.length > 0) {
      doc[file] = [...rows, ...missing];
    }
  }
}

/** 新 Profile 的默认 control 文件：实用预设行 + 兜底行 + 空超时（超时由编辑器按 KE 默认值填充）。 */
export function defaultControlDoc(): ControlDoc {
  const doc = emptyControlDoc();
  for (const file of Object.keys(ALL_FALLBACK_ROWS)) {
    doc[file] = [
      ...((DEFAULT_PRESET_ROWS[file] ?? []).map((row) => ({
        name: row.name,
        values: { ...row.values },
      }))),
      ...allFallbackRows(file),
    ];
  }
  doc["timeouts.txt"] = [];
  return doc;
}

/** 序列化（空格分隔；未设置列省略，仅保留从首列到最后一个已设列）。
 * 必填列（required）即使未填也会用 defaultValue 补齐，保证行内参数数量与位置稳定，
 * 避免空段导致 KE 按空格切分时错位（如「name  1」被解析成 keep=1）。
 */
export function serializeControl(
  schema: ControlSchema,
  rows: ControlRow[],
): string {
  // 必填列的最大下标：序列化时至少输出到这一列，保证最小参数数量。
  let lastRequired = -1;
  schema.columns.forEach((column, index) => {
    if (column.required) lastRequired = index;
  });
  const lines: string[] = [];
  for (const row of rows) {
    if (row.name === "") continue;
    let lastSet = lastRequired;
    for (let i = 0; i < schema.columns.length; i += 1) {
      const value = row.values[schema.columns[i]!.key];
      if (value !== undefined && value !== "") lastSet = Math.max(lastSet, i);
    }
    if (lastSet < 0) continue;
    const parts = [normalizeFullWidth(row.name)];
    for (let i = 0; i <= lastSet; i += 1) {
      const column = schema.columns[i]!;
      const value = row.values[column.key];
      const filled =
        value === undefined || value === ""
          ? (column.defaultValue ?? "")
          : value;
      parts.push(normalizeFullWidth(filled));
    }
    lines.push(parts.join(" "));
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** 新建一行的初始值：把带 defaultValue 的列预填上，避免用户留空必填列导致序列化错位。 */
export function newControlRow(schema: ControlSchema): ControlRow {
  const values: Record<string, string> = {};
  for (const column of schema.columns) {
    if (column.defaultValue !== undefined) values[column.key] = column.defaultValue;
  }
  return { name: "", values };
}

/**
 * 保存前校验 control 文件，返回人类可读错误列表（空数组 = 通过）。
 * 检查项：
 * - 每行必须选择对象（怪物 / 物品 / 超时项）。
 * - required 列必须填写，否则该行序列化后参数不足 minTokens。
 */
export function validateControlDoc(doc: ControlDoc): string[] {
  const errors: string[] = [];
  for (const schema of CONTROL_SCHEMAS) {
    const rows = doc[schema.file] ?? [];
    const nameLabel =
      schema.nameKind === "monster"
        ? "怪物"
        : schema.nameKind === "item"
          ? "物品"
          : "超时项";
    rows.forEach((row, index) => {
      const where = `「${schema.label}」第 ${index + 1} 行`;
      if (row.name.trim() === "") {
        errors.push(`${where}未选择${nameLabel}，请填写或删除该行。`);
        return;
      }
      for (const column of schema.columns) {
        if (!column.required) continue;
        const value = row.values[column.key];
        if (value === undefined || value.trim() === "") {
          const minNote = schema.minTokens
            ? `（该行至少需 ${schema.minTokens} 项参数）`
            : "";
          errors.push(
            `${where}（${row.name}）的「${column.label}」未填写${minNote}。`,
          );
        }
      }
      // 兜底：序列化后的空格分隔字段数必须达到 minTokens，防止位置错位。
      if (schema.minTokens !== undefined) {
        const line = serializeControl(schema, [row]).trim();
        if (line !== "") {
          const tokenCount = line.split(/\s+/u).length;
          if (tokenCount < schema.minTokens) {
            errors.push(
              `${where}（${row.name}）序列化后仅 ${tokenCount} 项，少于要求的 ${schema.minTokens} 项，请补全必填列。`,
            );
          }
        }
      }
    });
  }
  return errors;
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
    // 旧配置里的全角符号（如全角 ＊ / ？ 通配符）读入时归一化为半角。
    const name = normalizeFullWidth(parts[0] ?? "");
    if (name === "") continue;
    const values: Record<string, string> = {};
    for (let i = 0; i < schema.columns.length; i += 1) {
      const value = parts[i + 1];
      if (value !== undefined && value !== "")
        values[schema.columns[i]!.key] = normalizeFullWidth(value);
    }
    rows.push({ name, values });
  }
  return rows;
}
