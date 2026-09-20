export const OPTION_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;

export type OptionOperator = typeof OPTION_OPERATORS[number];
export type OptionValueKind = 'integer' | 'scaled_integer';
export type OptionRepeatPolicy = 'same' | 'distinct';
export type OptionParamPolicy =
  | { mode: 'ignored'; filterable: false }
  | { mode: 'required_exact'; filterable: true; value?: number }
  | { mode: 'optional_exact'; filterable: true; value?: number };

export interface OptionDefinition {
  type: number;
  handle: string;
  labelZh: string;
  descriptionTemplate: string;
  valueType: OptionValueKind;
  unit: string;
  scale: number;
  allowedOperators: OptionOperator[];
  paramPolicy: OptionParamPolicy;
  repeatPolicy: OptionRepeatPolicy;
  displayTemplate: string;
  searchTokens?: string[];
}

export type OptionDefinitionMap = ReadonlyMap<number, OptionDefinition>;

export interface OptionCondition {
  type: number;
  operator: OptionOperator;
  rawValue: number;
  displayValue: string;
  param?: number;
}

export interface StructuredOptionCondition {
  type: number;
  operator: string;
  value: string;
  param?: number;
}

export class OptionConditionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionConditionValidationError';
  }
}

export interface CompiledOptionPredicate {
  sql: string;
  values: unknown[];
}

const OPERATOR_SQL: Record<OptionOperator, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

const OPERATORS = new Set<string>(OPTION_OPERATORS);

export function parseOptionCondition(raw: string, definitions: OptionDefinitionMap): OptionCondition {
  const parts = raw.split(':');
  if (parts.length < 3 || parts.length > 4 || !/^\d+$/u.test(parts[0] ?? '')) throw new OptionConditionValidationError('Invalid option');
  const type = Number(parts[0]);
  if (!Number.isSafeInteger(type)) throw new OptionConditionValidationError('Invalid option');
  const rawParam = parts[3];
  if (rawParam !== undefined && !/^-?\d+$/u.test(rawParam)) throw new OptionConditionValidationError('Invalid option param');
  const param = rawParam === undefined ? undefined : Number(rawParam);
  if (param !== undefined && !Number.isSafeInteger(param)) throw new OptionConditionValidationError('Invalid option param');
  return parseStructuredOptionCondition({ type, operator: parts[1] ?? '', value: parts[2] ?? '', ...(param === undefined ? {} : { param }) }, definitions);
}

export function parseStructuredOptionCondition(raw: StructuredOptionCondition, definitions: OptionDefinitionMap): OptionCondition {
  if (!Number.isSafeInteger(raw.type) || raw.type < 0 || typeof raw.operator !== 'string' || typeof raw.value !== 'string') {
    throw new OptionConditionValidationError('Invalid option');
  }
  const definition = definitions.get(raw.type);
  if (!definition) throw new OptionConditionValidationError(`Unknown option type: ${raw.type}`);
  const operator = normalizeOperator(raw.operator);
  if (!operator) throw new OptionConditionValidationError('Invalid option operator');
  if (!definition.allowedOperators.includes(operator)) throw new OptionConditionValidationError('Option operator is not allowed');
  const displayValue = raw.value;
  const rawValue = parseDefinitionValue(displayValue, definition);
  const param = parseParam(raw.param, definition.paramPolicy);
  return { type: raw.type, operator, rawValue, displayValue, ...(param === undefined ? {} : { param }) };
}

export function compileOptionPredicates(
  conditions: readonly OptionCondition[],
  mode: 'all' | 'any',
  definitions: OptionDefinitionMap,
  startIndex = 1,
): CompiledOptionPredicate {
  if (conditions.length === 0) return { sql: '', values: [] };
  if (mode !== 'all' && mode !== 'any') throw new OptionConditionValidationError('Invalid option mode');
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `?${startIndex + values.length - 1}`;
  };
  const byType = new Map<number, OptionCondition[]>();
  for (const condition of conditions) {
    const definition = definitions.get(condition.type);
    if (!definition) throw new OptionConditionValidationError(`Unknown option type: ${condition.type}`);
    if (!definition.allowedOperators.includes(condition.operator)) throw new OptionConditionValidationError('Option operator is not allowed');
    byType.set(condition.type, [...(byType.get(condition.type) ?? []), condition]);
  }

  const groups: string[] = [];
  for (const [type, group] of byType) {
    const definition = definitions.get(type)!;
    if (mode === 'any') {
      groups.push(...group.map((condition) => compileSingleExists(condition, definition, bind)));
    } else if (definition.repeatPolicy === 'same' || group.length === 1) {
      const alias = 'lo';
      const predicates = [`${alias}.option_type=${bind(type)}`];
      for (const condition of group) predicates.push(...conditionPredicates(alias, condition, definition, bind));
      groups.push(`EXISTS (SELECT 1 FROM listing_options ${alias} WHERE ${alias}.listing_id=l.id AND ${predicates.join(' AND ')})`);
    } else {
      groups.push(compileDistinctExists(group, definition, bind));
    }
  }
  return { sql: groups.length === 1 ? groups[0]! : `(${groups.join(mode === 'any' ? ' OR ' : ' AND ')})`, values };
}

