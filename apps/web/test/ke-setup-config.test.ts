import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_SCHEMAS,
  TIMEOUT_DEFAULT_OVERRIDES,
  defaultControlDoc,
  ensureAllFallback,
  serializeControl,
  validateControlDoc,
  type ControlDoc,
} from '../src/ke-controls';
import { buildJobsFromOptions, presetOf, SKILL_SPECIALS, type JobData } from '../src/ke-jobs';
import { maxLvlOfHandle } from '../src/ke-skill-max';
import {
  defaultDoc,
  parseConfig,
  serializeConfig,
  stripConfigComments,
  validateConfigDoc,
  type BlockValue,
  type ConfigDoc,
} from '../src/ke-schema';

interface SkillEntry {
  id: number;
  name?: string;
  nameZh?: string;
  handle?: string;
}

const KE_DIR = resolve(process.cwd(), 'apps/web/public/ke');
const options = JSON.parse(readFileSync(resolve(KE_DIR, 'options.json'), 'utf8')) as {
  jobs?: Record<string, string>;
  jobs_zh?: Record<string, string>;
  skills?: SkillEntry[];
  job_skills?: Record<string, number[]>;
  job_skill_groups?: Record<string, Record<string, number[]>>;
};
const kinds = (JSON.parse(readFileSync(resolve(KE_DIR, 'skill-types.json'), 'utf8')) as {
  skills?: Record<string, string>;
}).skills ?? {};
const built = buildJobsFromOptions(options, kinds);
const jobs = built?.jobs ?? {};
const list = built?.list ?? [];
const skillNames = new Set(
  (options.skills ?? []).flatMap((skill) =>
    [skill.nameZh, skill.name, skill.handle].filter((name): name is string => typeof name === "string" && name !== ""),
  ),
);
/** 技能名 → 权威满级（与页面一致；表里查不到的技能沿用 10）。 */
const handleByName = new Map<string, string>();
for (const skill of options.skills ?? []) {
  for (const name of [skill.nameZh, skill.name, skill.handle]) {
    if (typeof name === "string" && name !== "") handleByName.set(name, skill.handle ?? "");
  }
}
const lvlOf = (name: string): string => String(maxLvlOfHandle(handleByName.get(name)) ?? 10);

/** 按职业生成一份最小可用的 config.txt 文档：攻击技能 + 自身辅助技能（技能名与条件取自职业数据）。 */
function configFor(job: JobData): ConfigDoc {
  const doc = defaultDoc();
  const blocks: Record<string, BlockValue[]> = {};
  if (job.atk.length > 0) {
    blocks.attackSkillSlot = job.atk.map((name) => {
      const special = SKILL_SPECIALS[name];
      return {
        selector: name,
        fields: { lvl: lvlOf(name), ...(special?.atkFields ?? {}) },
        conditions: { ...(special?.atkConds ?? {}) },
      };
    });
  }
  const selfBlocks: BlockValue[] = [];
  const partyBlocks: BlockValue[] = [];
  for (const aux of job.aux) {
    const special = SKILL_SPECIALS[aux.n];
    const fields = { lvl: lvlOf(aux.n) };
    if (!special?.partyOnly) {
      if (special?.selfStatusConds?.length) {
        // 痊愈术按可解除状态拆成多块（KE 条件之间是「且」）。
        for (const conds of special.selfStatusConds) {
          selfBlocks.push({ selector: aux.n, fields, conditions: condsToRecord(conds) });
        }
      } else if (special?.selfConds) {
        selfBlocks.push({ selector: aux.n, fields, conditions: condsToRecord(special.selfConds) });
      } else {
        const conditions: Record<string, string> = {};
        for (const cond of presetOf(aux.n)?.scopes.self?.conds ?? []) {
          // %NAME% 由页面按角色状态表解析成真实状态名，这里不猜状态，避免写出客户端不认识的名称。
          if (cond.v !== "%NAME%") conditions[cond.k] = cond.v;
        }
        selfBlocks.push({ selector: aux.n, fields, conditions });
      }
    }
    // %NAME% 需要角色状态表，测试里跳过这类队友块；其余特殊队友条件照常生成。
    const partyConds = special?.partyConds?.filter((cond) => cond.v !== "%NAME%") ?? [];
    if (partyConds.length > 0) {
      partyBlocks.push({ selector: aux.n, fields, conditions: condsToRecord(partyConds) });
    }
  }
  if (selfBlocks.length > 0) blocks.useSelf_skill = selfBlocks;
  if (partyBlocks.length > 0) blocks.partySkill = partyBlocks;
  doc.blocks = blocks;
  return doc;
}

function condsToRecord(conds: { k: string; v: string }[]): Record<string, string> {
  const conditions: Record<string, string> = {};
  for (const cond of conds) conditions[cond.k] = cond.v;
  return conditions;
}

/** 五份文件的 control 部分：与页面一致，默认预设行 + 兜底行，timeouts 用全局默认值补齐。 */
function controlDoc(): ControlDoc {
  const doc = defaultControlDoc();
  ensureAllFallback(doc);
  doc["timeouts.txt"] = Object.entries(TIMEOUT_DEFAULT_OVERRIDES).map(([key, value]) => ({
    name: key,
    values: { value },
  }));
  return doc;
}

function controlTexts(doc: ControlDoc): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const schema of CONTROL_SCHEMAS) {
    texts[schema.file] = serializeControl(schema, doc[schema.file] ?? []).trim();
  }
  return texts;
}

