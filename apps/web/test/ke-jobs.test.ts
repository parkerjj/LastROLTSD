import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildJobsFromOptions, FALLBACK_JOBS, presetOf, type JobData } from '../src/ke-jobs';

interface SkillEntry {
  id: number;
  name?: string;
  nameZh?: string;
  handle?: string;
}
interface OptionFile {
  jobs?: Record<string, string>;
  jobs_zh?: Record<string, string>;
  skills?: SkillEntry[];
  job_skills?: Record<string, number[]>;
  job_skill_groups?: Record<string, Record<string, number[]>>;
}

// 真实数据源：与线上 /ke/options.json、/ke/skill-types.json 完全一致，避免测试用假数据自证。
const KE_DIR = resolve(process.cwd(), 'apps/web/public/ke');
const options = JSON.parse(readFileSync(resolve(KE_DIR, 'options.json'), 'utf8')) as OptionFile;
const kinds = (JSON.parse(readFileSync(resolve(KE_DIR, 'skill-types.json'), 'utf8')) as {
  skills?: Record<string, string>;
}).skills ?? {};
const built = buildJobsFromOptions(options, kinds);
const jobs: Record<string, JobData> = built?.jobs ?? {};
const list: string[] = built?.list ?? [];
const jobIds = Object.keys(options.job_skills ?? {});

const SURV_KINDS = ["tank", "healer", "ranged", "caster", "melee"];
const AUX_CATS = ["buff", "ground", "heal", "survival"];

