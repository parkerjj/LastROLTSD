import { describe, expect, it } from 'vitest';
import { compileOptionPredicates, formatOptionDisplay, parseOptionCondition, type OptionDefinition, type OptionDefinitionMap } from '../src/domain/option-conditions';

const definitions: OptionDefinitionMap = new Map<number, OptionDefinition>([
  [12, { type: 12, handle: 'VAR_SPACCELERATION', labelZh: 'SP恢复速度增加数值%', descriptionTemplate: 'SP恢复速度增加{value}%', valueType: 'integer', unit: '', scale: 1, allowedOperators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'], paramPolicy: { mode: 'ignored', filterable: false }, repeatPolicy: 'same', displayTemplate: 'SP恢复速度增加{value}%' }],
  [198, { type: 198, handle: 'test_rate', labelZh: '倍率', descriptionTemplate: '倍率 {value}', valueType: 'scaled_integer', unit: '%', scale: 100, allowedOperators: ['eq', 'gte'], paramPolicy: { mode: 'required_exact', value: 7, filterable: true }, repeatPolicy: 'distinct', displayTemplate: '倍率 {value}' }],
]);

describe('option conditions', () => {
  it.each([
    ['=', 'eq'], ['!=', 'neq'], ['>', 'gt'], ['>=', 'gte'], ['<', 'lt'], ['<=', 'lte'],
  ] as const)('maps %s to the server operator %s', (symbol, operator) => {
    const condition = parseOptionCondition(`12:${symbol}:50`, definitions);
    expect(condition).toMatchObject({ type: 12, operator, rawValue: 50 });
    expect(condition).not.toHaveProperty('param');
    expect(compileOptionPredicates([condition], 'all', definitions).sql).toContain(`option_value ${operator === 'eq' ? '=' : operator === 'neq' ? '<>' : operator === 'gt' ? '>' : operator === 'gte' ? '>=' : operator === 'lt' ? '<' : '<='}`);
  });

  it('rejects unknown and definition-disallowed operators', () => {
    expect(() => parseOptionCondition('12:between:50', definitions)).toThrow('Invalid option operator');
    expect(() => parseOptionCondition('198:neq:1', definitions)).toThrow('operator is not allowed');
    expect(() => parseOptionCondition('999:eq:1', definitions)).toThrow('Unknown option type');
  });

  it('parses scaled decimal values as exact integers and rejects exponent or excess precision', () => {
    expect(parseOptionCondition('198:gte:1.50:7', definitions)).toMatchObject({ rawValue: 150, displayValue: '1.50', param: 7 });
    expect(() => parseOptionCondition('198:gte:1e2:7', definitions)).toThrow('Invalid option value');
    expect(() => parseOptionCondition('198:gte:1.234:7', definitions)).toThrow('Invalid option value');
    expect(() => parseOptionCondition('198:gte:1.500:7', definitions)).toThrow('Invalid option value');
  });

  it('enforces required and forbidden params', () => {
    expect(() => parseOptionCondition('198:gte:1.5', definitions)).toThrow('param is required');
    expect(() => parseOptionCondition('12:gte:5:1', definitions)).toThrow('param is not allowed');
  });

  it('compiles all and any modes without interpolating values or operators', () => {
    const first = parseOptionCondition('12:gte:50', definitions);
    const second = parseOptionCondition('12:lt:100', definitions);
    const all = compileOptionPredicates([first, second], 'all', definitions);
    const any = compileOptionPredicates([first, second], 'any', definitions);
    expect(all.sql).toContain(' AND ');
    expect(any.sql).toContain(' OR ');
    expect(all.sql).not.toContain('50');
    expect(all.values).toEqual([12, 50, 100]);
  });

  it('uses same occurrence semantics for repeated types and distinct occurrence semantics when declared', () => {
    const same = compileOptionPredicates([
      parseOptionCondition('12:gte:50', definitions), parseOptionCondition('12:lt:100', definitions),
    ], 'all', definitions);
    const distinct = compileOptionPredicates([
      parseOptionCondition('198:gte:1.5:7', definitions), parseOptionCondition('198:eq:2:7', definitions),
    ], 'all', definitions);
    expect(same.sql.match(/EXISTS/g)?.length).toBe(1);
    expect(distinct.sql).toContain('JOIN listing_options');
    expect(distinct.sql).toContain('option_index<>');
  });

  it('renders display text from definitions and raw tuples only', () => {
    expect(formatOptionDisplay({ type: 12, value: 50, param: 0 }, definitions.get(12))).toBe('SP恢复速度增加50%');
    expect(formatOptionDisplay({ type: 198, value: 150, param: 7 }, definitions.get(198))).toBe('倍率 1.50');
    expect(formatOptionDisplay({ type: 999, value: 3, param: 4 })).toBe('未知词条 type=999 value=3 param=4');
  });
});
