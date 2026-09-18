import type { SearchFilters } from './types';

export function serializeSearchForm(form: HTMLFormElement): SearchFilters {
  const FormDataCtor = form.ownerDocument.defaultView?.FormData;
  const data = FormDataCtor ? new FormDataCtor(form) : new FormData(form);
  const filters: SearchFilters = { limit: 20, sort: 'price_asc' };
  const numeric = new Set(['item_id', 'price_min', 'price_max', 'option_type', 'option_value', 'option_param']);
  for (const [key, raw] of data.entries()) {
    const value = String(raw).trim();
    if (!value) continue;
    if (key === 'option_mode') continue;
    if (key === 'options') continue;
    if (numeric.has(key)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) (filters as Record<string, unknown>)[key] = parsed;
    } else {
      (filters as Record<string, unknown>)[key] = value;
    }
  }
  const optionRows = Array.from(form.querySelectorAll<HTMLElement>('[data-option-row]')).map((row) => {
    const type = Number((row.querySelector('[name="option_type"]') as HTMLInputElement)?.value);
    const value = Number((row.querySelector('[name="option_value"]') as HTMLInputElement)?.value);
    const param = Number((row.querySelector('[name="option_param"]') as HTMLInputElement)?.value || 0);
    return Number.isSafeInteger(type) && Number.isSafeInteger(value) && Number.isSafeInteger(param) ? { type, value, param } : null;
  }).filter((option): option is { type: number; value: number; param: number } => option !== null);
  if (optionRows.length > 0) {
    const mode = form.querySelector<HTMLInputElement>('input[name="option_mode"]:checked')?.value === 'any' ? 'any' : 'all';
    (filters as Record<string, unknown>).options = optionRows;
    (filters as Record<string, unknown>).option_mode = mode;
  }
  return filters;
}

export function appendOptionRow(container: HTMLElement): void {
  const row = container.ownerDocument.createElement('div');
  row.dataset.optionRow = 'true';
  row.className = 'option-row';
  row.innerHTML = '<label>Type<input name="option_type" inputmode="numeric" /></label><label>Value<input name="option_value" inputmode="numeric" /></label><label>Param<input name="option_param" inputmode="numeric" value="0" /></label><button type="button" data-remove-option aria-label="Remove option">Remove</button>';
  row.querySelector('[data-remove-option]')?.addEventListener('click', () => row.remove());
  container.append(row);
}
