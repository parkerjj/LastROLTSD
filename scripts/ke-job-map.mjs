const JOB_SKILL_PATHS = {
  Novice: { tier: 0, prefixes: [] },
  'High Novice': { parent: 'Novice', tier: 0, prefixes: [] },
  Swordsman: { parent: 'Novice', tier: 1, prefixes: ['SM'] },
  'High Swordsman': { parent: 'High Novice', tier: 1, prefixes: ['SM'] },
  Knight: { parent: 'Swordsman', tier: 2, prefixes: ['KN'] },
  'Lord Knight': { parent: 'Knight', tier: 2, prefixes: ['LK'] },
  'Rune Knight': { parent: 'Lord Knight', tier: 3, prefixes: ['RK'] },
  'Dragon Knight': { parent: 'Rune Knight', tier: 4, prefixes: ['DK'] },
  Crusader: { parent: 'Swordsman', tier: 2, prefixes: ['CR'] },
  Paladin: { parent: 'Crusader', tier: 2, prefixes: ['PA'] },
  'Royal Guard': { parent: 'Paladin', tier: 3, prefixes: ['LG'] },
  'Imperial Guard': { parent: 'Royal Guard', tier: 4, prefixes: ['IG'] },

  Mage: { parent: 'Novice', tier: 1, prefixes: ['MG'] },
  'High Magician': { parent: 'High Novice', tier: 1, prefixes: ['MG'] },
  Wizard: { parent: 'Mage', tier: 2, prefixes: ['WZ'] },
  'High Wizard': { parent: 'Wizard', tier: 2, prefixes: ['HW'] },
  Warlock: { parent: 'High Wizard', tier: 3, prefixes: ['WL'] },
  'Arch Mage': { parent: 'Warlock', tier: 4, prefixes: ['AG'] },
  Sage: { parent: 'Mage', tier: 2, prefixes: ['SA'] },
  Professor: { parent: 'Sage', tier: 2, prefixes: ['PF'] },
  Sorcerer: { parent: 'Professor', tier: 3, prefixes: ['SO'] },
  'Elemental Master': { parent: 'Sorcerer', tier: 4, prefixes: ['EM'] },

  Archer: { parent: 'Novice', tier: 1, prefixes: ['AC'] },
  'High Archer': { parent: 'High Novice', tier: 1, prefixes: ['AC'] },
  Hunter: { parent: 'Archer', tier: 2, prefixes: ['HT'] },
  Sniper: { parent: 'Hunter', tier: 2, prefixes: ['SN'] },
  Ranger: { parent: 'Sniper', tier: 3, prefixes: ['RA'] },
  Windhawk: { parent: 'Ranger', tier: 4, prefixes: ['WH'] },
  Bard: { parent: 'Archer', tier: 2, prefixes: ['BA'] },
  Clown: { parent: 'Bard', tier: 2, prefixes: ['BD'] },
  Minstrel: { parent: 'Clown', tier: 3, prefixes: ['MI', 'WM'] },
  Troubadour: { parent: 'Minstrel', tier: 4, prefixes: ['TR'] },
  Dancer: { parent: 'Archer', tier: 2, prefixes: ['DC'] },
  Gypsy: { parent: 'Dancer', tier: 2, prefixes: ['BD'] },
  Wanderer: { parent: 'Gypsy', tier: 3, prefixes: ['WA', 'WM'] },
  Trouvere: { parent: 'Wanderer', tier: 4, prefixes: ['TV'] },

  Acolyte: { parent: 'Novice', tier: 1, prefixes: ['AL'] },
  'High Acolyte': { parent: 'High Novice', tier: 1, prefixes: ['AL'] },
  Priest: { parent: 'Acolyte', tier: 2, prefixes: ['PR'] },
  'High Priest': { parent: 'Priest', tier: 2, prefixes: ['HP'] },
  'Arch Bishop': { parent: 'High Priest', tier: 3, prefixes: ['AB'] },
  Cardinal: { parent: 'Arch Bishop', tier: 4, prefixes: ['CD'] },
  Monk: { parent: 'Acolyte', tier: 2, prefixes: ['MO'] },
  Champion: { parent: 'Monk', tier: 2, prefixes: ['CH'] },
  Sura: { parent: 'Champion', tier: 3, prefixes: ['SR'] },
  Inquisitor: { parent: 'Sura', tier: 4, prefixes: ['IQ'] },

  Merchant: { parent: 'Novice', tier: 1, prefixes: ['MC'] },
  'High Merchant': { parent: 'High Novice', tier: 1, prefixes: ['MC'] },
  Blacksmith: { parent: 'Merchant', tier: 2, prefixes: ['BS'] },
  Whitesmith: { parent: 'Blacksmith', tier: 2, prefixes: ['WS'] },
  Mechanic: { parent: 'Whitesmith', tier: 3, prefixes: ['NC'] },
  Meister: { parent: 'Mechanic', tier: 4, prefixes: ['MT'] },
  Alchemist: { parent: 'Merchant', tier: 2, prefixes: ['AM'] },
  Creator: { parent: 'Alchemist', tier: 2, prefixes: [] },
  Genetic: { parent: 'Creator', tier: 3, prefixes: ['GN'] },
  Biolo: { parent: 'Genetic', tier: 4, prefixes: ['BO'] },

  Thief: { parent: 'Novice', tier: 1, prefixes: ['TF'] },
  'High Thief': { parent: 'High Novice', tier: 1, prefixes: ['TF'] },
  Assassin: { parent: 'Thief', tier: 2, prefixes: ['AS'] },
  'Assassin Cross': { parent: 'Assassin', tier: 2, prefixes: ['ASC'] },
  'Guillotine Cross': { parent: 'Assassin Cross', tier: 3, prefixes: ['GC'] },
  'Shadow Cross': { parent: 'Guillotine Cross', tier: 4, prefixes: ['SHC'] },
  Rogue: { parent: 'Thief', tier: 2, prefixes: ['RG'] },
  Stalker: { parent: 'Rogue', tier: 2, prefixes: ['ST'] },
  'Shadow Chaser': { parent: 'Stalker', tier: 3, prefixes: ['SC'] },
  'Abyss Chaser': { parent: 'Shadow Chaser', tier: 4, prefixes: ['ABC'] },

  'Super Novice': { parent: 'Novice', tier: 1, prefixes: ['SM', 'MG', 'AC', 'AL', 'MC', 'TF'] },
  Gunslinger: { tier: 1, prefixes: ['GS'] },
  Rebellion: { parent: 'Gunslinger', tier: 2, prefixes: ['RL'] },
  Ninja: { tier: 1, prefixes: ['NJ'] },
  Kagerou: { parent: 'Ninja', tier: 2, prefixes: ['KG', 'KO'] },
  Oboro: { parent: 'Ninja', tier: 2, prefixes: ['OB', 'KO'] },
  Taekwon: { tier: 1, prefixes: ['TK'] },
  'Star Gladiator': { parent: 'Taekwon', tier: 2, prefixes: ['SG'] },
  'Soul Linker': { parent: 'Taekwon', tier: 2, prefixes: ['SL'] },
  'Star Emperor': { parent: 'Star Gladiator', tier: 3, prefixes: ['SJ'] },
  'Soul Reaper': { parent: 'Soul Linker', tier: 3, prefixes: ['SP'] },
  Summoner: { tier: 1, prefixes: ['DORAM', 'SU'] },
};