describe('KE 职业数据构建（options.json 全职业）', () => {
  it('从真实 options.json 构建出全部带技能的职业', () => {
    expect(built).not.toBeNull();
    expect(list.length).toBeGreaterThanOrEqual(170);
    expect(list.length).toBeGreaterThanOrEqual(jobIds.length);
    for (const id of list) expect(jobs[id]).toBeDefined();
  });

  it('每个职业的分类始终落在五档生存原型与两种坐骑状态内', () => {
    const failures: string[] = [];
    for (const id of list) {
      const job = jobs[id]!;
      if (!SURV_KINDS.includes(job.surv)) failures.push(`#${id} 生存档位非法：${job.surv}`);
      if (job.mount !== false && job.mount !== "combat") failures.push(`#${id} 坐骑状态非法：${String(job.mount)}`);
      if (job.surv === "ranged" && !job.ranged) failures.push(`#${id} 远程档位但未判定为远程职业`);
      if (job.surv !== "ranged" && job.ranged && job.surv !== "healer") {
        failures.push(`#${id} 远程职业落到了 ${job.surv} 档`);
      }
      if (job.surv === "tank" && job.mount !== "combat") failures.push(`#${id} 坦克档位但未启用坐骑战斗`);
      if (job.mountSkill && job.mount !== "combat" && !job.atk.concat(job.aux.map((a) => a.n)).some((n) => /骑乘术|骑乘技能/.test(n))) {
        failures.push(`#${id} 标记了坐骑技能但没有对应技能`);
      }
      if (typeof job.name !== "string" || job.name === "") failures.push(`#${id} 职业名为空`);
    }
    expect(failures).toEqual([]);
  });

  it('技能池不重复、类别合法、数量受上限约束', () => {
    const failures: string[] = [];
    for (const id of list) {
      const job = jobs[id]!;
      if (new Set(job.atk).size !== job.atk.length) failures.push(`#${id} 攻击技能池有重复项`);
      if (job.atk.length > 12) failures.push(`#${id} 攻击技能池超过 12 条：${job.atk.length}`);
      const auxNames = job.aux.map((a) => a.n);
      if (new Set(auxNames).size !== auxNames.length) failures.push(`#${id} 辅助技能有重复项`);
      for (const aux of job.aux) {
        if (!AUX_CATS.includes(aux.c)) failures.push(`#${id} 辅助技能「${aux.n}」类别非法：${aux.c}`);
      }
      const overlap = job.atk.filter((n) => auxNames.includes(n));
      if (overlap.length > 0) failures.push(`#${id} 同一技能同时进了攻击池与辅助池：${overlap.join("、")}`);
    }
    expect(failures).toEqual([]);
  });

  it('关键职业映射到预期的技能池与生存档位', () => {
    // 真值表来自 options.json 的职业名（剑士/魔法师/弓箭手/服侍/商人/盗贼/骑士/牧师/巫师/猎人）。
    const expected: Record<string, { surv: JobData["surv"]; ranged: boolean; mount?: JobData["mount"]; mountSkill?: boolean }> = {
      "1": { surv: "melee", ranged: false },
      "2": { surv: "caster", ranged: false },
      "3": { surv: "ranged", ranged: true },
      "4": { surv: "healer", ranged: false },
      "5": { surv: "melee", ranged: false },
      "6": { surv: "melee", ranged: false },
      "7": { surv: "tank", ranged: false, mount: "combat", mountSkill: true },
      "8": { surv: "healer", ranged: false },
      "9": { surv: "caster", ranged: false },
      "11": { surv: "ranged", ranged: true },
      "4008": { surv: "tank", ranged: false, mount: "combat" },
      "4010": { surv: "caster", ranged: false },
    };
    const failures: string[] = [];
    for (const [id, want] of Object.entries(expected)) {
      const job = jobs[id];
      if (!job) {
        failures.push(`#${id} 未构建出职业数据`);
        continue;
      }
      if (job.surv !== want.surv) failures.push(`#${id} 生存档位 ${job.surv} ≠ ${want.surv}`);
      if (job.ranged !== want.ranged) failures.push(`#${id} 远程判定 ${job.ranged} ≠ ${want.ranged}`);
      if (want.mount !== undefined && job.mount !== want.mount) failures.push(`#${id} 坐骑 ${String(job.mount)} ≠ ${String(want.mount)}`);
      if (want.mountSkill !== undefined && job.mountSkill !== want.mountSkill) {
        failures.push(`#${id} 坐骑技能 ${job.mountSkill} ≠ ${want.mountSkill}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('skill-types.json 标记为被动的技能不会进入攻击技能池', () => {
    const byId = new Map<number, SkillEntry>();
    for (const skill of options.skills ?? []) byId.set(skill.id, skill);
    const passiveNames = new Set<string>();
    for (const ids of Object.values(options.job_skills ?? {})) {
      for (const id of ids) {
        const skill = byId.get(id);
        const handle = skill?.handle ?? "";
        const name = skill?.nameZh ?? skill?.name ?? "";
        if (name !== "" && handle !== "" && kinds[handle] === "passive") passiveNames.add(name);
      }
    }
    const failures: string[] = [];
    for (const id of list) {
      for (const name of jobs[id]!.atk) {
        if (passiveNames.has(name)) failures.push(`#${id} 被动技能「${name}」进了攻击池`);
      }
    }
    expect(passiveNames.size).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it('技能池规模合理：多数职业有攻击技能，部分职业带辅助技能', () => {
    const atkJobs = list.filter((id) => jobs[id]!.atk.length > 0).length;
    const auxJobs = list.filter((id) => jobs[id]!.aux.length > 0).length;
    expect(atkJobs).toBeGreaterThanOrEqual(120);
    expect(auxJobs).toBeGreaterThanOrEqual(30);
  });

  it('options.json 没有技能数据时回退为 null，由页面使用内置演示职业表', () => {
    expect(buildJobsFromOptions({ skills: [] }, kinds)).toBeNull();
    expect(buildJobsFromOptions({ skills: [], job_skills: {}, job_skill_groups: {} }, kinds)).toBeNull();
    expect(Object.keys(FALLBACK_JOBS)).toEqual(["3", "6", "7", "11"]);
    for (const job of Object.values(FALLBACK_JOBS)) expect(job.atk.length).toBeGreaterThan(0);
  });

  it('辅助技能预设对同类技能给出稳定归类', () => {
    expect(presetOf("治愈术")?.cat).toBe("heal");
    expect(presetOf("加速术")?.cat).toBe("buff");
    expect(presetOf("光耀之堂")?.cat).toBe("ground");
    expect(presetOf("隐匿")?.cat).toBe("survival");
    expect(presetOf("瞬间移动")?.cat).toBe("survival");
    expect(presetOf("二连矢")).toBeNull();
  });

  it('服侍的瞬间移动归入辅助池，不出现在攻击技能池', () => {
    const acolyte = jobs["4"];
    expect(acolyte).toBeDefined();
    expect(acolyte!.atk).not.toContain("瞬间移动");
    expect(acolyte!.aux).toContainEqual({ n: "瞬间移动", c: "survival" });
  });
});
