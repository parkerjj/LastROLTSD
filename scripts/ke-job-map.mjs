// 职业→技能映射（job_skills），由技能 handle 前缀推导。
// 目标服务器为「进阶二转」（LastRO 2x），覆盖 1 转(0-27) + 进阶二转(161-181)。
// 这是编辑器的「按职业默认过滤」，近似映射；跨职业/卡片装备技能用「全部技能」开关补足。

// handle 前缀 → 职业线（首转职业 ID）。同一职业线的技能对整条线的职业都可用。
const PREFIX_LINE = {
  NV: 0,
  SM: 1, KN: 1, CR: 1, PA: 1, LK: 1, RK: 1,
  MG: 2, WZ: 2, SG: 2, WL: 2,
  AR: 3, HT: 3, BA: 3, DC: 3, RA: 3,
  AC: 4, PR: 4, MO: 4, AB: 4,
  MC: 5, BS: 5, AL: 5, ME: 5,
  TF: 6, AS: 6, RG: 6, GC: 6,
  GS: 24,
  NJ: 25,
};

// 职业 ID → 职业线。覆盖 1 转 + 进阶二转（LastRO 2x）。
const JOB_LINE = {
  0: 0, 23: 0, 161: 0,
  1: 1, 7: 1, 13: 1, 14: 1, 21: 1, 162: 1, 168: 1, 174: 1, 175: 1,
  2: 2, 9: 2, 16: 2, 163: 2, 170: 2, 177: 2,
  3: 3, 11: 3, 19: 3, 20: 3, 164: 3, 172: 3, 180: 3, 181: 3,
  4: 4, 8: 4, 15: 4, 165: 4, 169: 4, 176: 4,
  5: 5, 10: 5, 18: 5, 166: 5, 171: 5, 179: 5,
  6: 6, 12: 6, 17: 6, 167: 6, 173: 6, 178: 6,
  24: 24,
  25: 25,
};

export function buildJobSkills(skills) {
  const byLine = new Map();
  for (const skill of skills) {
    const prefix = String(skill.handle ?? '').split('_')[0];
    const line = PREFIX_LINE[prefix];
    if (line === undefined) continue;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(skill.id);
  }
  const jobSkills = {};
  for (const [jobId, line] of Object.entries(JOB_LINE)) {
    jobSkills[jobId] = byLine.get(line) ?? [];
  }
  return jobSkills;
}
