import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auxCatOfName, buildJobsFromOptions, clampJobForNid, isAoeSkill, isUtilitySkill, JOB_SERIES, listJobSeries, FALLBACK_JOBS, presetOf, SKILL_SPECIALS, type JobData } from '../src/ke-jobs';
import { SKILL_MAX_LVL, maxLvlOfHandle } from '../src/ke-skill-max';

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
      if (job.atk.some((n) => /骑乘术|骑乘技能/.test(n))) failures.push(`#${id} 骑乘术不应出现在攻击池`);
      if (typeof job.name !== "string" || job.name === "") failures.push(`#${id} 职业名为空`);
    }
    expect(failures).toEqual([]);
  });

  it('技能池不重复、类别合法、数量受上限约束', () => {
    const failures: string[] = [];
    for (const id of list) {
      const job = jobs[id]!;
      if (new Set(job.atk).size !== job.atk.length) failures.push(`#${id} 攻击技能池有重复项`);
      const auxNames = job.aux.map((a) => a.n);
      if (new Set(auxNames).size !== auxNames.length) failures.push(`#${id} 辅助技能有重复项`);
      for (const aux of job.aux) {
        if (!AUX_CATS.includes(aux.c)) failures.push(`#${id} 辅助技能「${aux.n}」类别非法：${aux.c}`);
      }
      // 牧师系治愈术例外：既是治疗技（辅助池），也打不死系（攻击池）。
      const overlap = job.atk.filter((n) => auxNames.includes(n) && n !== "治愈术");
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
      "7": { surv: "tank", ranged: false, mount: "combat", mountSkill: false },
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
    // 加速术等 buff 走显式归类表，不再依赖宽泛正则。
    expect(auxCatOfName("加速术")).toBe("buff");
    expect(auxCatOfName("能量外套")).toBe("buff");
    expect(auxCatOfName("暗之障壁")).toBe("ground");
    expect(presetOf("光耀之堂")?.cat).toBe("ground");
    expect(presetOf("隐匿")?.cat).toBe("survival");
    expect(presetOf("瞬间移动")?.cat).toBe("survival");
    expect(auxCatOfName("二连矢")).toBeNull();
  });

  it('蓄气/狂蓄气归自身增益：气弹不足时补，冷却 1 秒而不是 10 秒', () => {
    for (const name of ["蓄气", "狂蓄气"]) {
      const preset = presetOf(name);
      expect(preset?.cat).toBe("buff");
      expect(preset?.scopes.self?.conds).toEqual([
        { k: "spirit", v: "< 5" },
        { k: "timeout", v: "1" },
      ]);
      expect(preset?.scopes.other?.on).toBe(false);
    }
  });

  it('所有技能满级来自权威表（rAthena skill_db），不是臆造的 10 级', () => {
    const byName = new Map<string, SkillEntry>();
    for (const skill of options.skills ?? []) {
      if (skill.nameZh) byName.set(skill.nameZh, skill);
    }
    const max = (zh: string): number | undefined => maxLvlOfHandle(byName.get(zh)?.handle);
    // 用户点名的两个牧师技能：满级 5
    expect(max("圣母之颂歌")).toBe(5);
    expect(max("圣母之祈福")).toBe(5);
    // 狂蓄气满级 1，蓄气 5
    expect(max("狂蓄气")).toBe(1);
    expect(max("蓄气")).toBe(5);
    expect(maxLvlOfHandle("NO_SUCH_SKILL")).toBeUndefined();
    // 表内等级必须落在 rAthena 实际出现的 1..10 范围内
    for (const [handle, lv] of Object.entries(SKILL_MAX_LVL)) {
      expect(lv, handle).toBeGreaterThanOrEqual(1);
      expect(lv, handle).toBeLessThanOrEqual(10);
    }
  });

  it('服侍的瞬间移动归入辅助池，不出现在攻击技能池', () => {
    const acolyte = jobs["4"];
    expect(acolyte).toBeDefined();
    expect(acolyte!.atk).not.toContain("瞬间移动");
    expect(acolyte!.aux).toContainEqual({ n: "瞬间移动", c: "survival" });
  });
});

