import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountKePage } from "../src/ke-page";

const MALICIOUS_NAME = '<img src=x onerror="window.__ke_xss = 1">';
const MALICIOUS_MAP = '</option><svg onload="window.__ke_xss = 1">';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 105 个「其他技能」：凑满下拉上限，用于验证截断提示。
const PADDING_SKILLS = Array.from({ length: 105 }, (_, index) => ({
  id: 3000 + index,
  handle: `NPC_TEST${index}`,
  name: `Test${index}`,
  nameZh: `测试技能${index}`,
}));

const PROFILE_OPTIONS = {
  jobs: { '176': 'Champion' },
  jobs_zh: { '176': '武术宗师' },
  skills: [
    { id: 1, handle: 'NV_BASIC', name: 'Basic', nameZh: '基本技能' },
    { id: 29, handle: 'AL_INCAGI', name: 'Incagi', nameZh: '加速术' },
    { id: 40, handle: 'MO_PALMSTRIKE', name: 'Palmstrike', nameZh: '伏虎拳' },
    { id: 41, handle: 'CH_TIGERFIST', name: 'Tigerfist', nameZh: '猛虎硬爬山' },
    { id: 99, handle: 'AC_DOUBLE', name: 'Double', nameZh: '二连矢' },
    { id: 26, handle: 'AL_TELEPORT', name: 'Teleport', nameZh: '瞬间移动' },
    { id: 28, handle: 'AL_HEAL', name: 'Heal', nameZh: '治愈术' },
    { id: 692, handle: 'ALL_CATCRY', name: 'Catcry', nameZh: '怪兽的咆哮' },
    { id: 693, handle: 'ALL_PARTYFLEE', name: 'Partyflee', nameZh: '吹吧! 花风!!' },
    ...PADDING_SKILLS,
  ],
  skill_groups: {
    '1': '通用技能',
    '26': '通用技能',
    '29': '服侍',
    '28': '服侍',
    '40': '武术宗师',
    '41': '武术宗师',
    '99': '弓箭手',
    '692': '其他技能',
    '693': '其他技能',
    ...Object.fromEntries(PADDING_SKILLS.map((skill) => [String(skill.id), '其他技能'])),
  },
  statuses: [
    { id: 1, handle: 'EFST_INTERNAL' },
    { id: 2, handle: 'EFST_BLESSING', name: 'Blessing', nameZh: '天使之赐福' },
  ],
  monsters: [{ id: 1001, name: '波利' }],
  items: [],
  maps: [],
  timeouts: [],
  job_skills: { '176': [1, 29, 40, 41] },
  job_skill_groups: { '176': { '通用技能': [1], '一转技能': [29], '二转技能': [40, 41] } },
};

async function mountProfileEditor(configText = 'useSelf_skill 29 {\n\tlvl 10\n\twhenStatusActive EFST_BLESSING\n}\n') {
  const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/ke' });
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/ke/options.json') return jsonResponse(PROFILE_OPTIONS);
    if (path === '/api/v1/ke/characters') {
      return jsonResponse({ characters: [{ aid: 1, cid: 2, nid: 3, char_name: '暴力男团', job_id: 176, map_name: 'payon.gat', last_seen_at: Date.now() }] });
    }
    if (path === '/api/v1/ke/profiles?aid=1&cid=2&nid=3') {
      return jsonResponse({ profiles: [{ id: 9, name: '主方案', is_active: false, updated_at: Date.now() }] });
    }
    if (path === '/api/v1/ke/profiles/9') {
      return jsonResponse({
        id: 9,
        name: '主方案',
        config_text: configText,
        mon_control: null,
        pickupitems: null,
        items_control: null,
        timeouts: null,
      });
    }
    return jsonResponse({ profiles: [] });
  }));

  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  mountKePage(root);
  await wait(20);
  const edit = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === '编辑')!;
  edit.click();
  await wait(20);
  root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="skills"]')!.click();
  return { dom, root };
}