const JOB_ALIASES = {
  'Peco Knight': 'Knight',
  'Peco Crusader': 'Crusader',
  'Peco Lord Knight': 'Lord Knight',
  'Peco Paladin': 'Paladin',
  'Glt. Cross': 'Guillotine Cross',
  'Flying Star Gladiator': 'Star Gladiator',
  'Super Baby': 'Super Novice',
  Magician: 'Mage',
  Bishop: 'Arch Bishop',
  Cross: 'Guillotine Cross',
  Guard: 'Royal Guard',
  Rune: 'Rune Knight',
  Chaser: 'Shadow Chaser',
};

const TIER_LABELS = ['通用技能', '一转技能', '二转技能', '三转技能', '四转技能'];
const OTHER_SKILL_LABEL = '其他技能';
const NOVICE_SHARED_SKILLS = new Set(['NV_BASIC', 'NV_FIRSTAID']);
const NOVICE_ONLY_SKILLS = new Set(['Novice', 'High Novice', 'Baby Novice']);
const JOB_SKILL_OVERRIDES = {
  ALL_BUYING_STORE: { tier: 1, jobs: new Set(['Merchant', 'Super Novice']) },
  ALL_RESURRECTION: { tier: 2, jobs: new Set(['Priest']) },
  ALL_FULL_THROTTLE: {
    tier: 3,
    jobs: new Set([
      'Genetic', 'Rune Knight', 'Warlock', 'Ranger', 'Arch Bishop', 'Mechanic', 'Guillotine Cross',
      'Royal Guard', 'Sorcerer', 'Minstrel', 'Wanderer', 'Sura', 'Shadow Chaser',
    ]),
  },
};

