import type { OptionDefinition, OptionOperator, SearchFilters, SearchOptionFilter } from './types';
import { catalogItemIds } from './catalog';

const OPERATOR_LABELS: Record<OptionOperator, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

const OPTION_OPERATORS = new Set<OptionOperator>(Object.keys(OPERATOR_LABELS) as OptionOperator[]);
let nextOptionRowId = 0;

function isOptionOperator(value: string): value is OptionOperator {
  return OPTION_OPERATORS.has(value as OptionOperator);
}

function isValidOptionValue(value: string, definition: OptionDefinition): boolean {
  if (definition.valueKind === 'integer') return /^-?\d+$/u.test(value) && Number.isSafeInteger(Number(value));
  if (!/^-?\d+(?:\.\d+)?$/u.test(value) || !Number.isSafeInteger(definition.scale) || definition.scale <= 0) return false;

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const decimalPlaces = Math.log10(definition.scale);
  if (Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && fraction.length > decimalPlaces) return false;
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  const scaled = numerator * BigInt(definition.scale);
  if (scaled % denominator !== 0n) return false;
  const signed = negative ? -(scaled / denominator) : scaled / denominator;
  return Number.isSafeInteger(Number(signed));
}

export function serializeSearchForm(form: HTMLFormElement, definitions: readonly OptionDefinition[] = [], catalog: readonly { itemId: number; name: string; aliases: string[] }[] = []): SearchFilters {
  const FormDataCtor = form.ownerDocument.defaultView?.FormData ?? FormData;
  const data = new FormDataCtor(form);
  const filters: SearchFilters = { limit: 20, sort: 'price_asc' };
  for (const [key, raw] of data.entries()) {
    const value = String(raw).trim();
    if (!value || key === 'option_mode' || key === 'options') continue;
    if (key === 'q') { (filters as unknown as Record<string, unknown>)[key] = value; continue; }
    if (key === 'item_id' || key === 'price_min' || key === 'price_max') {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) (filters as unknown as Record<string, unknown>)[key] = parsed;
      continue;
    }
    (filters as unknown as Record<string, unknown>)[key] = value;
  }

  const definitionMap = new Map(definitions.map((definition) => [definition.type, definition]));
  const options = Array.from(form.querySelectorAll<HTMLElement>('[data-option-row]')).flatMap((row): SearchOptionFilter[] => {
    const type = Number(row.querySelector<HTMLSelectElement>('[data-option-type]')?.value);
    const definition = definitionMap.get(type);
    const operator = row.querySelector<HTMLSelectElement>('[data-option-operator]')?.value as OptionOperator | undefined;
    const value = row.querySelector<HTMLInputElement>('[data-option-value]')?.value.trim() ?? '';
    const paramInput = row.querySelector<HTMLInputElement>('[data-option-param]');
    if (!definition || !Number.isSafeInteger(type) || !operator || !definition.allowedOperators.includes(operator) || !value) return [];
    if (!isValidOptionValue(value, definition)) throw new Error('词条数值格式无效');
    if (definition.paramPolicy.mode === 'required_exact' && !paramInput?.value.trim()) return [];
    const param = paramInput?.value.trim();
    const expectedParam = definition.paramPolicy.mode === 'ignored' ? undefined : definition.paramPolicy.value;
    if (param && (!/^-?\d+$/u.test(param) || !Number.isSafeInteger(Number(param)) || (expectedParam !== undefined && Number(param) !== expectedParam))) {
      throw new Error('词条参数格式无效');
    }
    return [{
      type,
      operator,
      value,
      ...(param ? { param: Number(param) } : {}),
    }];
  });
  if (filters.q && catalog.length > 0) {
    const itemIds = catalogItemIds(catalog, filters.q);
    if (itemIds.length > 0) filters.item_ids = itemIds;
  }
  if (options.length > 0) {
    filters.options = options;
    filters.option_mode = form.querySelector<HTMLInputElement>('input[name="option_mode"]:checked')?.value === 'any' ? 'any' : 'all';
  }
  return filters;
}

export function appendOptionRow(container: HTMLElement, definitions: readonly OptionDefinition[] = []): HTMLElement {
  const document = container.ownerDocument;
  const row = document.createElement('div');
  const rowId = `option-row-${++nextOptionRowId}`;
  const typeId = `${rowId}-type`;
  const operatorId = `${rowId}-operator`;
  const valueId = `${rowId}-value`;
  row.dataset.optionRow = 'true';
  row.className = 'option-row';
  row.innerHTML = `
    <label for="${typeId}"><span>词条</span><select id="${typeId}" data-option-type aria-label="词条"><option value="">请先选择词条</option>${definitions.map((definition) => `<option value="${definition.type}">${escapeAttribute(definition.labelZh)}</option>`).join('')}</select></label>
    <label for="${operatorId}"><span>比较符</span><select id="${operatorId}" data-option-operator aria-label="比较符"></select></label>
    <label class="option-value-label" for="${valueId}"><span>数值</span><input id="${valueId}" data-option-value aria-label="词条数值" inputmode="decimal" type="number" step="any" /></label>
    <button type="button" data-remove-option aria-label="删除词条">删除</button>`;
  const type = row.querySelector<HTMLSelectElement>('[data-option-type]')!;
  const operator = row.querySelector<HTMLSelectElement>('[data-option-operator]')!;
  const valueInput = row.querySelector<HTMLInputElement>('[data-option-value]')!;
  const valueLabel = row.querySelector<HTMLElement>('.option-value-label > span')!;
  const update = (): void => {
    const definition = definitions.find((candidate) => candidate.type === Number(type.value));
    const allowedOperators = definition?.allowedOperators.filter(isOptionOperator) ?? [];
    operator.disabled = !definition || allowedOperators.length === 0;
    operator.title = definition ? '选择比较符' : '请先选择词条';
    operator.setAttribute('aria-label', definition ? '比较符' : '比较符，请先选择词条');
    operator.innerHTML = allowedOperators.length > 0
      ? allowedOperators.map((value) => `<option value="${value}">${OPERATOR_LABELS[value]}</option>`).join('')
      : '<option value=""></option>';
    const prompt = definition?.descriptionTemplate.replace('{value}', '数值') ?? '';
    valueLabel.textContent = definition?.unit ? `数值（${definition.unit}）` : '数值';
    valueInput.title = prompt;
    row.querySelector('[data-option-param-wrap]')?.remove();
    if (definition?.paramPolicy.filterable) {
      const paramWrap = document.createElement('label');
      const paramId = `${rowId}-param`;
      paramWrap.dataset.optionParamWrap = 'true';
      paramWrap.htmlFor = paramId;
      paramWrap.innerHTML = `<span>参数</span><input id="${paramId}" data-option-param aria-label="词条参数" inputmode="numeric" type="number" step="1" />`;
      row.insertBefore(paramWrap, row.querySelector('[data-remove-option]'));
    }
  };
  type.addEventListener('change', update);
  row.querySelector('[data-remove-option]')?.addEventListener('click', () => row.remove());
  update();
  container.append(row);
  return row;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}