describe('职业系列：按服务器档位动态截断', () => {
  it('龙骑士按 nid 截断到该服最高职业', () => {
    // nid=3 三转服 → 符文骑士；nid=5 进阶二转服 → 骑士领主；nid=6 App 服不能转生 → 骑士。
    expect(clampJobForNid(4252, 3).jobId).toBe("4054");
    expect(clampJobForNid(4252, 5).jobId).toBe("168");
    expect(clampJobForNid(4252, 6).jobId).toBe("7");
    expect(clampJobForNid(4054, 5).jobId).toBe("168");
    expect(clampJobForNid(168, 6).jobId).toBe("7");
    // 同名档位的别名 ID 归一到规范 ID。
    expect(clampJobForNid(174, 5).jobId).toBe("168");
    expect(clampJobForNid(174, 6).jobId).toBe("7");
    // 未知服务器不截断；二转非转生职业在所有服都可用。
    expect(clampJobForNid(4252, 7).jobId).toBe("4252");
    expect(clampJobForNid(11, 6).jobId).toBe("11");
  });

  it('demo 职业列表只列职业线，每个系列按 nid 取最高可用职业', () => {
    const n3 = listJobSeries(3);
    expect(n3).toHaveLength(JOB_SERIES.length);
    expect(n3.find((opt) => opt.key === "knight")?.jobId).toBe("4054");
    expect(listJobSeries(5).find((opt) => opt.key === "knight")?.jobId).toBe("168");
    expect(listJobSeries(6).find((opt) => opt.key === "knight")?.jobId).toBe("7");
    expect(listJobSeries(6).find((opt) => opt.key === "novice")?.jobId).toBe("0");
    for (const opt of n3) expect(jobs[opt.jobId]).toBeDefined();
  });

  it('技能池随截断后的职业变化：三转有完整技能，二转不含三转技能', () => {
    expect(jobs["4054"]!.atk.length).toBeGreaterThan(12);
    expect(jobs["4054"]!.atk).toContain("致命爆裂");
    expect(jobs["7"]!.atk).not.toContain("螺旋击刺");
    expect(jobs["168"]!.atk).toContain("螺旋击刺");
  });

  it('平A默认值：施法职业关闭，物理/远程/治疗职业开启', () => {
    expect(jobs["2"]!.basic).toBe(false); // 魔法师
    expect(jobs["9"]!.basic).toBe(false); // 巫师
    expect(jobs["170"]!.basic).toBe(false); // 高阶巫师
    expect(jobs["7"]!.basic).toBe(true); // 骑士
    expect(jobs["11"]!.basic).toBe(true); // 猎人
    expect(jobs["4"]!.basic).toBe(true); // 服侍
  });
});