describe("ke page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("角色下拉把 KE 自报的 char_name / map_name 当作纯文本，不解析为 HTML", async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/ke" });
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/ke/options.json") {
        return jsonResponse({ jobs: {}, skills: [], statuses: [], monsters: [], items: [], maps: [], timeouts: [] });
      }
      if (path === "/api/v1/ke/characters") {
        return jsonResponse({
          characters: [{ aid: 1, cid: 2, nid: 3, char_name: MALICIOUS_NAME, job_id: null, map_name: MALICIOUS_MAP, last_seen_at: Date.now() }],
        });
      }
      return jsonResponse({ profiles: [] });
    }));

    const root = dom.window.document.querySelector<HTMLElement>("#app")!;
    mountKePage(root);
    await wait(20);

    const select = root.querySelector<HTMLSelectElement>("#ke-char-select")!;
    expect(select.options).toHaveLength(1);
    expect(select.options[0]!.value).toBe("1:2:3");
    expect(select.options[0]!.textContent).toBe(`${MALICIOUS_NAME}（${MALICIOUS_MAP}）`);
    expect(select.querySelector("img, svg")).toBeNull();
    expect(root.querySelector("img[onerror], svg[onload]")).toBeNull();
  });

  it('编辑方案时显示职业中文名和已保存技能名，即使技能不在当前职业列表中', async () => {
    const { root } = await mountProfileEditor();

    expect(root.querySelector('#ke-char-job')?.textContent).toBe('武术宗师');
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    expect(card.querySelector('.ke-block-head')?.textContent).toContain('加速术');
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    expect(card.querySelector<HTMLInputElement>('.ke-picker input')?.value).toBe('加速术 (Incagi)');
  });

  it('技能下拉按通用技能和职业转职阶段分组', async () => {
    const { dom, root } = await mountProfileEditor();
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const input = card.querySelector<HTMLInputElement>('.ke-block-body .ke-picker input')!;
    input.value = '';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(Array.from(card.querySelectorAll('.ke-block-body .ke-picker-group')).map((item) => item.textContent)).toEqual([
      '通用技能',
      '一转技能',
      '二转技能',
    ]);
  });

  it('全部技能模式按职业分组，并在超出上限时提示直接输入过滤', async () => {
    const { dom, root } = await mountProfileEditor();
    root.querySelector<HTMLInputElement>('#ke-allskills')!.click();

    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const input = card.querySelector<HTMLInputElement>('.ke-block-body .ke-picker input')!;
    input.value = '';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    const body = card.querySelector<HTMLElement>('.ke-block-body')!;
    expect(Array.from(body.querySelectorAll('.ke-picker-group')).map((item) => item.textContent)).toEqual([
      '通用技能',
      '服侍',
      '武术宗师',
      '弓箭手',
      '其他技能',
    ]);
    expect(body.querySelectorAll('.ke-picker-item')).toHaveLength(100);
    expect(body.querySelector('.ke-picker-more')?.textContent).toBe('已达 100 项上限，请直接输入文字继续过滤');

    input.value = '测试技能100';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const labels = Array.from(body.querySelectorAll('.ke-picker-item')).map((item) => item.textContent);
    expect(labels).toEqual(['测试技能100 (Test100)']);
    expect(body.querySelector('.ke-picker-more')).toBeNull();
  });

  it('保留卡片可获得的服侍技能，但不把 ALL 命名空间技能放进职业候选', async () => {
    const { dom, root } = await mountProfileEditor();
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const input = card.querySelector<HTMLInputElement>('.ke-block-body .ke-picker input')!;
    input.value = '';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const labels = Array.from(card.querySelectorAll('.ke-block-body .ke-picker-item')).map((item) => item.textContent);

    expect(labels).toContain('瞬间移动 (Teleport)');
    expect(labels).toContain('治愈术 (Heal)');
    expect(labels).not.toContain('怪兽的咆哮 (Catcry)');
    expect(labels).not.toContain('吹吧! 花风!! (Partyflee)');
  });

  it('Buff 联想在状态数据缺少名称时仍能列出中文状态名', async () => {
    const { dom, root } = await mountProfileEditor();
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const input = card.querySelector<HTMLInputElement>('.ke-cond-row .ke-picker input')!;
    input.value = '天使之赐福';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(Array.from(card.querySelectorAll('.ke-cond-row .ke-picker-item')).map((item) => item.textContent)).toContain('天使之赐福 (Blessing)');
  });

  it('编辑方案时保留怪物 ID 对应的中文名称', async () => {
    const { root } = await mountProfileEditor('attackSkillSlot 29 {\n\tlvl 10\n\tmonsters 1001\n}\n');

    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    expect(card.querySelector('.ke-block-head')?.textContent).toContain('加速术');
    expect(card.querySelector('.ke-block-head')?.textContent).toContain('仅对：波利');
  });
});
