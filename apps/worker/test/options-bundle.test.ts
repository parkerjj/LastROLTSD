import { describe, expect, it } from 'vitest';
import { createD1Repository } from '../src/db/d1-repository';
import { parseOptionCondition } from '../src/domain/option-conditions';
import { getOptionDefinitionSet, OPTION_DEFINITION_MAP, OPTION_DEFINITIONS, OPTION_DEFINITIONS_VERSION } from '@lastroweb/options';

describe('static option bundle', () => {
  it('contains the complete official version and validates known types', () => {
    expect(OPTION_DEFINITIONS_VERSION).toBe('options-lastro-70.83');
    expect(OPTION_DEFINITIONS).toHaveLength(193);
    expect(parseOptionCondition('1:gte:2', OPTION_DEFINITION_MAP)).toMatchObject({ type: 1, rawValue: 2, operator: 'gte' });
    expect(() => parseOptionCondition('999:eq:1', OPTION_DEFINITION_MAP)).toThrow('Unknown option type');
  });

  it('loads definitions without touching D1', async () => {
    const db = { prepare: () => { throw new Error('D1 must not be read for option metadata'); } };
    const repository = createD1Repository(db as never);
    await expect(repository.getOptionDefinitions()).resolves.toMatchObject({ version: OPTION_DEFINITIONS_VERSION, items: OPTION_DEFINITIONS });
    await expect(repository.getOptionDefinitions('options-lastro-70.83')).resolves.toHaveProperty('items.length', 193);
  });

  it('rejects an unknown bundle version', () => {
    expect(() => getOptionDefinitionSet('missing')).toThrow('Unknown option version');
  });
});
