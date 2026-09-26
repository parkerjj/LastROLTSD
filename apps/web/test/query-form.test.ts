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
  valuePolicy: 'numeric',
  selectable: true,
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
  valuePolicy: 'numeric',
  selectable: true,
  unit: '%',
  scale: 100,
  allowedOperators: ['gte', 'lt'],
  paramPolicy: { mode: 'required_exact', filterable: true },
  repeatPolicy: 'distinct',
  displayTemplate: '倍率 {value}',
  searchTokens: [],
};

const weaponFire: OptionDefinition = {
  type: 178,
  handle: 'WEAPON_ATTR_FIRE',
  labelZh: '赋予武器火属性',
  descriptionTemplate: '赋予武器火属性',
  valueKind: 'integer',
  valuePolicy: 'flag',
  selectable: true,
  unit: '',
  scale: 1,
  allowedOperators: ['eq'],
  paramPolicy: { mode: 'ignored', filterable: false },
  repeatPolicy: 'same',
  displayTemplate: '赋予武器火属性',
  searchTokens: [],
};

const emptySlot: OptionDefinition = {
  type: 204,
  handle: 'NOTHING',
  labelZh: '空',
  descriptionTemplate: '空',
  valueKind: 'integer',
  valuePolicy: 'numeric',
  selectable: false,
  unit: '',
  scale: 1,
  allowedOperators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  paramPolicy: { mode: 'ignored', filterable: false },
  repeatPolicy: 'same',
  displayTemplate: '空',
  searchTokens: [],
};

function createForm(): { dom: JSDOM; form: HTMLFormElement; rows: HTMLElement } {
  const dom = new JSDOM('<form id="form"><label>搜索<input name="q" value="波利"></label><input type="radio" name="option_mode" value="all"><input type="radio" name="option_mode" value="any" checked><div id="rows"></div></form>');
  const form = dom.window.document.querySelector('form') as HTMLFormElement;
  return { dom, form, rows: form.querySelector('#rows') as HTMLElement };
}

describe('metadata-driven option controls', () => {
  it('renders associated controls and an operator prompt before a term is selected', () => {
    const { rows } = createForm();
    const row = appendOptionRow(rows, [spRecovery]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    const operator = row.querySelector<HTMLSelectElement>('[data-option-operator]')!;
    const value = row.querySelector<HTMLInputElement>('[data-option-value]')!;

    expect(type.id).toBeTruthy();
    expect(operator.id).toBeTruthy();
    expect(value.id).toBeTruthy();
    expect(row.querySelector<HTMLLabelElement>(`label[for="${type.id}"]`)).not.toBeNull();
    expect(row.querySelector<HTMLLabelElement>(`label[for="${operator.id}"]`)).not.toBeNull();
    expect(row.querySelector<HTMLLabelElement>(`label[for="${value.id}"]`)).not.toBeNull();
    expect(operator.disabled).toBe(true);
    expect(operator.options[0]?.textContent).toBe('');
    expect(operator.title).toBe('请先选择词条');
    expect(operator.getAttribute('aria-label')).toBe('比较符，请先选择词条');
  });

  it('keeps option guidance out of the numeric input after selecting a term', () => {
    const { rows } = createForm();
    const row = appendOptionRow(rows, [rate]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    const value = row.querySelector<HTMLInputElement>('[data-option-value]')!;

    type.value = '198';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));

    expect(value.placeholder).toBe('');
    expect(row.querySelector('.option-value-label > span')?.textContent).toBe('数值（%）');
    expect(row.querySelector('[data-option-unit]')).toBeNull();
  });

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
    expect(row.querySelector('[data-option-unit]')).toBeNull();
    expect(row.querySelector<HTMLInputElement>('[data-option-value]')?.title).toContain('数值');
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

    expect(serializeSearchForm(form, [spRecovery, rate], [
      { itemId: 4002, name: '波利帽', aliases: [] },
      { itemId: 4001, name: '波利卡片', aliases: ['波利'] },
    ])).toEqual({
      q: '波利',
      item_ids: [4001, 4002],
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

  it('ignores an incomplete row instead of sending a partial option filter', () => {
    const { form, rows } = createForm();
    const row = appendOptionRow(rows, [spRecovery]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    type.value = '12';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));

    expect(serializeSearchForm(form, [spRecovery])).toEqual({ q: '波利', limit: 20, sort: 'price_asc' });
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

  it('hides non-selectable sentinel slots from the term picker', () => {
    const { rows } = createForm();
    const row = appendOptionRow(rows, [spRecovery, weaponFire, emptySlot]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;

    expect(type.textContent).toContain('赋予武器火属性');
    expect(type.textContent).not.toContain('空');
    expect(Array.from(type.options).map((option) => option.value)).not.toContain('204');
  });

  it('hides operator and value controls and marks the row once a flag term is chosen', () => {
    const { rows } = createForm();
    const row = appendOptionRow(rows, [weaponFire]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    const operator = row.querySelector<HTMLSelectElement>('[data-option-operator]')!;
    const hint = row.querySelector<HTMLElement>('[data-option-flag-hint]')!;

    expect(hint.hidden).toBe(true);
    type.value = '178';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));

    expect(row.classList.contains('option-row-flag')).toBe(true);
    expect(hint.hidden).toBe(false);
    expect(operator.disabled).toBe(true);
    expect(row.querySelector('[data-option-value]')).toHaveProperty('value', '');
  });

  it('serializes a flag term as eq:0 without operator or value input', () => {
    const { form, rows } = createForm();
    const row = appendOptionRow(rows, [weaponFire]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    type.value = '178';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));

    expect(serializeSearchForm(form, [weaponFire])).toMatchObject({
      options: [{ type: 178, operator: 'eq', value: '0' }],
      option_mode: 'any',
    });
  });

  it('restores operator and value controls when switching from a flag back to a numeric term', () => {
    const { rows } = createForm();
    const row = appendOptionRow(rows, [spRecovery, weaponFire]);
    const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
    const operator = row.querySelector<HTMLSelectElement>('[data-option-operator]')!;
    const hint = row.querySelector<HTMLElement>('[data-option-flag-hint]')!;

    type.value = '178';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));
    expect(row.classList.contains('option-row-flag')).toBe(true);

    type.value = '12';
    type.dispatchEvent(new row.ownerDocument.defaultView!.Event('change', { bubbles: true }));
    expect(row.classList.contains('option-row-flag')).toBe(false);
    expect(hint.hidden).toBe(true);
    expect(operator.disabled).toBe(false);
    expect(Array.from(operator.options).map((option) => option.value)).toEqual(['eq', 'gte', 'lte']);
  });
});