const JOB_NAMES_ZH = {
  Novice: '初心者', Swordsman: '剑士', Mage: '魔法师', Archer: '弓箭手', Acolyte: '服侍', Merchant: '商人', Thief: '盗贼',
  Knight: '骑士', 'Peco Knight': '骑乘骑士', Crusader: '十字军', 'Peco Crusader': '骑乘十字军',
  Priest: '牧师', Wizard: '巫师', Blacksmith: '铁匠', Hunter: '猎人', Assassin: '刺客', 'Peco Lord Knight': '骑乘骑士领主',
  'Peco Paladin': '骑乘圣骑士', Monk: '武僧', Sage: '贤者', Rogue: '流氓', Alchemist: '炼金术士', Bard: '吟游诗人', Dancer: '舞娘',
  'High Novice': '高阶初心者', 'High Swordsman': '高阶剑士', 'High Magician': '高阶魔法师', 'High Archer': '高阶弓箭手',
  'High Acolyte': '高阶服侍', 'High Merchant': '高阶商人', 'High Thief': '高阶盗贼',
  'Lord Knight': '骑士领主', 'High Priest': '神官', 'High Wizard': '高阶巫师', Whitesmith: '神工匠',
  Sniper: '神射手', 'Assassin Cross': '十字刺客', Paladin: '圣骑士', Champion: '武术宗师', Professor: '智者',
  Stalker: '神行太保', Creator: '创造者', Clown: '搞笑艺人', Gypsy: '冷艳舞姬',
  Gunslinger: '神枪手', Ninja: '忍者', Taekwon: '跆拳少年', 'Star Gladiator': '拳圣', 'Flying Star Gladiator': '飞行拳圣',
  'Soul Linker': '悟灵士', Kagerou: '影狼', Oboro: '胧', Rebellion: '叛乱者', Summoner: '召唤师',
  'Star Emperor': '星帝', 'Soul Reaper': '灵魂收割者',
  'Rune Knight': '符文骑士', Warlock: '咒术师', Ranger: '游侠', 'Arch Bishop': '大主教', Mechanic: '机匠',
  'Glt. Cross': '十字刺客', 'Royal Guard': '皇家卫士', Sorcerer: '妖术师', Minstrel: '宫廷乐师',
  Wanderer: '浪迹舞者', Sura: '修罗', Genetic: '基因学者', 'Shadow Chaser': '影舞者',
  'Dragon Knight': '龙骑士', Meister: '机甲师', 'Shadow Cross': '影十字', 'Arch Mage': '大法师', Cardinal: '红衣主教',
  Windhawk: '风鹰', 'Imperial Guard': '帝国卫士', Biolo: '生物学家', 'Abyss Chaser': '深渊追迹者',
  'Elemental Master': '元素支配者', Inquisitor: '十字驱魔师', Troubadour: '游唱诗人', Trouvere: '游侠舞者',
  'Super Novice': '超级初心者', 'Super Baby': '超级初心者（宝宝）',
  'Baby Novice': '初心者（宝宝）', 'Baby Swordsman': '剑士（宝宝）', 'Baby Magician': '魔法师（宝宝）',
  'Baby Archer': '弓箭手（宝宝）', 'Baby Acolyte': '服侍（宝宝）', 'Baby Merchant': '商人（宝宝）', 'Baby Thief': '盗贼（宝宝）',
  'Baby Knight': '骑士（宝宝）', 'Baby Priest': '牧师（宝宝）', 'Baby Wizard': '巫师（宝宝）',
  'Baby Blacksmith': '铁匠（宝宝）', 'Baby Hunter': '猎人（宝宝）', 'Baby Assassin': '刺客（宝宝）',
  'Baby Crusader': '十字军（宝宝）', 'Baby Monk': '武僧（宝宝）', 'Baby Sage': '贤者（宝宝）',
  'Baby Rogue': '流氓（宝宝）', 'Baby Alchemist': '炼金术士（宝宝）', 'Baby Bard': '吟游诗人（宝宝）',
  'Baby Dancer': '舞娘（宝宝）', 'Baby Peco Knight': '骑乘骑士（宝宝）', 'Baby Peco Crusader': '骑乘十字军（宝宝）',
  'Baby Ranger': '游侠（宝宝）', 'Baby Bishop': '大主教（宝宝）', 'Baby Cross': '十字刺客（宝宝）',
  'Baby Rune': '符文骑士（宝宝）', 'Baby Warlock': '咒术师（宝宝）', 'Baby Mechanic': '机匠（宝宝）',
  'Baby Guard': '皇家卫士（宝宝）', 'Baby Sorcerer': '妖术师（宝宝）', 'Baby Minstrel': '宫廷乐师（宝宝）',
  'Baby Wanderer': '浪迹舞者（宝宝）', 'Baby Sura': '修罗（宝宝）', 'Baby Genetic': '基因学者（宝宝）',
  'Baby Chaser': '影舞者（宝宝）', 'Baby Star Emperor': '星帝（宝宝）', 'Baby Soul Reaper': '灵魂收割者（宝宝）',
  'Baby Arch Mage': '大法师（宝宝）', 'Baby Cardinal': '红衣主教（宝宝）', 'Baby Windhawk': '风鹰（宝宝）',
  'Baby Meister': '机甲师（宝宝）', 'Baby Biolo': '生物学家（宝宝）',
  'Death Knight': '死亡骑士', 'Dark Collector': '暗黑收藏者', Munak: '腐尸',
  Lif: '丽芙', 'Lif 2': '丽芙（进化）', 'High Lif': '高阶丽芙', 'High Lif 2': '高阶丽芙（进化）',
  Amistr: '阿米斯特', 'Amistr 2': '阿米斯特（进化）', 'High Amistr': '高阶阿米斯特', 'High Amistr 2': '高阶阿米斯特（进化）',
  Filir: '菲利', 'Filir 2': '菲利（进化）', 'High Filir': '高阶菲利', 'High Filir 2': '高阶菲利（进化）',
  Vanilmirth: '巴尼尔米特', 'Vanilmirth 2': '巴尼尔米特（进化）', 'High Vanilmirth': '高阶巴尼尔米特',
  'High Vanilmirth 2': '高阶巴尼尔米特（进化）', Bayeri: '巴艾利', Dieter: '迪塔勒', Eira: '艾勒', Sera: '赛拉', Eleanor: '伊琳诺',
  'Agni [S]': '火焰精灵（小）', 'Agni [M]': '火焰精灵（中）', 'Agni [L]': '火焰精灵（大）',
  'Aqua [S]': '水灵精灵（小）', 'Aqua [M]': '水灵精灵（中）', 'Aqua [L]': '水灵精灵（大）',
  'Ventus [S]': '风灵精灵（小）', 'Ventus [M]': '风灵精灵（中）', 'Ventus [L]': '风灵精灵（大）',
  'Tera [S]': '地灵精灵（小）', 'Tera [M]': '地灵精灵（中）', 'Tera [L]': '地灵精灵（大）',
  'Mercenary Archer 1': '弓箭手佣兵 1 级', 'Mercenary Archer 2': '弓箭手佣兵 2 级',
  'Mercenary Archer 3': '弓箭手佣兵 3 级', 'Mercenary Archer 4': '弓箭手佣兵 4 级',
  'Mercenary Archer 5': '弓箭手佣兵 5 级', 'Mercenary Archer 6': '弓箭手佣兵 6 级',
  'Mercenary Archer 7': '弓箭手佣兵 7 级', 'Mercenary Archer 8': '弓箭手佣兵 8 级',
  'Mercenary Archer 9': '弓箭手佣兵 9 级', 'Mercenary Archer 10': '弓箭手佣兵 10 级',
  'Mercenary Lancer 1': '枪兵佣兵 1 级', 'Mercenary Lancer 2': '枪兵佣兵 2 级',
  'Mercenary Lancer 3': '枪兵佣兵 3 级', 'Mercenary Lancer 4': '枪兵佣兵 4 级',
  'Mercenary Lancer 5': '枪兵佣兵 5 级', 'Mercenary Lancer 6': '枪兵佣兵 6 级',
  'Mercenary Lancer 7': '枪兵佣兵 7 级', 'Mercenary Lancer 8': '枪兵佣兵 8 级',
  'Mercenary Lancer 9': '枪兵佣兵 9 级', 'Mercenary Lancer 10': '枪兵佣兵 10 级',
  'Mercenary Swordman 1': '剑士佣兵 1 级', 'Mercenary Swordman 2': '剑士佣兵 2 级',
  'Mercenary Swordman 3': '剑士佣兵 3 级', 'Mercenary Swordman 4': '剑士佣兵 4 级',
  'Mercenary Swordman 5': '剑士佣兵 5 级', 'Mercenary Swordman 6': '剑士佣兵 6 级',
  'Mercenary Swordman 7': '剑士佣兵 7 级', 'Mercenary Swordman 8': '剑士佣兵 8 级',
  'Mercenary Swordman 9': '剑士佣兵 9 级', 'Mercenary Swordman 10': '剑士佣兵 10 级',
  'Mercenary Monster': '怪物佣兵', 'Wedding Suit': '婚礼礼服', Xmas: '圣诞装', Summer: '夏日装',
};

