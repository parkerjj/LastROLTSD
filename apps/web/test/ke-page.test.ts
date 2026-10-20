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
  monsters: [{ id: 1001, name: '波利' }, { id: 1002, name: '绿棉虫' }],
  items: [{ id: 501, name: '红色药水' }, { id: 502, name: '橙色药水' }],
  maps: [{ code: 'prontera' }, { code: 'prt_fild08' }],
  timeouts: [
    { key: 'ai_attack', value: '1', desc: '攻击间隔', range: '0-10' },
    { key: 'ai_teleport_idle', value: '5', desc: '空闲传送', range: '0-100' },
  ],
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

  it('清空 item 选择器后保存，不再把旧值写回 config.txt', async () => {
    const { dom, root } = await mountProfileEditor('teleportAuto_item1 苍蝇翅膀\nlockMap prt_fild08\n');
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="survival"]')!.click();
    const pickerInput = Array.from(root.querySelectorAll<HTMLInputElement>('.ke-picker input'))
      .find((input) => input.value === '苍蝇翅膀')!;
    expect(pickerInput).toBeTruthy();
    pickerInput.value = '';
    pickerInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await wait(20);

    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const put = calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT')!;
    const body = JSON.parse(put[1]!.body as string) as { config_text: string };
    expect(body.config_text).not.toContain('teleportAuto_item1');
    expect(body.config_text).toContain('lockMap prt_fild08');
  });

  it('保存时未点开的规则区块也生成配置并带 all 兜底，不落 NULL', async () => {
    const { dom, root } = await mountProfileEditor();
    // fixture 里 profile 9 的 mon/pickup/items/timeouts 全是 null，且用户不进入这些区块，直接保存。
    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await wait(20);

    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const put = calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT');
    expect(put).toBeTruthy();
    const body = JSON.parse(put![1]!.body as string) as Record<string, string>;
    expect(body.mon_control).toBe('all 1 0 0');
    expect(body.pickupitems).toBe('all 1');
    expect(body.items_control).toBe('all 0 0 0');
    // timeouts 为空时按 KE 默认值 + LastRO 覆盖值填满，而非存空/NULL。
    expect(body.timeouts).toBe('ai_attack 0.3\nai_teleport_idle 10');
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

  it('比较条件渲染为「操作符+数值+后缀」三段式编辑器', async () => {
    const { dom, root } = await mountProfileEditor('useSelf_skill 29 {\n\tlvl 10\n\thp < 50%\n\tsp > 30\n}\n');
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();

    // 展开条件区域
    const condSection = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond')).find((el) => el.textContent?.includes('自身'));
    expect(condSection).toBeTruthy();

    const condRows = condSection!.querySelectorAll<HTMLElement>('.ke-cond-row');
    expect(condRows).toHaveLength(2);

    // 第一行：hp < 50%
    // row 里有 3 个 select：条件 key、操作符、后缀
    const row1Selects = condRows[0]!.querySelectorAll('select');
    expect(row1Selects).toHaveLength(3);
    expect((row1Selects[0] as HTMLSelectElement).value).toBe('hp');
    const row1Op = row1Selects[1] as HTMLSelectElement;
    const row1Num = condRows[0]!.querySelector('input') as HTMLInputElement;
    const row1Suffix = row1Selects[2] as HTMLSelectElement;
    expect(row1Op.value).toBe('<');
    expect(row1Num.value).toBe('50');
    expect(row1Suffix.value).toBe('%');

    // 第二行：sp > 30
    const row2Selects = condRows[1]!.querySelectorAll('select');
    expect(row2Selects).toHaveLength(3);
    expect((row2Selects[0] as HTMLSelectElement).value).toBe('sp');
    const row2Op = row2Selects[1] as HTMLSelectElement;
    const row2Num = condRows[1]!.querySelector('input') as HTMLInputElement;
    const row2Suffix = row2Selects[2] as HTMLSelectElement;
    expect(row2Op.value).toBe('>');
    expect(row2Num.value).toBe('30');
    expect(row2Suffix.value).toBe('');

    // 修改后缀从 % 改为数值，保存后文本应去掉 %
    row1Suffix.value = '';
    row1Suffix.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await wait(20);

    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const put = calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT')!;
    const body = JSON.parse(put[1]!.body as string) as { config_text: string };
    expect(body.config_text).toContain('hp < 50');
    expect(body.config_text).not.toContain('hp < 50%');
    expect(body.config_text).toContain('sp > 30');
  });

  it('纯数值比较条件（monstersCount）无百分比后缀下拉', async () => {
    const { root } = await mountProfileEditor('useSelf_skill 29 {\n\tlvl 10\n\tmonstersCount > 3\n\tmonstersCountDist 5\n}\n');
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();

    const condSection = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond')).find((el) => el.textContent?.includes('自身'));
    const condRows = condSection!.querySelectorAll<HTMLElement>('.ke-cond-row');
    expect(condRows).toHaveLength(2);

    // monstersCount：操作符 + 数值，无后缀下拉（2 个 select：key + 操作符）
    const row1Selects = condRows[0]!.querySelectorAll('select');
    expect(row1Selects).toHaveLength(2);
    expect((row1Selects[0] as HTMLSelectElement).value).toBe('monstersCount');
    expect((row1Selects[1] as HTMLSelectElement).value).toBe('>');
    expect((condRows[0]!.querySelector('input') as HTMLInputElement).value).toBe('3');

    // monstersCountDist：普通文本输入（1 个 select：key）
    const row2Selects = condRows[1]!.querySelectorAll('select');
    expect(row2Selects).toHaveLength(1);
    expect((row2Selects[0] as HTMLSelectElement).value).toBe('monstersCountDist');
    expect((condRows[1]!.querySelector('input') as HTMLInputElement).value).toBe('5');
  });

  it('新建百分比条件（hp）默认后缀为 %', async () => {
    const { dom, root } = await mountProfileEditor('useSelf_skill 29 {\n\tlvl 10\n}\n');
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();

    const condSection = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond')).find((el) => el.textContent?.includes('自身'))!;
    condSection.querySelector<HTMLButtonElement>('.ke-btn-ghost')!.click();

    const condRows = condSection.querySelectorAll<HTMLElement>('.ke-cond-row');
    const lastRow = condRows[condRows.length - 1]!;
    const selects = lastRow.querySelectorAll('select');
    // 新建行：key + 操作符 + 后缀（hp 是百分比类）
    expect(selects).toHaveLength(3);
    expect((selects[0] as HTMLSelectElement).value).toBe('hp');
    // 后缀下拉默认 %
    expect((selects[2] as HTMLSelectElement).value).toBe('%');

    // 输入数值后保存应带 %
    const numInput = lastRow.querySelector('input') as HTMLInputElement;
    numInput.value = '80';
    numInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await wait(20);

    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const put = calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT')!;
    const body = JSON.parse(put[1]!.body as string) as { config_text: string };
    expect(body.config_text).toContain('hp < 80%');
  });

  it('noSmartHeal 仅对治愈术（28）显示，其他技能隐藏', async () => {
    const { root } = await mountProfileEditor('useSelf_skill 28 {\n\tlvl 10\n\tnoSmartHeal 1\n}\nuseSelf_skill 29 {\n\tlvl 10\n}\n');

    const cards = root.querySelectorAll<HTMLElement>('.ke-block-card');
    expect(cards).toHaveLength(2);

    // 治愈术（28）应显示「不使用智能治疗」
    const healCard = cards[0]!;
    expect(healCard.querySelector('.ke-block-head')?.textContent).toContain('治愈术');
    healCard.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    expect(Array.from(healCard.querySelectorAll('.ke-field')).some((el) => el.textContent?.includes('不使用智能治疗'))).toBe(true);

    // 加速术（29）不应显示「不使用智能治疗」
    const agiCard = cards[1]!;
    expect(agiCard.querySelector('.ke-block-head')?.textContent).toContain('加速术');
    agiCard.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    expect(Array.from(agiCard.querySelectorAll('.ke-field')).some((el) => el.textContent?.includes('不使用智能治疗'))).toBe(false);
  });

  it('与技能无关的 block 拆到独立 tab：技能 tab 只显示技能类，换装 tab 只显示自动换装', async () => {
    const { root } = await mountProfileEditor('');

    // 技能 tab：添加区只有技能类按钮
    const skillAddBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.ke-block-add')).map((b) => b.textContent);
    expect(skillAddBtns).toContain('＋ 攻击技能');
    expect(skillAddBtns).toContain('＋ 自身增益/治疗技能');
    expect(skillAddBtns).toContain('＋ 队伍技能');
    expect(skillAddBtns.some((t) => t?.includes('自身使用物品'))).toBe(false);
    expect(skillAddBtns.some((t) => t?.includes('自动购买'))).toBe(false);
    expect(skillAddBtns.some((t) => t?.includes('自动取物'))).toBe(false);
    expect(skillAddBtns.some((t) => t?.includes('自动换装'))).toBe(false);

    // 自动换装 tab：只有自动换装
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="equip_auto"]')!.click();
    await wait(20);
    const equipAddBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.ke-block-add')).map((b) => b.textContent);
    expect(equipAddBtns).toEqual(['＋ 自动换装']);

    // 物品使用 / 自动购买 / 自动取物各自独立
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="item_use"]')!.click();
    await wait(20);
    expect(Array.from(root.querySelectorAll<HTMLButtonElement>('.ke-block-add')).map((b) => b.textContent)).toEqual(['＋ 自身使用物品']);
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="buy_auto"]')!.click();
    await wait(20);
    expect(Array.from(root.querySelectorAll<HTMLButtonElement>('.ke-block-add')).map((b) => b.textContent)).toEqual(['＋ 自动购买']);
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="get_auto"]')!.click();
    await wait(20);
    expect(Array.from(root.querySelectorAll<HTMLButtonElement>('.ke-block-add')).map((b) => b.textContent)).toEqual(['＋ 自动取物（仓库）']);
  });

  it('equipAuto 渲染 11 个槽位、块级字段和自身/怪物条件组，怪物条件无目标冷却', async () => {
    const { root } = await mountProfileEditor('equipAuto {\n\ttopHead Poring Hat\n\tweight 50\n\ttarget 1001\n\thp > 30%\n\ttarget_dist < 8\n}\n');
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="equip_auto"]')!.click();
    await wait(20);

    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    expect(card).not.toBeNull();
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();

    // 11 个槽位（item picker）+ 负重触发线 + 只在坐下时触发 + 攻击目标限定
    const fieldLabels = Array.from(card.querySelectorAll('.ke-field')).map((el) => el.textContent ?? '');
    for (const label of ['头上', '头中', '头下', '右手', '左手', '左饰品', '右饰品', '披肩', '铠甲', '鞋子', '箭矢']) {
      expect(fieldLabels.some((t) => t.includes(label))).toBe(true);
    }
    expect(fieldLabels.some((t) => t.includes('负重触发线'))).toBe(true);
    expect(fieldLabels.some((t) => t.includes('只在坐下时触发'))).toBe(true);
    expect(fieldLabels.some((t) => t.includes('攻击目标限定'))).toBe(true);

    // 两个条件组：自身条件 + 怪物条件
    const condSections = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond'));
    expect(condSections.some((el) => el.textContent?.includes('自身条件'))).toBe(true);
    expect(condSections.some((el) => el.textContent?.includes('怪物条件'))).toBe(true);

    // 已加载的条件行正确回显：hp（自身）与 target_dist（怪物）
    const selfCond = condSections.find((el) => el.textContent?.includes('自身条件'))!;
    const monsterCond = condSections.find((el) => el.textContent?.includes('怪物条件'))!;
    expect((selfCond.querySelector('.ke-cond-row select') as HTMLSelectElement).value).toBe('hp');
    expect((monsterCond.querySelector('.ke-cond-row select') as HTMLSelectElement).value).toBe('target_dist');

    // 怪物条件下拉中没有 target_timeout；自身条件下拉中有 inInventory / partyAggressives
    // （每行第一个 select 是条件 key；比较条件行后面还跟着操作符/后缀 select）
    monsterCond.querySelector<HTMLButtonElement>('.ke-btn-ghost')!.click();
    const monsterRows = monsterCond.querySelectorAll<HTMLElement>('.ke-cond-row');
    const lastMonsterRow = monsterRows[monsterRows.length - 1]!;
    const monsterKeySelect = lastMonsterRow.querySelector('select')!;
    const monsterOptions = Array.from(monsterKeySelect.options).map((o) => o.value);
    expect(monsterOptions).not.toContain('target_timeout');
    expect(monsterOptions).toContain('target_misses');
    expect(monsterOptions).toContain('target_is_aggressive');

    selfCond.querySelector<HTMLButtonElement>('.ke-btn-ghost')!.click();
    const selfRows = selfCond.querySelectorAll<HTMLElement>('.ke-cond-row');
    const lastSelfRow = selfRows[selfRows.length - 1]!;
    const selfKeySelect = lastSelfRow.querySelector('select')!;
    const selfOptions = Array.from(selfKeySelect.options).map((o) => o.value);
    expect(selfOptions).toContain('inInventory');
    expect(selfOptions).toContain('partyAggressives');
    expect(selfOptions).toContain('ap');
  });

  it('条件控件按类型渲染：开关/怪物多选/物品三段/地图/AI 模式', async () => {
    const { root } = await mountProfileEditor(
      'equipAuto {\n\ttopHead Poring Hat\n\tstopWhenHit 1\n\tmonsters 1001\n\tinInventory 红色药水 > 1\n\tinMap prontera\n\tmanualAI 2\n}\n',
    );
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="equip_auto"]')!.click();
    await wait(20);

    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const selfCond = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond'))
      .find((el) => el.textContent?.includes('自身条件'))!;
    const rows = Array.from(selfCond.querySelectorAll<HTMLElement>('.ke-cond-row'));
    const rowOf = (key: string) => rows.find((r) => (r.querySelector('select') as HTMLSelectElement).value === key)!;

    // stopWhenHit：bool → 关闭/开启 分段开关，且 1 已选中「开启」
    const stopRow = rowOf('stopWhenHit');
    const segBtns = Array.from(stopRow.querySelectorAll<HTMLButtonElement>('.ke-seg button'));
    expect(segBtns.map((b) => b.textContent)).toEqual(['关闭', '开启']);
    expect(segBtns.find((b) => b.classList.contains('is-on'))?.textContent).toBe('开启');

    // monsters：chips 多选，已有波利 chip
    const monstersRow = rowOf('monsters');
    expect(monstersRow.querySelector('.ke-tag')?.textContent).toContain('波利');
    expect(monstersRow.querySelector('.ke-picker')).not.toBeNull();

    // inInventory：物品 + 操作符 + 数值三段式，回显 红色药水 > 1
    const invRow = rowOf('inInventory');
    const invExpr = invRow.querySelector<HTMLElement>('.ke-cond-item')!;
    expect(invExpr).not.toBeNull();
    expect(invExpr.querySelector<HTMLInputElement>('.ke-picker input')?.value).toBe('红色药水');
    expect(invExpr.querySelector<HTMLSelectElement>('.ke-cond-op')?.value).toBe('>');
    expect(invExpr.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe('1');

    // inMap：地图选择器回显 prontera
    const mapRow = rowOf('inMap');
    expect(mapRow.querySelector<HTMLInputElement>('.ke-picker input')?.value).toBe('prontera');

    // manualAI：三段按钮，2 已选中「全模式下启用」
    const aiRow = rowOf('manualAI');
    const aiBtns = Array.from(aiRow.querySelectorAll<HTMLButtonElement>('.ke-seg button'));
    expect(aiBtns.map((b) => b.textContent)).toEqual(['全自动模式', '半自动模式', '全模式下启用']);
    expect(aiBtns.find((b) => b.classList.contains('is-on'))?.textContent).toBe('全模式下启用');
  });

  it('物品数量条件修改后保存为 "物品 op 数值"；开关切换为 0/1', async () => {
    const { dom, root } = await mountProfileEditor('equipAuto {\n\tinInventoryID 501 > 1\n\tstopWhenHit 0\n}\n');
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="equip_auto"]')!.click();
    await wait(20);
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const selfCond = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond'))
      .find((el) => el.textContent?.includes('自身条件'))!;
    const rows = Array.from(selfCond.querySelectorAll<HTMLElement>('.ke-cond-row'));
    const rowOf = (key: string) => rows.find((r) => (r.querySelector('select') as HTMLSelectElement).value === key)!;

    // inInventoryID 用 ID pool：value 存 501，picker 显示对应名称「红色药水」，改数量为 5
    const invRow = rowOf('inInventoryID');
    expect(invRow.querySelector<HTMLInputElement>('.ke-picker input')?.value).toBe('红色药水');
    const numInput = invRow.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    numInput.value = '5';
    numInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // stopWhenHit 0 → 点「开启」切到 1
    const stopRow = rowOf('stopWhenHit');
    const onBtn = Array.from(stopRow.querySelectorAll<HTMLButtonElement>('.ke-seg button'))
      .find((b) => b.textContent === '开启')!;
    onBtn.click();

    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await wait(20);
    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const put = calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT')!;
    const body = JSON.parse(put[1]!.body as string) as { config_text: string };
    expect(body.config_text).toContain('\tinInventoryID 501 > 5');
    expect(body.config_text).toContain('\tstopWhenHit 1');
  });
});
