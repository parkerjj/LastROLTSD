import { describe, expect, it } from 'vitest';

const { buildJobNamesZh, buildJobSkills, buildSkillGroups, flattenJobSkillGroups } = await import(new URL('../../scripts/ke-job-map.mjs', import.meta.url).href) as {
  buildJobSkills: (skills: Array<{ id: number; handle: string }>, jobs: Record<string, string>) => Record<string, Record<string, number[]>>;
  flattenJobSkillGroups: (groups: Record<string, Record<string, number[]>>) => Record<string, number[]>;
  buildJobNamesZh: (jobs: Record<string, string>) => Record<string, string>;
  buildSkillGroups: (
    skills: Array<{ id: number; handle: string }>,
    jobSkillGroups: Record<string, Record<string, number[]>>,
    jobs: Record<string, string>,
    jobsZh?: Record<string, string>,
  ) => Record<number, string>;
};

describe('KE job skill mapping', () => {
  it('classifies Champion skills across first and second job tiers', () => {
    const skills = [
      { id: 1, handle: 'NV_BASIC' },
      { id: 29, handle: 'AL_INCAGI' },
      { id: 40, handle: 'MO_PALMSTRIKE' },
      { id: 41, handle: 'CH_TIGERFIST' },
      { id: 99, handle: 'AC_DOUBLE' },
    ];
    const jobs = { '176': 'Champion', '4016': 'Champion' };

    const mapping = buildJobSkills(skills, jobs);

    expect(mapping['176']).toEqual({
      '通用技能': [1],
      '一转技能': [29],
      '二转技能': [40, 41],
    });
    expect(mapping['4016']).toEqual(mapping['176']);
  });

  it('maps third and fourth job skills into separate tiers', () => {
    const skills = [
      { id: 1, handle: 'SM_BASH' },
      { id: 2, handle: 'KN_PIERCE' },
      { id: 3, handle: 'LK_AURABLADE' },
      { id: 4, handle: 'RK_SONICWAVE' },
      { id: 5, handle: 'DK_SERVANTWEAPON' },
    ];

    const mapping = buildJobSkills(skills, { '4252': 'Dragon Knight' });

    expect(mapping['4252']).toEqual({
      '一转技能': [1],
      '二转技能': [2, 3],
      '三转技能': [4],
      '四转技能': [5],
    });
    expect(flattenJobSkillGroups(mapping)['4252']).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not treat NV and ALL skill namespaces as universally available', () => {
    const skills = [
      { id: 1, handle: 'NV_BASIC' },
      { id: 2, handle: 'NV_FIRSTAID' },
      { id: 3, handle: 'NV_TRICKDEAD' },
      { id: 4, handle: 'ALL_CATCRY' },
      { id: 5, handle: 'ALL_PARTYFLEE' },
      { id: 6, handle: 'ALL_BUYING_STORE' },
      { id: 7, handle: 'ALL_RESURRECTION' },
      { id: 8, handle: 'ALL_FULL_THROTTLE' },
    ];
    const jobs = {
      '0': 'Novice',
      '2': 'Mage',
      '4': 'Merchant',
      '8': 'Priest',
      '4252': 'Dragon Knight',
    };

    const mapping = buildJobSkills(skills, jobs);

    expect(mapping['0']).toEqual({ '通用技能': [1, 2, 3] });
    expect(mapping['2']).toEqual({ '通用技能': [1, 2] });
    expect(mapping['4']).toEqual({ '通用技能': [1, 2], '一转技能': [6] });
    expect(mapping['8']).toEqual({ '通用技能': [1, 2], '二转技能': [7] });
    expect(mapping['4252']).toEqual({ '通用技能': [1, 2], '三转技能': [8] });
  });

  it('does not leak Sniper SN skills into Super Novice', () => {
    const skills = [
      { id: 1, handle: 'SM_BASH' },
      { id: 2, handle: 'AC_DOUBLE' },
      { id: 3, handle: 'SN_SIGHT' },
    ];
    const jobs = { '23': 'Super Novice', '24': 'Sniper' };

    const mapping = buildJobSkills(skills, jobs);

    expect(mapping['23']).toEqual({ '一转技能': [1, 2] });
    expect(mapping['24']).toEqual({ '一转技能': [2], '二转技能': [3] });
  });

  it('groups every skill under its owning job for the all-skills view', () => {
    const skills = [
      { id: 1, handle: 'NV_BASIC' },
      { id: 2, handle: 'SM_BASH' },
      { id: 3, handle: 'AC_DOUBLE' },
      { id: 4, handle: 'AL_HEAL' },
      { id: 5, handle: 'NPC_PIERCINGATT' },
    ];
    const jobs = {
      '0': 'Novice',
      '1': 'Swordsman',
      '3': 'Archer',
      '4': 'Acolyte',
    };
    const jobGroups = buildJobSkills(skills, jobs);
    const jobsZh = {
      '0': '初心者',
      '1': '剑士',
      '3': '弓箭手',
      '4': '服侍',
    };

    expect(buildSkillGroups(skills, jobGroups, jobs, jobsZh)).toEqual({
      '1': '通用技能',
      '2': '剑士',
      '3': '弓箭手',
      '4': '服侍',
      '5': '其他技能',
    });
  });

  it('translates all listed jobs and returns no mapping for unclassified jobs', () => {
    const jobs = {
      '176': 'Champion',
      '4252': 'Dragon Knight',
      '6001': 'Lif',
      '22': 'Wedding Suit',
    };

    expect(buildJobNamesZh(jobs)).toEqual({
      '176': '武术宗师',
      '4252': '龙骑士',
      '6001': '丽芙',
      '22': '婚礼礼服',
    });
    expect(buildJobSkills([{ id: 1, handle: 'NV_BASIC' }], jobs)['6001']).toBeUndefined();
  });
});
