// 死亡报告里和服务端有关的部分。报告本体（DeathReport）由 KE core 生成，服务端只读 killer/map/cause 等索引字段，
// 其余原样存取；配置补丁由 core 生成、服务端执行（见 config-patch.ts）。

export type ConfigPatch =
  | { op: 'setKey'; file: 'config.txt'; key: string; expected: string | null; value: string | null }
  | {
      op: 'upsertBlock';
      file: 'config.txt';
      block: string;
      selector: string;
      itemId?: number | null;
      /** null = 块不存在；否则是这些字段的原值（字段不存在为 null）。 */
      expected: Record<string, string | null> | null;
      /** null = 删除整块；value 为 "" 表示删掉这个字段（撤销时用）。 */
      fields: Array<[string, string]> | null;
    }
  | { op: 'upsertLine'; file: 'mon_control.txt'; first: string; expected: string | null; line: string | null };

export interface DeathFix {
  id: string;
  title: string;
  why: string;
  from: string;
  to: string;
  patch?: ConfigPatch | null;
}

export type FixStatus = 'applied' | 'reverted';
export interface FixState {
  status: FixStatus;
  at: number;
  /** 撤销用的反向补丁（来自 applyConfigPatch）。 */
  revert: ConfigPatch;
}
export type FixesState = Record<string, FixState>;
