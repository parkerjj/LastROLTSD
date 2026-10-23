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
  it('builds full job-family filters with mounted, high, baby, third, and fourth job variants', async () => {
    const module = await import(new URL('../../scripts/ke-job-map.mjs', import.meta.url).href) as {
      buildHallJobFamilies?: (jobs: Record<string, string>) => Array<{ value: string; label: string; job_ids: number[] }>;
    };
    const jobs = {
      '0': 'Novice', '1': 'Swordsman', '2': 'Mage', '7': 'Knight', '9': 'Wizard', '13': 'Peco Knight', '14': 'Crusader', '21': 'Peco Crusader',
      '23': 'Super Novice', '24': 'Gunslinger', '25': 'Ninja',
      '161': 'High Novice',
      '162': 'High Swordsman', '168': 'Lord Knight', '170': 'High Wizard', '174': 'Peco Lord Knight', '175': 'Paladin',
      '4001': 'High Novice', '4002': 'High Swordsman', '4008': 'Lord Knight', '4014': 'Peco Lord Knight', '4015': 'Paladin', '4022': 'Peco Paladin',
      '4023': 'Baby Novice',
      '4024': 'Baby Swordsman', '4030': 'Baby Knight', '4036': 'Baby Peco Knight', '4037': 'Baby Crusader', '4044': 'Baby Peco Crusader',
      '4054': 'Rune Knight', '4055': 'Warlock', '4066': 'Royal Guard', '4073': 'Royal Guard', '4080': 'Rune Knight', '4095': 'Rune Knight',
      '4096': 'Baby Rune', '4102': 'Baby Guard', '4252': 'Dragon Knight', '4255': 'Arch Mage', '4258': 'Imperial Guard',
      '4045': 'Super Baby', '4046': 'Taekwon', '4047': 'Star Gladiator', '4049': 'Soul Linker',
      '4211': 'Kagerou', '4212': 'Oboro', '4215': 'Rebellion', '4239': 'Star Emperor', '4240': 'Soul Reaper',
      '4190': 'Super Novice', '4191': 'Super Baby',
    };

    const filters = module.buildHallJobFamilies?.(jobs) ?? [];

    expect(filters.find((filter) => filter.value === 'knight')).toMatchObject({
      label: '骑士系',
      job_ids: [0, 1, 7, 13, 161, 162, 168, 174, 4001, 4002, 4008, 4014, 4023, 4024, 4030, 4036, 4054, 4080, 4095, 4096, 4252],
    });
    expect(filters.find((filter) => filter.value === 'crusader')).toMatchObject({
      label: '十字军系',
      job_ids: [0, 1, 14, 21, 161, 162, 175, 4001, 4002, 4015, 4022, 4023, 4024, 4037, 4044, 4066, 4073, 4102, 4258],
    });
    expect(filters.find((filter) => filter.value === 'knight')?.job_ids).not.toContain(23);
    expect(filters.find((filter) => filter.value === 'wizard')?.job_ids).toEqual([0, 2, 9, 161, 170, 4001, 4023, 4055, 4255]);
    expect(filters.find((filter) => filter.value === 'super-novice')?.job_ids).toEqual([0, 23, 4023, 4045, 4190, 4191]);
    expect(filters.find((filter) => filter.value === 'gunslinger')?.job_ids).toEqual([0, 24, 4023, 4215]);
    expect(filters.find((filter) => filter.value === 'ninja')?.job_ids).toEqual([0, 25, 4023, 4211, 4212]);
    expect(filters.find((filter) => filter.value === 'star-gladiator')?.job_ids).toEqual([0, 4023, 4046, 4047, 4239]);
    expect(filters.find((filter) => filter.value === 'soul-linker')?.job_ids).toEqual([0, 4023, 4046, 4049, 4240]);
  });

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