describe('技能归类完整性', () => {
  it('能量外套、魔力增幅归自身 buff，不进攻击技能池', () => {
    for (const [id, names] of [["9", ["能量外套"]], ["170", ["能量外套", "魔力增幅"]], ["4255", ["魔力增幅"]]] as const) {
      const job = jobs[id];
      expect(job, `#${id}`).toBeDefined();
      for (const name of names) {
        expect(job!.aux.map((a) => a.n), `#${id} ${name}`).toContain(name);
        expect(job!.atk, `#${id} ${name}`).not.toContain(name);
      }
    }
  });

  it('特殊技能有精细化施放规则（不套用类别通用条件）', () => {
    // 挑衅是对怪使用：每只怪 1 次。
    expect(SKILL_SPECIALS["挑衅"]?.atkFields?.maxUses).toBe("1");
    // 天使之怒：目标身上没有标记才放，同目标 3 秒。
    expect(SKILL_SPECIALS["天使之怒"]?.atkConds).toEqual({
      target_whenStatusInactive: "EFST_LEXAETERNA",
      target_timeout: "3",
    });
    // 弹指神通：需要气弹，最远 9 格。
    expect(SKILL_SPECIALS["弹指神通"]?.atkFields?.maxDist).toBe("9");
    expect(SKILL_SPECIALS["弹指神通"]?.atkConds?.spirit).toBe("> 0");
    // 解毒/缓毒术：中毒时才对自己用，而不是 HP < 70%。
    for (const name of ["解毒", "缓毒术"]) {
      expect(SKILL_SPECIALS[name]?.selfConds).toEqual([
        { k: "whenStatusActive", v: "EFST_HEALTHSTATE_POISON" },
        { k: "timeout", v: "1" },
      ]);
    }
    // 痊愈术只解沉默/混乱/黑暗，拆成三个自身块。
    expect(SKILL_SPECIALS["痊愈术"]!.selfStatusConds!.map((conds) => conds[0]!.v).sort()).toEqual([
      "EFST_HEALTHSTATE_BLIND",
      "EFST_HEALTHSTATE_CONFUSION",
      "EFST_HEALTHSTATE_SILENCE",
    ]);
    // 复活术只对死亡队友释放。
    expect(SKILL_SPECIALS["复活术"]).toMatchObject({ partyOnly: true });
    expect(SKILL_SPECIALS["复活术"]?.partyConds).toContainEqual({ k: "target_dead", v: "1" });
    // 治愈术与七个团队增益同时给自己和队友。
    expect(SKILL_SPECIALS["治愈术"]?.partyConds).toContainEqual({ k: "target_hp", v: "< 70%" });
    for (const name of ["加速术", "天使之赐福", "神威祈福", "牺牲祈福", "霸邪之阵", "圣母之颂歌", "幸运之颂歌"]) {
      expect(SKILL_SPECIALS[name]?.partyConds, name).toContainEqual({
        k: "target_whenStatusInactive",
        v: "%NAME%",
      });
    }
    // 所有队友技能都要有 target_timeout 30：同一队友 30 秒内不重复施放。
    for (const name of ["复活术", "治愈术", "加速术", "天使之赐福", "神威祈福", "牺牲祈福", "霸邪之阵", "圣母之颂歌", "幸运之颂歌"]) {
      expect(SKILL_SPECIALS[name]?.partyConds, name).toContainEqual({ k: "target_timeout", v: "30" });
    }
  });

  it('挑衅/天使之怒/弹指神通进了对应职业的攻击池，治愈术在牧师攻击池', () => {
    // 挑衅不是自身 buff，而是对怪技能。
    for (const id of ["7", "168", "4054"]) expect(jobs[id]!.atk, `#${id}`).toContain("挑衅");
    // 天使之怒是给怪挂增伤标记的攻击技。
    expect(jobs["8"]!.atk).toContain("天使之怒");
    // 弹指神通是武僧的远程气功。
    expect(jobs["15"]!.atk).toContain("弹指神通");
    // 治愈术对牧师系同时进攻击池，武僧系只当治疗技。
    expect(jobs["8"]!.atk).toContain("治愈术");
    expect(jobs["15"]!.atk).not.toContain("治愈术");
    expect(jobs["15"]!.aux.map((a) => a.n)).toContain("治愈术");
  });

  it('同名技能按职业技能表取玩家版本：挑衅用 6 而不是佣兵 8232', () => {
    const provokes = (options.skills ?? [])
      .filter((skill) => (skill.nameZh ?? skill.name) === "挑衅")
      .map((skill) => skill.id);
    expect(provokes).toEqual(expect.arrayContaining([6, 8232]));
    expect(options.job_skills?.["7"]).toContain(6);
    // 8232 是 MER_PROVOKE（佣兵技能），不在任何玩家职业的技能表里。
    for (const ids of Object.values(options.job_skills ?? {})) expect(ids).not.toContain(8232);
  });

  it('猎人系列技能随职业阶段变化：风之步只在高阶职业出现', () => {
    const aux = (id: string): string[] => jobs[id]!.aux.map((a) => a.n);
    // 二转猎人（App 服上限）只有心神凝聚。
    expect(aux("11")).toContain("心神凝聚");
    expect(aux("11")).not.toContain("风之步");
    // 进阶二转神射手、三转游侠、四转风鹰都会显示风之步。
    expect(aux("172")).toContain("风之步");
    expect(aux("4012")).toContain("风之步");
    expect(aux("4056")).toContain("风之步");
    expect(aux("4257")).toContain("风之步");
  });

  it('AOE 技能标记为解围技，锐利射击排除', () => {
    expect(isAoeSkill("怒爆")).toBe(true);
    expect(isAoeSkill("箭雨")).toBe(true);
    expect(isAoeSkill("重力原野")).toBe(true);
    expect(isAoeSkill("锐利射击")).toBe(false);
    expect(isAoeSkill("二连矢")).toBe(false);
  });

  it('制作/商店/修理/陷阱处理等非战斗技能不进入攻击池', () => {
    expect(isUtilitySkill("物品鉴定")).toBe(true);
    expect(isUtilitySkill("陷阱探查")).toBe(true);
    expect(isUtilitySkill("配药")).toBe(true);
    expect(isUtilitySkill("偷窃")).toBe(true);
    expect(isUtilitySkill("二连矢")).toBe(false);
    expect(jobs["4058"]!.atk).not.toContain("物品鉴定");
    expect(jobs["4058"]!.atk).not.toContain("武器修理");
    expect(jobs["4056"]!.atk).not.toContain("陷阱探查");
    expect(jobs["4071"]!.atk).not.toContain("配药");
    expect(jobs["4059"]!.atk).not.toContain("偷窃");
    // 组合名的位移技能也要归入保命类。
    expect(auxCatOfName("大步前进、前侧滑行")).toBe("survival");
  });

  it('三转/四转的自身 buff 与地面类技能归入辅助池', () => {
    // 烈火战车（Full Throttle）是自身增益，不是攻击技，几乎每个三转职业都有。
    expect(jobs["4054"]!.aux).toContainEqual({ n: "烈火战车", c: "buff" });
    expect(jobs["4054"]!.atk).not.toContain("烈火战车");
    expect(jobs["4072"]!.aux).toContainEqual({ n: "霸王魂", c: "buff" });
    expect(jobs["4072"]!.atk).not.toContain("霸王魂");
    // 泥沼地 / 深渊沼地是地面减益。
    for (const name of ["泥沼地", "深渊沼地"]) {
      expect(jobs["4055"]!.aux.map((a) => a.n)).toContain(name);
      expect(auxCatOfName(name)).toBe("ground");
      expect(jobs["4055"]!.atk).not.toContain(name);
    }
    // 咒术师的自身增益：能量外套 / 魔力增幅 / 终极念力。
    for (const name of ["能量外套", "魔力增幅", "终极念力"]) {
      expect(jobs["4055"]!.atk).not.toContain(name);
      expect(jobs["4055"]!.aux.map((a) => a.n)).toContain(name);
    }
  });

  it('攻击技不会被语义兜底误判成辅助（破坏怒吼 / 绝对贯穿）', () => {
    for (const name of ["破坏怒吼", "绝对贯穿"]) {
      expect(auxCatOfName(name)).toBeNull();
      expect(jobs["4215"]!.atk).toContain(name);
    }
  });

  it('无伤害的限制/封锁类技能不进攻击池', () => {
    for (const name of ["白色监狱", "石化诅咒", "咖般塔音", "冰刃之墙", "真剑百破道", "紧密的约束"]) {
      expect(isUtilitySkill(name), name).toBe(true);
    }
    for (const name of ["白色监狱", "石化诅咒", "咖般塔音", "冰刃之墙"]) {
      expect(jobs["4055"]!.atk, name).not.toContain(name);
    }
    expect(jobs["4070"]!.atk).not.toContain("真剑百破道");
    expect(jobs["4072"]!.atk).not.toContain("紧密的约束");
  });

  it('内部子技能与 Hocus Pocus 随机效果不是玩家能选的攻击技', () => {
    for (const name of ["Startmark", "Endmark", "Chainlightning Atk", "Summon Atk Fire", "Tetravortex Fire", "GRAVITY"]) {
      expect(isUtilitySkill(name), name).toBe(true);
    }
    expect(jobs["4055"]!.atk).not.toContain("Startmark");
    expect(jobs["4055"]!.atk).not.toContain("Summon Atk Fire");
    // 野蛮凶砍（铁匠/机匠）是开关式技能，不进攻击池。
    expect(jobs["171"]!.atk).not.toContain("野蛮凶砍");
    expect(jobs["4058"]!.atk).not.toContain("野蛮凶砍");
  });

  it('炼金术士不是施法职业，平A默认开启', () => {
    // 曾经的 caster 正则含「术士」子串，会把炼金术士误判成法系。
    expect(jobs["179"]!.surv).not.toBe("caster");
    expect(jobs["179"]!.basic).toBe(true);
    expect(jobs["4071"]!.basic).toBe(true);
    // 真正的法系仍然关闭平A。
    expect(jobs["4055"]!.basic).toBe(false);
  });
});
