import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { appendOptionRow, serializeSearchForm } from '../src/query-form';

describe('query option controls', () => {
  it('serializes multiple option rows and any mode', () => {
    const dom = new JSDOM('<form id="form"><input name="q" value="sword"><input type="radio" name="option_mode" value="any" checked><div id="rows"></div></form>');
    const form = dom.window.document.querySelector('form') as HTMLFormElement;
    const rows = form.querySelector('#rows') as HTMLElement;
    appendOptionRow(rows);
    appendOptionRow(rows);
    const inputs = rows.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = '1'; inputs[1]!.value = '2'; inputs[2]!.value = '0';
    inputs[3]!.value = '3'; inputs[4]!.value = '4'; inputs[5]!.value = '5';
    expect(serializeSearchForm(form)).toMatchObject({ q: 'sword', option_mode: 'any', options: [{ type: 1, value: 2, param: 0 }, { type: 3, value: 4, param: 5 }] });
  });
});
