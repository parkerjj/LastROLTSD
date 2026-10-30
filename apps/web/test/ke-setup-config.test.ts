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
import { buildJobsFromOptions, presetOf, type JobData } from '../src/ke-jobs';
import {
  defaultDoc,
  parseConfig,
  serializeConfig,
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

/** 按职业生成一份最小可用的 config.txt 文档：攻击技能 + 自身辅助技能（技能名与条件取自职业数据）。 */
function configFor(job: JobData): ConfigDoc {
  const doc = defaultDoc();
  const blocks: Record<string, BlockValue[]> = {};
  if (job.atk.length > 0) {
    blocks.attackSkillSlot = job.atk.map((name) => ({ selector: name, fields: { lvl: "10" }, conditions: {} }));
  }
  const selfBlocks: BlockValue[] = [];
  for (const aux of job.aux) {
    const conditions: Record<string, string> = {};
    for (const cond of presetOf(aux.n)?.scopes.self?.conds ?? []) {
      // %NAME% 由页面按角色状态表解析成真实状态名，这里不猜状态，避免写出客户端不认识的名称。
      if (cond.v !== "%NAME%") conditions[cond.k] = cond.v;
    }
    selfBlocks.push({ selector: aux.n, fields: { lvl: "10" }, conditions });
  }
  if (selfBlocks.length > 0) blocks.useSelf_skill = selfBlocks;
  doc.blocks = blocks;
  return doc;
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
      const selfSelectors = (parsed.blocks.useSelf_skill ?? []).map((block) => block.selector);
      if (atkSelectors.join("|") !== job.atk.join("|")) {
        failures.push(`#${id} 攻击技能回读不一致：${atkSelectors.join("、")} ≠ ${job.atk.join("、")}`);
      }
      if (selfSelectors.join("|") !== job.aux.map((a) => a.n).join("|")) {
        failures.push(`#${id} 辅助技能回读不一致：${selfSelectors.join("、")} ≠ ${job.aux.map((a) => a.n).join("、")}`);
      }
      for (const name of [...atkSelectors, ...selfSelectors]) {
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
    const doc = configFor({ name: "未知职业", ranged: false, surv: "melee", mount: false, mountSkill: false, atk: [], aux: [] });
    expect(doc.blocks).toEqual({});
    expect(validateConfigDoc(doc)).toEqual([]);
    expect(serializeConfig(doc)).not.toBe("");
  });
});
