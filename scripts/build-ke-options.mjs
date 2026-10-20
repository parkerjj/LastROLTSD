// 从 KoreEngine 仓库的静态数据生成 LTSD 配置编辑器所需的选项资产。
// 用法：node scripts/build-ke-options.mjs [KE数据目录]
//   默认 KE 数据目录为 /home/parker/Development/RO/KoreEngine/data/static
// 输出：apps/web/public/ke/options.json（提交到仓库，作为快照；KE 数据更新后重跑即可）。
//
// job_skills.json（职业→技能映射）由 KE 侧生成（build-skill-table 输出）；缺省时编辑器不按职业默认过滤技能。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildJobNamesZh, buildJobSkills, buildSkillGroups, flattenJobSkillGroups } from './ke-job-map.mjs';
import { TIMEOUT_HELP } from './ke-timeout-help.mjs';

const source = process.argv[2] ?? '/home/parker/Development/RO/KoreEngine/data/static';
const outDir = resolve(process.cwd(), 'apps/web/public/ke');
const outFile = resolve(outDir, 'options.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sortedById(entries) {
  return entries.sort((a, b) => a.id - b.id);
}

function build() {
  const jobs = readJson(resolve(source, 'jobs.json')).jobs;
  const skillsSrc = readJson(resolve(source, 'skills.json')).skills;
  const statusesSrc = readJson(resolve(source, 'statuses.json')).statuses;
  const names = readJson(resolve(source, 'names.json'));
  const monstersSrc = names.monsters;
  const itemsSrc = names.items;

  const skills = sortedById(Object.entries(skillsSrc).map(([id, skill]) => ({
    id: Number(id),
    handle: skill.handle,
    name: skill.name,                       // 英文名（config.txt selector 用）
    nameZh: skill.nameZh || skill.name,     // 中文名（编辑器 UI 展示用）
  })));

  const statuses = sortedById(Object.entries(statusesSrc).map(([id, status]) => ({
    id: Number(id),
    handle: status.handle,
    name: status.name,
    nameZh: (Array.isArray(status.nameZh) ? status.nameZh[0] : status.nameZh) || status.name,
  })));

  const monsters = sortedById(Object.entries(monstersSrc).map(([id, name]) => ({
    id: Number(id),
    name,
  })));

  const items = sortedById(Object.entries(itemsSrc).map(([id, name]) => ({
    id: Number(id),
    name,
  })));

  const jobSkillGroups = buildJobSkills(skills, jobs);
  const jobSkills = flattenJobSkillGroups(jobSkillGroups);
  const jobsZh = buildJobNamesZh(jobs);
  // 「全部技能」视图：技能 → 所属职业中文名，供编辑器按职业分组展示。
  const skillGroups = buildSkillGroups(skills, jobSkillGroups, jobs, jobsZh);
  console.log(`已生成职业技能分组（${Object.keys(jobSkillGroups).length} 个职业）和中文职业名（${Object.keys(jobsZh).length} 个职业）。`);

  // 地图名：从 KE 的 maps/portals.json 提取全部出现的源/目标地图代码，供地图选择器做建议。
  const maps = [];
  try {
    const mapSet = new Set();
    for (const portal of readJson(resolve(source, '../maps/portals.json'))) {
      if (typeof portal.sourceMap === 'string') mapSet.add(portal.sourceMap);
      if (typeof portal.destinationMap === 'string') mapSet.add(portal.destinationMap);
    }
    for (const code of [...mapSet].sort()) maps.push({ code });
  } catch {
    console.warn('未找到 portals.json，地图选择器将无建议。');
  }

  // 超时名：从 KE 的 control/timeouts.txt 提取 key + 默认秒数。
  const timeouts = [];
  try {
    for (const line of readFileSync(resolve(source, '../control/timeouts.txt'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const spaceIndex = trimmed.indexOf(' ');
      if (spaceIndex <= 0) continue;
      const key = trimmed.slice(0, spaceIndex);
      const value = trimmed.slice(spaceIndex + 1).trim();
      if (/^\d/.test(value)) {
        const help = TIMEOUT_HELP[key] ?? { desc: '', range: '' };
        timeouts.push({ key, value, desc: help.desc ?? '', range: help.range ?? '' });
      }
    }
  } catch {
    console.warn('未找到 timeouts.txt，超时编辑器将为空。');
  }

  const options = {
    schemaVersion: 1,
    jobs,
    jobs_zh: jobsZh,
    skills,
    statuses,
    monsters,
    items,
    maps,
    timeouts,
    job_skills: jobSkills,
    job_skill_groups: jobSkillGroups,
    skill_groups: skillGroups,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(options));
  console.log(`已写入 ${outFile}（jobs=${Object.keys(jobs).length}, skills=${skills.length}, statuses=${statuses.length}, monsters=${monsters.length}, items=${items.length}, timeouts=${timeouts.length}）`);
}

build();