describe('KE 按职业生成的配置合法性（无需游戏账号）', () => {
  it('默认配置：卡住瞬移开启，坐下 SP 默认关闭', () => {
    const doc = defaultDoc();
    expect(doc.scalars.teleportAuto_unstuck).toBe('1');
    expect(doc.scalars.sitAuto_sp_lower).toBe('0');
    expect(doc.scalars.sitAuto_sp_upper).toBe('0');
  });

  it('每个职业生成的 config.txt 都能通过保存前校验', () => {
    const failures: string[] = [];
    for (const id of list) {
      const job = jobs[id]!;
      const errors = validateConfigDoc(configFor(job));
      if (errors.length > 0) failures.push(`#${id} ${job.name}：${errors.join(" / ")}`);
    }
    expect(failures).toEqual([]);
  });

  it('序列化后技能选择器与职业技能池完全一致，且技能名都在 options.json 里', () => {
    const failures: string[] = [];
    for (const id of list) {
      const job = jobs[id]!;
      const text = serializeConfig(configFor(job));
      const parsed = parseConfig(text);
      const atkSelectors = (parsed.blocks.attackSkillSlot ?? []).map((block) => block.selector);
      // 痊愈术会拆成多个自身块，比较时按去重后的技能名。
      const selfSelectors = Array.from(new Set((parsed.blocks.useSelf_skill ?? []).map((block) => block.selector)));
      const partySelectors = Array.from(new Set((parsed.blocks.partySkill ?? []).map((block) => block.selector)));
      if (atkSelectors.join("|") !== job.atk.join("|")) {
        failures.push(`#${id} 攻击技能回读不一致：${atkSelectors.join("、")} ≠ ${job.atk.join("、")}`);
      }
      // 复活术只生成 partySkill，不生成自身块。
      const wantSelf = job.aux.filter((a) => !SKILL_SPECIALS[a.n]?.partyOnly).map((a) => a.n);
      if (selfSelectors.join("|") !== wantSelf.join("|")) {
        failures.push(`#${id} 辅助技能回读不一致：${selfSelectors.join("、")} ≠ ${wantSelf.join("、")}`);
      }
      const wantParty = job.aux.filter((a) => SKILL_SPECIALS[a.n]?.partyConds?.some((c) => c.v !== "%NAME%")).map((a) => a.n);
      if (partySelectors.join("|") !== wantParty.join("|")) {
        failures.push(`#${id} 队友技能回读不一致：${partySelectors.join("、")} ≠ ${wantParty.join("、")}`);
      }
      for (const name of [...atkSelectors, ...selfSelectors, ...partySelectors]) {
        if (!skillNames.has(name)) failures.push(`#${id} 技能「${name}」不在 options.json 技能表里`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('五份文件齐全：config + 四份 control 都能序列化并通过校验', () => {
    const controls = controlDoc();
    expect(validateControlDoc(controls)).toEqual([]);
    const texts = controlTexts(controls);
    const files = Object.keys(texts).sort();
    expect(files).toEqual(["items_control.txt", "mon_control.txt", "pickupitems.txt", "timeouts.txt"]);
    for (const file of files) expect(texts[file]).not.toBe("");

    const missing: string[] = [];
    for (const id of list) {
      const configText = serializeConfig(configFor(jobs[id]!)).trim();
      if (configText === "") missing.push(`#${id} 的 config.txt 为空`);
      for (const file of files) if (texts[file] === "") missing.push(`#${id} 缺少 ${file}`);
    }
    expect(missing).toEqual([]);
  });

  it('timeouts.txt 写入全量全局默认值，不因向导不编辑而缺项', () => {
    const texts = controlTexts(controlDoc());
    const lines = (texts["timeouts.txt"] ?? "").split("\n").filter((line) => line !== "");
    const keys = Object.keys(TIMEOUT_DEFAULT_OVERRIDES);
    expect(keys.length).toBeGreaterThanOrEqual(15);
    expect(lines).toHaveLength(keys.length);
    for (const key of keys) expect(lines.some((line) => line.startsWith(`${key} `))).toBe(true);
  });

  it('职业数据缺失时仍能生成一份可保存的空白配置', () => {
    const doc = configFor({ name: "未知职业", ranged: false, surv: "melee", mount: false, mountSkill: false, basic: false, atk: [], aux: [] });
    expect(doc.blocks).toEqual({});
    expect(validateConfigDoc(doc)).toEqual([]);
    expect(serializeConfig(doc)).not.toBe("");
  });

  it('序列化结果不含注释行；保存前的 stripConfigComments 会删掉整行 #', () => {
    const text = serializeConfig(configFor(jobs["1"]!));
    for (const line of text.split("\n")) {
      expect(line.trim().startsWith("#")).toBe(false);
    }
    // 模板/旧配置里可能有说明性注释：保存前统一删除，避免被 KE 当成配置行。
    const commented = "# 自动攻击技能\nuseSelf_skill 霸体 {\n\tlvl 1\n}\n# 冷却\n";
    expect(stripConfigComments(commented)).toBe("useSelf_skill 霸体 {\n\tlvl 1\n}\n");
    // 没有注释时保持原样（只规范结尾换行）。
    expect(stripConfigComments("attackSkillSlot 二连矢 {\n}\n")).toBe("attackSkillSlot 二连矢 {\n}\n");
  });

  it('未知条件键在保存前报错，不会被静默忽略', () => {
    // whenNotMounted 是旧教程里的臆造条件，KE 并不支持，必须拦下来。
    const doc = defaultDoc();
    doc.blocks = {
      attackSkillSlot: [{ selector: "二连矢", fields: { lvl: "1" }, conditions: { whenNotMounted: "1" } }],
    };
    const errors = validateConfigDoc(doc);
    expect(errors.some((e) => e.includes("whenNotMounted"))).toBe(true);
  });
});