function canonicalJobName(name) {
  if (name.startsWith('Baby ')) return canonicalJobName(name.slice(5));
  return JOB_ALIASES[name] ?? name;
}

function prefixesByTier(jobName) {
  const prefixes = [new Set(), new Set(), new Set(), new Set(), new Set()];
  for (const name of jobLineage(jobName)) {
    const entry = JOB_SKILL_PATHS[name];
    for (const prefix of entry.prefixes) prefixes[entry.tier]?.add(prefix);
  }
  return prefixes;
}

function jobLineage(jobName) {
  let name = canonicalJobName(jobName);
  const lineage = [];
  const visited = new Set();
  while (name && !visited.has(name)) {
    visited.add(name);
    const entry = JOB_SKILL_PATHS[name];
    if (!entry) break;
    lineage.push(name);
    name = entry.parent;
  }
  return lineage;
}

function skillPrefix(skill) {
  const handle = String(skill.handle ?? '');
  const separator = handle.indexOf('_');
  return separator > 0 ? handle.slice(0, separator) : '';
}

export function buildJobSkills(skills, jobs) {
  const result = {};
  for (const [jobId, jobName] of Object.entries(jobs)) {
    if (!JOB_SKILL_PATHS[canonicalJobName(jobName)]) continue;
    const tierPrefixes = prefixesByTier(jobName);
    const lineage = jobLineage(jobName);
    const groups = new Map(TIER_LABELS.map((label) => [label, []]));
    for (const skill of skills) {
      const handle = String(skill.handle ?? '');
      const noviceOnly = handle === 'NV_TRICKDEAD' && NOVICE_ONLY_SKILLS.has(jobName);
      const jobOverride = JOB_SKILL_OVERRIDES[handle];
      const tier = NOVICE_SHARED_SKILLS.has(handle)
        ? 0
        : noviceOnly
          ? 0
          : jobOverride
            ? lineage.some((name) => jobOverride.jobs.has(name)) ? jobOverride.tier : -1
            : tierPrefixes.findIndex((prefixes) => prefixes.has(skillPrefix(skill)));
      if (tier >= 0) groups.get(TIER_LABELS[tier]).push(skill.id);
    }
    const grouped = Object.fromEntries([...groups].filter(([, ids]) => ids.length > 0));
    result[jobId] = grouped;
  }
  return result;
}

