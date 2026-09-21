import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { appendOptionRow, serializeSearchForm } from '../src/query-form';
import type { OptionDefinition } from '../src/types';

const spRecovery: OptionDefinition = {
  type: 12,
  handle: 'VAR_SPACCELERATION',
  labelZh: 'SP恢复速度增加数值%',
  descriptionTemplate: 'SP恢复速度增加{value}%',
  valueKind: 'integer',
  unit: '',
  scale: 1,
  allowedOperators: ['eq', 'gte', 'lte'],
  paramPolicy: { mode: 'ignored', filterable: false },
  repeatPolicy: 'same',
  displayTemplate: 'SP恢复速度增加{value}%',
  searchTokens: [],
};

const rate: OptionDefinition = {
  type: 198,
  handle: 'rate',
  labelZh: '倍率',
  descriptionTemplate: '倍率 {value}',
  valueKind: 'scaled_integer',
  unit: '%',
  scale: 100,
  allowedOperators: ['gte', 'lt'],
  paramPolicy: { mode: 'required_exact', filterable: true },
  repeatPolicy: 'distinct',
  displayTemplate: '倍率 {value}',
  searchTokens: [],
};

function createForm(): { dom: JSDOM; form: HTMLFormElement; rows: HTMLElement } {
  const dom = new JSDOM('<form id="form"><label>搜索<input name="q" value="波利"></label><input type="radio" name="option_mode" value="all"><input type="radio" name="option_mode" value="any" checked><div id="rows"></div></form>');
  const form = dom.window.document.querySelector('form') as HTMLFormElement;
  return { dom, form, rows: form.querySelector('#rows') as HTMLElement };
}

describe('metadata-driven option controls', () => {
  it('renders Chinese option labels and only the operators allowed by the definition', () => {
    const { rows } = createForm();
    const row = appendOptionRow(rows, [spRecovery, rate]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;

    expect(type.textContent).toContain('SP恢复速度增加数值%');
    type.value = '12';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));

    const operator = row.querySelector<HTMLSelectElement>('[data-option-operator]')!;
    expect(Array.from(operator.options).map((option) => option.value)).toEqual(['eq', 'gte', 'lte']);
    expect(row.querySelector<HTMLInputElement>('[data-option-param]')).toBeNull();
    expect(row.querySelector('[data-option-unit]')?.textContent).not.toContain('点');
  });

  it('shows a parameter control only when server metadata requires it', () => {
    const { rows } = createForm();
    const row = appendOptionRow(rows, [spRecovery, rate]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;

    type.value = '198';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));

    expect(row.querySelector<HTMLInputElement>('[data-option-param]')).not.toBeNull();
    expect(row.querySelector('[data-option-param]')?.getAttribute('aria-label')).toBe('词条参数');
  });

  it('serializes SP recovery >= 50, any mode, and multiple rows', () => {
    const { form, rows } = createForm();
    const first = appendOptionRow(rows, [spRecovery, rate]);
    const second = appendOptionRow(rows, [spRecovery, rate]);
    const firstType = first.querySelector<HTMLSelectElement>('[data-option-type]')!;
    const firstOperator = first.querySelector<HTMLSelectElement>('[data-option-operator]')!;
    const secondType = second.querySelector<HTMLSelectElement>('[data-option-type]')!;
    const secondOperator = second.querySelector<HTMLSelectElement>('[data-option-operator]')!;
    firstType.value = '12';
    firstType.dispatchEvent(new first.ownerDocument.defaultView!.Event('change', { bubbles: true }));
    firstOperator.value = 'gte';
    first.querySelector<HTMLInputElement>('[data-option-value]')!.value = '50';
    secondType.value = '198';
    secondType.dispatchEvent(new second.ownerDocument.defaultView!.Event('change', { bubbles: true }));
    secondOperator.value = 'lt';
    second.querySelector<HTMLInputElement>('[data-option-value]')!.value = '1.50';
    second.querySelector<HTMLInputElement>('[data-option-param]')!.value = '7';

    expect(serializeSearchForm(form, [spRecovery, rate])).toEqual({
      q: '波利',
      limit: 20,
      sort: 'price_asc',
      options: [
        { type: 12, operator: 'gte', value: '50' },
        { type: 198, operator: 'lt', value: '1.50', param: 7 },
      ],
      option_mode: 'any',
    });
  });

  it('adds and removes multiple rows', () => {
    const { rows } = createForm();
    appendOptionRow(rows, [spRecovery]);
    appendOptionRow(rows, [spRecovery]);
    expect(rows.querySelectorAll('[data-option-row]')).toHaveLength(2);
    rows.querySelector<HTMLButtonElement>('[data-remove-option]')!.click();
    expect(rows.querySelectorAll('[data-option-row]')).toHaveLength(1);
  });

  it('rejects an incomplete row instead of sending a partial option filter', () => {
    const { form, rows } = createForm();
    const row = appendOptionRow(rows, [spRecovery]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    type.value = '12';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));

    expect(() => serializeSearchForm(form, [spRecovery])).toThrow('请完整填写词条条件');
  });

  it('does not expose unknown operators from malformed metadata', () => {
    const { rows } = createForm();
    const definition = { ...spRecovery, allowedOperators: ['gte', 'raw_sql'] as OptionDefinition['allowedOperators'] };
    const row = appendOptionRow(rows, [definition]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    type.value = '12';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));

    expect(Array.from(row.querySelector<HTMLSelectElement>('[data-option-operator]')!.options).map((option) => option.value)).toEqual(['gte']);
  });

  it('rejects a decimal value for an integer definition', () => {
    const { form, rows } = createForm();
    const row = appendOptionRow(rows, [spRecovery]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    type.value = '12';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));
    row.querySelector<HTMLInputElement>('[data-option-value]')!.value = '1.5';

    expect(() => serializeSearchForm(form, [spRecovery])).toThrow('词条数值格式无效');
  });

  it('rejects scaled values that exceed the server precision', () => {
    const { form, rows } = createForm();
    const row = appendOptionRow(rows, [rate]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    type.value = '198';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));
    row.querySelector<HTMLInputElement>('[data-option-value]')!.value = '1.234';
    row.querySelector<HTMLInputElement>('[data-option-param]')!.value = '7';

    expect(() => serializeSearchForm(form, [rate])).toThrow('词条数值格式无效');
  });
});