export function formatOptionDisplay(
  option: { type: number; value: number; param: number },
  definition?: OptionDefinition,
): string {
  if (!definition) return `未知词条 type=${option.type} value=${option.value} param=${option.param}`;
  const value = definition.valueType === 'scaled_integer'
    ? formatScaledValue(option.value, definition.scale)
    : String(option.value);
  return definition.displayTemplate
    .replaceAll('{value}', value)
    .replaceAll('{param}', String(option.param));
}

function compileSingleExists(
  condition: OptionCondition,
  definition: OptionDefinition,
  bind: (value: unknown) => string,
): string {
  const alias = 'lo';
  const predicates = [`${alias}.option_type=${bind(condition.type)}`, ...conditionPredicates(alias, condition, definition, bind)];
  return `EXISTS (SELECT 1 FROM listing_options ${alias} WHERE ${alias}.listing_id=l.id AND ${predicates.join(' AND ')})`;
}

function compileDistinctExists(
  conditions: readonly OptionCondition[],
  definition: OptionDefinition,
  bind: (value: unknown) => string,
): string {
  const aliases = conditions.map((_, index) => `lo${index}`);
  const joins = aliases.slice(1).map((alias, index) => {
    const previous = aliases.slice(0, index + 1);
    return `JOIN listing_options ${alias} ON ${alias}.listing_id=${aliases[0]}.listing_id AND ${previous.map((other) => `${alias}.option_index<>${other}.option_index`).join(' AND ')}`;
  });
  const predicates: string[] = [`${aliases[0]}.listing_id=l.id`];
  conditions.forEach((condition, index) => {
    const alias = aliases[index]!;
    predicates.push(`${alias}.option_type=${bind(condition.type)}`);
    predicates.push(...conditionPredicates(alias, condition, definition, bind));
  });
  return `EXISTS (SELECT 1 FROM listing_options ${aliases[0]} ${joins.join(' ')} WHERE ${predicates.join(' AND ')})`;
}

function conditionPredicates(
  alias: string,
  condition: OptionCondition,
  definition: OptionDefinition,
  bind: (value: unknown) => string,
): string[] {
  const predicates = [`${alias}.option_value ${OPERATOR_SQL[condition.operator]} ${bind(condition.rawValue)}`];
  if (definition.paramPolicy.mode !== 'ignored' && condition.param !== undefined) {
    predicates.push(`${alias}.option_param=${bind(condition.param)}`);
  }
  return predicates;
}

function parseDefinitionValue(raw: string, definition: OptionDefinition): number {
  if (definition.valueType === 'integer') {
    if (!/^-?\d+$/u.test(raw)) throw new OptionConditionValidationError('Invalid option value');
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new OptionConditionValidationError('Invalid option value');
    return value;
  }
  if (!/^-?\d+(?:\.\d+)?$/u.test(raw)) throw new OptionConditionValidationError('Invalid option value');
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const decimalPlaces = Math.log10(definition.scale);
  if (Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && fraction.length > decimalPlaces) throw new OptionConditionValidationError('Invalid option value');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  const scaled = numerator * BigInt(definition.scale);
  if (scaled % denominator !== 0n) throw new OptionConditionValidationError('Invalid option value');
  const signed = negative ? -(scaled / denominator) : scaled / denominator;
  const value = Number(signed);
  if (!Number.isSafeInteger(value)) throw new OptionConditionValidationError('Invalid option value');
  return value;
}

function normalizeOperator(raw: string): OptionOperator | null {
  const symbols: Record<string, OptionOperator> = { '=': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };
  if (raw in symbols) return symbols[raw]!;
  return OPERATORS.has(raw) ? raw as OptionOperator : null;
}

function parseParam(raw: number | undefined, policy: OptionParamPolicy): number | undefined {
  if (policy.mode === 'ignored') {
    if (raw !== undefined) throw new OptionConditionValidationError('Option param is not allowed');
    return undefined;
  }
  if (raw === undefined) {
    if (policy.mode === 'required_exact') throw new OptionConditionValidationError('Option param is required');
    return undefined;
  }
  if (!Number.isSafeInteger(raw)) throw new OptionConditionValidationError('Invalid option param');
  if (policy.value !== undefined && raw !== policy.value) throw new OptionConditionValidationError('Invalid option param');
  return raw;
}

function formatScaledValue(raw: number, scale: number): string {
  const digits = Math.log10(scale);
  if (!Number.isInteger(digits) || digits < 0) return String(raw / scale);
  const sign = raw < 0 ? '-' : '';
  const absolute = Math.abs(raw);
  const whole = Math.floor(absolute / scale);
  const fraction = String(absolute % scale).padStart(digits, '0');
  return digits === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}