export function flattenJobSkillGroups(groups) {
  return Object.fromEntries(Object.entries(groups).map(([jobId, byTier]) => [
    jobId,
    [...new Set(Object.values(byTier).flat())],
  ]));
}

export function buildJobNamesZh(jobs) {
  return Object.fromEntries(Object.entries(jobs).map(([jobId, name]) => [jobId, JOB_NAMES_ZH[name] ?? name]));
}

/**
 * 「全部技能」视图用的技能 → 职业中文名映射：
 * 按职业 ID 升序，让每个技能归于最早拥有它的职业（四转职业各自成立）；
 * NV/ALL 前缀归入「通用技能」，其余无法归类的归入「其他技能」。
 */
export function buildSkillGroups(skills, jobSkillGroups, jobs, jobsZh) {
  const labelById = jobsZh ?? buildJobNamesZh(jobs);
  const groups = {};
  const jobIds = Object.keys(jobSkillGroups).sort((a, b) => Number(a) - Number(b));
  for (const jobId of jobIds) {
    const label = labelById[jobId] ?? jobs[jobId];
    if (!label) continue;
    for (const [tier, ids] of Object.entries(jobSkillGroups[jobId])) {
      if (tier === TIER_LABELS[0]) continue;
      for (const id of ids) if (groups[id] === undefined) groups[id] = label;
    }
  }
  for (const skill of skills) {
    const prefix = skillPrefix(skill);
    if (prefix === 'NV' || prefix === 'ALL') groups[skill.id] = TIER_LABELS[0];
    else if (groups[skill.id] === undefined) groups[skill.id] = OTHER_SKILL_LABEL;
  }
  return groups;
}
