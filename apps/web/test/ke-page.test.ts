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

const MAPNAMES_FIXTURE = {
  generatedAt: '2026-10-25T00:00:00.000Z',
  source: {},
  names: { prontera: '普隆德拉', prt_fild08: '普隆德拉原野' },
};

const WORLDMAP_FIXTURE = {
  generatedAt: '2026-10-25T00:00:00.000Z',
  source: { worldmapHtml: '', mapNames: '', images: {} },
  layers: [
    {
      id: 'normal', name: '中土大陆', image: '/ke/worldmap/normal.jpg', cols: 23, rows: 18, cellW: 50, cellH: 48,
      points: [
        { code: 'prontera', row: 10, col: 14, span: 1, name: '卢恩 米德加兹王国 首都 普隆德拉' },
        { code: 'prt_fild08', row: 11, col: 13, span: 1, name: '普隆德拉原野' },
        { code: 'prt_fild01', row: 12, col: 14, span: 1, name: '普隆德拉原野 01' },
        {
          code: 'tur_dun01', row: 16, col: 20, span: 1, mvp: true, name: '乌龟岛',
          codes: ['tur_dun01', 'tur_dun02', 'tur_dun03', 'tur_dun04'],
          codeNames: { tur_dun01: '乌龟岛', tur_dun02: '乌龟密穴1层', tur_dun03: '乌龟密穴2层', tur_dun04: '旧良宫' },
        },
        // 红点 boss 格的关联地图（branch）：点击弹二级悬浮列表
        {
          code: 'hu_fild01', row: 0, col: 12, span: 1, mvp: true, name: '达纳托斯之塔',
          codes: ['hu_fild01', 'tha_t01', 'tha_t02', 'thana_boss'],
          codeNames: { hu_fild01: '达纳托斯之塔', tha_t01: '达纳托斯之塔1层', tha_t02: '达纳托斯之塔2层', thana_boss: '达纳托斯之塔 (未知区域)' },
        },
      ],
    },
    {
      id: 'dimension', name: '次元大陆', image: '/ke/worldmap/dimension.jpg', cols: 16, rows: 13, cellW: 54, cellH: 52,
      points: [{ code: 'eclage', row: 3, col: 5, span: 1, name: '守护精灵首都 埃克拉珠' }],
    },
  ],
};

// 地图预设（/ke/map-mobs.json）：地图 → 怪物 ID 列表 + 掉落物 ID 并集
const MAP_MOBS_FIXTURE = {
  generatedAt: '2026-10-26T00:00:00.000Z',
  source: {},
  maps: {
    prt_fild08: { mobs: [1001, 1002], drops: [501, 502] },
    prt_fild01: { mobs: [1003], drops: [503] },
  },
};

async function mountProfileEditor(
  configText = 'useSelf_skill 29 {\n\tlvl 10\n\twhenStatusActive EFST_BLESSING\n}\n',
  opts?: { tab?: string; worldmap?: boolean; mapNames?: boolean; mapMobs?: boolean },
) {
  const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/ke/my' });
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/ke/options.json') return jsonResponse(PROFILE_OPTIONS);
    if (path === '/ke/mapnames.json') {
      return opts?.mapNames ? jsonResponse(MAPNAMES_FIXTURE) : new Response('not found', { status: 404 });
    }
    if (path === '/ke/worldmap.json') {
      if (opts?.worldmap === false) return new Response('not found', { status: 404 });
      return jsonResponse(WORLDMAP_FIXTURE);
    }
    if (path === '/ke/map-mobs.json') {
      if (opts?.mapMobs === false) return new Response('not found', { status: 404 });
      return jsonResponse(MAP_MOBS_FIXTURE);
    }
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
  root.querySelector<HTMLButtonElement>(`#ke-nav [data-tab="${opts?.tab ?? 'skills'}"]`)!.click();
  return { dom, root };
}

describe("ke page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers the commerce purchase page from the KE configuration workspace", () => {
    const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/ke/my" });
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/ke/options.json") return jsonResponse(PROFILE_OPTIONS);
      if (path === "/api/v1/ke/characters") return jsonResponse({ characters: [] });
      return jsonResponse({ profiles: [] });
    }));
    const root = dom.window.document.querySelector<HTMLElement>("#app")!;

    mountKePage(root);

    expect(root.querySelector('a[href="/ke/buy"]')?.textContent).toContain("购买额度与功能");
  });

  it("角色切换卡片把 KE 自报的 char_name / map_name 当作纯文本，不解析为 HTML", async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/ke/my" });
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

    const strip = root.querySelector<HTMLElement>("#ke-char-strip")!;
    const chip = strip.querySelector<HTMLButtonElement>(".ke-char-card-chip")!;
    expect(chip.dataset.key).toBe("1:2:3");
    const nameEl = chip.querySelector(".ke-char-card-name")!;
    expect(nameEl.textContent).toBe(MALICIOUS_NAME);
    expect(strip.querySelector("script")).toBeNull();
    expect(root.querySelector("img[onerror], svg[onload]")).toBeNull();
  });

  it('远程域名上的 demo 参数不会开启免登录演示模式', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: 'https://example.com/ke/my?demo=1' });
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/ke/options.json') return jsonResponse({ jobs: {}, skills: [], statuses: [], monsters: [], items: [], maps: [], timeouts: [] });
      if (path === '/api/v1/ke/characters') return new Response(JSON.stringify({ error: { message: '请先登录' } }), { status: 401 });
      return jsonResponse({});
    }));

    const root = dom.window.document.querySelector<HTMLElement>('#app')!;
    mountKePage(root);
    await wait(20);

    expect(root.querySelector<HTMLElement>('#ke-demo-chip')?.hidden).toBe(true);
    expect(root.textContent).toContain('请先登录账号');
    expect(vi.mocked(fetch).mock.calls.some(([path]) => path === '/api/v1/ke/characters')).toBe(true);
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

  it('保存时未点开的规则区块也生成配置并带兜底行，不落 NULL', async () => {
    const { dom, root } = await mountProfileEditor();
    // fixture 里 profile 9 的 mon/pickup/items/timeouts 全是 null，且用户不进入这些区块，直接保存。
    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await wait(20);

    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const put = calls.find(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT');
    expect(put).toBeTruthy();
    const body = JSON.parse(put![1]!.body as string) as Record<string, string>;
    // 已有 profile（字段为 null）加载时走 ensureAllFallback：只补兜底行，不加 *卡片 预设（预设仅新建 profile）。
    expect(body.mon_control).toBe(
      'all_miniboss 0 0 0 0 0 0 0 0 0\nall_mvp 0 1 0 0 0 0 0 0 0\nall 1 0 0 0 0 0 0 0 0',
    );
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
    expect(equipAddBtns).toEqual(['＋ 自动换装', '＋ 自动切换武器']);

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
    expect(fieldLabels.some((t) => t.includes('负重触发条件'))).toBe(true);
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

  it('怪物多选/技能选择器：搜索输入不提交中间态，仅点选生效', async () => {
    const { dom, root } = await mountProfileEditor('equipAuto {\n\tmonsters 1001\n}\nuseSelf_skill 28 {\n}\n');
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="equip_auto"]')!.click();
    await wait(20);
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const selfCond = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond'))
      .find((el) => el.textContent?.includes('自身条件'))!;
    const monstersRow = Array.from(selfCond.querySelectorAll<HTMLElement>('.ke-cond-row'))
      .find((r) => (r.querySelector('select') as HTMLSelectElement).value === 'monsters')!;

    // 已有波利 chip；在追加 picker 里输入"绿"（不点选）不应新增 chip
    expect(monstersRow.querySelectorAll('.ke-tag').length).toBe(1);
    const pickerInput = monstersRow.querySelector<HTMLInputElement>('.ke-picker input')!;
    pickerInput.value = '绿';
    pickerInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await wait(10);
    expect(monstersRow.querySelectorAll('.ke-tag').length).toBe(1);

    // 点选「绿棉虫」选项后才新增
    const option = Array.from(monstersRow.querySelectorAll<HTMLElement>('.ke-picker-item'))
      .find((el) => el.textContent?.includes('绿棉虫'))!;
    option.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    await wait(10);
    expect(monstersRow.querySelectorAll('.ke-tag').length).toBe(2);
  });

  it('范围/不等号条件回退为文本输入并保留原文', async () => {
    const { root } = await mountProfileEditor('useSelf_skill 28 {\n\thp 20..80%\n}\n');
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="skills"]')!.click();
    await wait(20);
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const selfCond = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond'))
      .find((el) => el.textContent?.includes('自身条件'))!;
    const hpRow = Array.from(selfCond.querySelectorAll<HTMLElement>('.ke-cond-row'))
      .find((r) => (r.querySelector('select') as HTMLSelectElement).value === 'hp')!;
    // 范围写法无法三段式表达 → 回退文本输入，原文完整保留
    const fallback = hpRow.querySelector<HTMLInputElement>('.ke-cond-expr input[type="text"]')!;
    expect(fallback).not.toBeNull();
    expect(fallback.value).toBe('20..80%');
    expect(hpRow.querySelector('.ke-cond-op')).toBeNull();
  });

  it('多项背包物品条件回退为文本输入并保留原文', async () => {
    const { root } = await mountProfileEditor('equipAuto {\n\tinInventory 红色药水 > 1, 橙色药水 > 2\n}\n');
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="equip_auto"]')!.click();
    await wait(20);
    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    card.querySelector<HTMLButtonElement>('.ke-block-head')!.click();
    const selfCond = Array.from(card.querySelectorAll<HTMLElement>('.ke-cond'))
      .find((el) => el.textContent?.includes('自身条件'))!;
    const invRow = Array.from(selfCond.querySelectorAll<HTMLElement>('.ke-cond-row'))
      .find((r) => (r.querySelector('select') as HTMLSelectElement).value === 'inInventory')!;
    const fallback = invRow.querySelector<HTMLInputElement>('.ke-cond-item input[type="text"]')!;
    expect(fallback).not.toBeNull();
    expect(fallback.value).toBe('红色药水 > 1, 橙色药水 > 2');
  });

  it('保存前校验：错误配置被拦截并逐条提示，修正后可保存', async () => {
    const { root } = await mountProfileEditor('useSelf_skill 28 {\n\tlvl abc\n\thp 半血\n}\n');
    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await wait(20);

    // 被拦截：没有 PUT 请求，错误面板显示明细
    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls.some(([path, init]) => path === '/api/v1/ke/profiles/9' && init?.method === 'PUT')).toBe(false);
    const errorEl = root.querySelector<HTMLElement>('#ke-form-error')!;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain('发现 2 处配置问题');
    expect(errorEl.textContent).toContain('技能等级');
    expect(errorEl.textContent).toContain('自身 HP');
  });
  it('block 卡片有删除按钮', async () => {
    const { root } = await mountProfileEditor(
      'useSelf_skill 28 {\n\thp < 50%\n}\nuseSelf_skill 29 {\n\tlvl 5\n}\n',
    );
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="skills"]')!.click();
    await wait(20);

    const cards = () => Array.from(root.querySelectorAll<HTMLElement>('.ke-block-card'));
    const dels = () => Array.from(root.querySelectorAll<HTMLButtonElement>('.ke-block-del'));
    expect(cards()).toHaveLength(2);
    expect(dels()).toHaveLength(2);
    // 点第一张卡的 head（非 del 区域）应正常展开
    const firstHead = cards()[0]!.querySelector<HTMLButtonElement>('.ke-block-head')!;
    firstHead.click();
    await wait(10);
    expect(cards()[0]!.classList.contains('is-open')).toBe(true);
  });

  it('删除按钮点击不冒泡到 head 展开卡片', async () => {
    const { root } = await mountProfileEditor('useSelf_skill 28 {\n}\n');
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="skills"]')!.click();
    await wait(20);

    const card = root.querySelector<HTMLElement>('.ke-block-card')!;
    const del = card.querySelector<HTMLButtonElement>('.ke-block-del')!;
    expect(card.classList.contains('is-open')).toBe(false);
    del.click();
    await wait(10);
    // delete handler 的 stopPropagation 应阻止 head 的展开行为
    expect(card.classList.contains('is-open')).toBe(false);
  });

  it('确认删除后 block 从 DOM 和 configDoc 移除，保存后不再出现在 config_text', async () => {
    const { root } = await mountProfileEditor(
      'useSelf_skill 28 {\n\thp < 50%\n}\nuseSelf_skill 29 {\n\tlvl 5\n}\n',
    );
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="skills"]')!.click();
    await wait(20);

    const cards = () => Array.from(root.querySelectorAll<HTMLElement>('.ke-block-card'));
    expect(cards()).toHaveLength(2);

    // jsdom 环境无 confirm 函数 → delete handler 跳过确认直接执行
    const firstDel = cards()[0]!.querySelector<HTMLButtonElement>('.ke-block-del')!;
    firstDel.click();
    await wait(20);

    // DOM 和 nav 计数都应只剩 1 条
    expect(cards()).toHaveLength(1);

    // 保存验证序列化结果
    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await wait(20);
    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const put = calls.find(([p, init]) => p === '/api/v1/ke/profiles/9' && init?.method === 'PUT')!;
    const body = JSON.parse(put[1]!.body as string) as { config_text: string };
    expect(body.config_text).not.toContain('useSelf_skill 28');
    expect(body.config_text).toContain('useSelf_skill 29');
  });

  // —— 世界地图选图浮层（lockMap / saveMap 的 picker: "worldmap"） ——

  /** 打开「路线」分区并返回 lockMap 字段的输入框与「选择地图」按钮。 */
  async function mountRouteWithWorldmap(configText = '') {
    const { dom, root } = await mountProfileEditor(configText, { tab: 'route' });
    await wait(0);
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.ke-wmap-open'));
    expect(buttons.length).toBeGreaterThanOrEqual(2); // lockMap + saveMap
    const openBtn = buttons[0]!;
    const input = openBtn.parentElement!.querySelector<HTMLInputElement>('input')!;
    return { dom, root, openBtn, input };
  }

  it('lockMap/saveMap 渲染「选择地图」按钮，点击后请求 worldmap.json 并弹出选图浮层', async () => {
    const { root, openBtn, input } = await mountRouteWithWorldmap();
    expect(input.placeholder).toContain('地图'); // 仍然支持手输代码兜底
    openBtn.click();
    await wait(20);
    const overlay = root.querySelector<HTMLElement>('.ke-wmap-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('.ke-wmap-title')!.textContent).toContain('挂机地图');
    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string]>;
    expect(calls.some(([p]) => p === '/ke/worldmap.json')).toBe(true);
    const tabs = Array.from(overlay!.querySelectorAll<HTMLElement>('.ke-wmap-tab')).map((t) => t.textContent);
    expect(tabs).toEqual(['中土大陆', '次元大陆']);
    expect(overlay!.querySelectorAll('.ke-wmap-tab')[0]!.classList.contains('active')).toBe(true);
    expect(overlay!.querySelectorAll('.ke-wmap-cell').length).toBe(5);
  });

  it('格子渲染游戏同款小地图贴图，悬停显示中文名悬浮提示', async () => {
    const { dom, root, openBtn } = await mountRouteWithWorldmap();
    openBtn.click();
    await wait(20);
    const overlay = root.querySelector<HTMLElement>('.ke-wmap-overlay')!;
    const cell = overlay.querySelector<HTMLElement>('.ke-wmap-cell[data-code="prontera"]')!;
    const tile = cell.querySelector<HTMLImageElement>('.ke-wmap-cell-img');
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute('src')).toBe('/ke/worldmap/tiles/prontera.png');
    const tip = overlay.querySelector<HTMLElement>('.ke-wmap-tip')!;
    expect(tip.hidden).toBe(true);
    cell.dispatchEvent(new dom.window.MouseEvent('mouseenter', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain('普隆德拉');
    expect(tip.textContent).toContain('prontera');
    cell.dispatchEvent(new dom.window.MouseEvent('mouseleave', { bubbles: true }));
    expect(tip.hidden).toBe(true);
  });

  it('点击地图格子把地图代码写入 lockMap 并更新预览，浮层随之关闭', async () => {
    const { root, openBtn, input } = await mountRouteWithWorldmap();
    openBtn.click();
    await wait(20);
    root.querySelector<HTMLButtonElement>('.ke-wmap-cell[data-code="prontera"]')!.click();
    await wait(0);
    expect(root.querySelector('.ke-wmap-overlay')).toBeNull();
    expect(input.value).toBe('prontera');
    expect(root.querySelector<HTMLElement>('#ke-config-preview')!.textContent).toContain('lockMap prontera');
  });

  it('浮层打开时当前值所在格子带 active 高亮，并自动切到所在层', async () => {
    const { root, openBtn } = await mountRouteWithWorldmap('lockMap eclage\n');
    openBtn.click();
    await wait(20);
    const overlay = root.querySelector<HTMLElement>('.ke-wmap-overlay')!;
    // eclage 在次元大陆层：tab 2 应为 active
    const tabs = overlay.querySelectorAll<HTMLElement>('.ke-wmap-tab');
    expect(tabs[1]!.classList.contains('active')).toBe(true);
    const cell = overlay.querySelector<HTMLElement>('.ke-wmap-cell[data-code="eclage"]')!;
    expect(cell.classList.contains('active')).toBe(true);
  });

  it('一格多图（海龟洞）点击后弹二级菜单，可选中 tur_dun03 写入', async () => {
    const { root, openBtn, input } = await mountRouteWithWorldmap();
    openBtn.click();
    await wait(20);
    const overlay = root.querySelector<HTMLElement>('.ke-wmap-overlay')!;
    overlay.querySelector<HTMLButtonElement>('.ke-wmap-cell[data-code="tur_dun01"]')!.click();
    await wait(0);
    const menu = overlay.querySelector<HTMLElement>('.ke-wmap-menu');
    expect(menu).not.toBeNull();
    const items = Array.from(menu!.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.textContent);
    expect(items).toEqual(['乌龟岛（tur_dun01）', '乌龟密穴1层（tur_dun02）', '乌龟密穴2层（tur_dun03）', '旧良宫（tur_dun04）']);
    // 二级菜单带格子小图缩略
    expect(menu!.querySelectorAll<HTMLImageElement>('.ke-wmap-menu-img').length).toBe(4);
    expect(menu!.querySelector<HTMLImageElement>('.ke-wmap-menu-img')!.getAttribute('src')).toBe('/ke/worldmap/tiles/tur_dun01.png');
    menu!.querySelectorAll<HTMLButtonElement>('button')[2]!.click();
    await wait(0);
    expect(input.value).toBe('tur_dun03');
    expect(root.querySelector('.ke-wmap-overlay')).toBeNull();
  });

  it('红点 boss 格（hu_fild01）点击后弹关联地图二级悬浮，可选中 tha_t01 写入', async () => {
    const { root, openBtn, input } = await mountRouteWithWorldmap();
    openBtn.click();
    await wait(20);
    const overlay = root.querySelector<HTMLElement>('.ke-wmap-overlay')!;
    const cell = overlay.querySelector<HTMLButtonElement>('.ke-wmap-cell[data-code="hu_fild01"]')!;
    expect(cell.querySelector('.ke-wmap-mvp')).not.toBeNull(); // 红点标记
    cell.click();
    await wait(0);
    const menu = overlay.querySelector<HTMLElement>('.ke-wmap-menu');
    expect(menu).not.toBeNull();
    const items = Array.from(menu!.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.textContent);
    expect(items).toEqual(['达纳托斯之塔（hu_fild01）', '达纳托斯之塔1层（tha_t01）', '达纳托斯之塔2层（tha_t02）', '达纳托斯之塔 (未知区域)（thana_boss）']);
    // 每个选项带关联地图自己的小图缩略
    const thumbs = Array.from(menu!.querySelectorAll<HTMLImageElement>('.ke-wmap-menu-img')).map((t) => t.getAttribute('src'));
    expect(thumbs).toEqual([
      '/ke/worldmap/tiles/hu_fild01.png',
      '/ke/worldmap/tiles/tha_t01.png',
      '/ke/worldmap/tiles/tha_t02.png',
      '/ke/worldmap/tiles/thana_boss.png',
    ]);
    menu!.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
    await wait(0);
    expect(input.value).toBe('tha_t01');
    expect(root.querySelector('.ke-wmap-overlay')).toBeNull();
    expect(root.querySelector<HTMLElement>('#ke-config-preview')!.textContent).toContain('lockMap tha_t01');
  });

  it('Escape 关闭浮层且焦点归还「选择地图」按钮；手输地图代码仍是可用兜底', async () => {
    const { dom, root, openBtn, input } = await mountRouteWithWorldmap();
    openBtn.click();
    await wait(20);
    const overlay = root.querySelector<HTMLElement>('.ke-wmap-overlay')!;
    overlay.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(0);
    expect(root.querySelector('.ke-wmap-overlay')).toBeNull();
    expect(dom.window.document.activeElement).toBe(openBtn);
    // 手输兜底
    input.value = 'payon';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(root.querySelector<HTMLElement>('#ke-config-preview')!.textContent).toContain('lockMap payon');
  });

  it('挂机地图/回城地图输入框与下拉列表显示中文名，选中后仍写入地图代码', async () => {
    const { dom, root } = await mountProfileEditor('lockMap prt_fild08\n', { tab: 'route', mapNames: true });
    await wait(0);
    const row = root.querySelectorAll<HTMLElement>('.ke-mapline')[0]!;
    const input = row.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('普隆德拉原野（prt_fild08）'); // 输入框显示中文名，括号内保留代码
    const preview = (): string => root.querySelector<HTMLElement>('#ke-config-preview')!.textContent ?? '';

    // 半截中文名只过滤列表，不写入配置，避免存入无效中文名
    input.focus();
    input.value = '普隆';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(preview()).toContain('lockMap prt_fild08');
    input.value = '普隆德拉（';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const items = Array.from(row.querySelectorAll<HTMLElement>('.ke-picker-item'));
    expect(items.map((item) => item.textContent)).toEqual(['普隆德拉（prontera）']);

    items[0]!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    expect(input.value).toBe('普隆德拉（prontera）');
    expect(preview()).toContain('lockMap prontera');
  });

  it('worldmap.json 加载失败时浮层显示错误态，输入框仍可手动填写', async () => {
    const { root } = await mountProfileEditor('', { tab: 'route', worldmap: false });
    await wait(0);
    root.querySelector<HTMLButtonElement>('.ke-wmap-open')!.click();
    await wait(20);
    const overlay = root.querySelector<HTMLElement>('.ke-wmap-overlay')!;
    expect(overlay.querySelector('.ke-wmap-message')!.textContent).toContain('加载失败');
    expect(overlay.querySelector('.ke-wmap-retry')).not.toBeNull();
  });

  // —— 选定挂机地图后的「添加地图预设」询问浮层 ——

  /** 从世界地图选中指定格子（含等待预设浮层弹出）。 */
  async function pickWorldmapCell(root: HTMLElement, openBtn: HTMLButtonElement, code: string) {
    openBtn.click();
    await wait(20);
    root.querySelector<HTMLButtonElement>(`.ke-wmap-cell[data-code="${code}"]`)!.click();
    await wait(20);
  }

  /** 规则文件当前行名序列（从序列化预览读取，顺序即文件顺序）。 */
  function controlRowNames(root: HTMLElement, tab: string): string[] {
    root.querySelector<HTMLButtonElement>(`#ke-nav [data-tab="${tab}"]`)!.click();
    const text = root.querySelector<HTMLElement>('#ke-config-preview')!.textContent ?? '';
    return text.split('\n').filter((line) => line.trim() !== '').map((line) => line.split(/\s+/)[0]!);
  }

  it('选定挂机地图后弹出预设询问，点「是」把怪物与掉落物写入怪物规则/拾取物品/物品规则', async () => {
    const { dom, root, openBtn, input } = await mountRouteWithWorldmap();
    await pickWorldmapCell(root, openBtn, 'prt_fild08');

    const dialog = root.querySelector<HTMLElement>('.ke-preset-overlay');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('.ke-preset-title')!.textContent).toContain('添加地图预设');
    expect(dialog!.querySelector('.ke-preset-body')!.textContent).toContain('prt_fild08');
    expect(dialog!.querySelector('.ke-preset-body')!.textContent).toContain('2 只怪物');
    expect(dialog!.querySelector('.ke-preset-body')!.textContent).toContain('2 件掉落物品');
    // 怪物名单按 options.json 解析为中文名
    const chips = Array.from(dialog!.querySelectorAll<HTMLElement>('.ke-preset-mob')).map((c) => c.textContent);
    expect(chips).toEqual(['波利', '绿棉虫']);
    // 选图浮层已关闭，lockMap 已写入
    expect(root.querySelector('.ke-wmap-overlay')).toBeNull();
    expect(input.value).toBe('prt_fild08');

    dialog!.querySelector<HTMLButtonElement>('.ke-preset-yes')!.click();
    await wait(0);
    expect(root.querySelector('.ke-preset-overlay')).toBeNull();
    // 焦点归还「选择地图」按钮
    expect(dom.window.document.activeElement).toBe(openBtn);

    // 怪物规则：新增怪物行在前，兜底行（all_miniboss/all_mvp/all）仍在末尾
    expect(controlRowNames(root, 'mon_control')).toEqual(['1001', '1002', 'all_miniboss', 'all_mvp', 'all']);
    // 拾取物品：掉落物 + all 兜底
    expect(controlRowNames(root, 'pickupitems')).toEqual(['501', '502', 'all']);
    // 物品规则：掉落物 + all 兜底
    expect(controlRowNames(root, 'items_control')).toEqual(['501', '502', 'all']);
    // 导航计数同步
    expect(root.querySelector<HTMLElement>('#ke-nav [data-tab="mon_control"] .ke-count')!.textContent).toBe('5');
  });

  it('预设询问点「暂不添加」不写任何规则', async () => {
    const { root, openBtn } = await mountRouteWithWorldmap();
    await pickWorldmapCell(root, openBtn, 'prt_fild08');
    const dialog = root.querySelector<HTMLElement>('.ke-preset-overlay')!;
    dialog.querySelector<HTMLButtonElement>('.ke-preset-no')!.click();
    await wait(0);
    expect(root.querySelector('.ke-preset-overlay')).toBeNull();
    expect(controlRowNames(root, 'mon_control')).toEqual(['all_miniboss', 'all_mvp', 'all']);
    expect(controlRowNames(root, 'pickupitems')).toEqual(['all']);
    expect(controlRowNames(root, 'items_control')).toEqual(['all']);
  });

  it('选定无怪物数据的地图（城镇）时不弹预设询问', async () => {
    const { root, openBtn } = await mountRouteWithWorldmap();
    await pickWorldmapCell(root, openBtn, 'prontera');
    expect(root.querySelector('.ke-preset-overlay')).toBeNull();
  });

  it('回城地图选定后不弹预设询问（仅挂机地图询问）', async () => {
    const { root } = await mountRouteWithWorldmap();
    const saveBtn = root.querySelectorAll<HTMLButtonElement>('.ke-wmap-open')[1]!;
    saveBtn.click();
    await wait(20);
    root.querySelector<HTMLButtonElement>('.ke-wmap-cell[data-code="prt_fild08"]')!.click();
    await wait(20);
    expect(root.querySelector('.ke-preset-overlay')).toBeNull();
  });

  it('重复添加同一张地图时已有规则不重复写入', async () => {
    const { root, openBtn } = await mountRouteWithWorldmap();
    await pickWorldmapCell(root, openBtn, 'prt_fild08');
    root.querySelector<HTMLButtonElement>('.ke-preset-yes')!.click();
    await wait(0);
    // 换一张无数据地图再换回来，让浮层再次弹出
    await pickWorldmapCell(root, openBtn, 'prontera');
    expect(root.querySelector('.ke-preset-overlay')).toBeNull();
    await pickWorldmapCell(root, openBtn, 'prt_fild08');
    root.querySelector<HTMLButtonElement>('.ke-preset-yes')!.click();
    await wait(0);
    expect(controlRowNames(root, 'mon_control')).toEqual(['1001', '1002', 'all_miniboss', 'all_mvp', 'all']);
    expect(controlRowNames(root, 'pickupitems')).toEqual(['501', '502', 'all']);
    expect(controlRowNames(root, 'items_control')).toEqual(['501', '502', 'all']);
  });

  it('重新选择地图并确认后，上一张地图的怪物与物品预设被清空', async () => {
    const { root, openBtn } = await mountRouteWithWorldmap();
    await pickWorldmapCell(root, openBtn, 'prt_fild08');
    root.querySelector<HTMLButtonElement>('.ke-preset-yes')!.click();
    await wait(0);
    expect(controlRowNames(root, 'mon_control')).toEqual(['1001', '1002', 'all_miniboss', 'all_mvp', 'all']);

    // 换图时浮层提前说明上一张地图的预设会被清空
    await pickWorldmapCell(root, openBtn, 'prt_fild01');
    const dialog = root.querySelector<HTMLElement>('.ke-preset-overlay')!;
    expect(dialog.querySelector('.ke-preset-body')!.textContent).toContain('将被清空');
    dialog.querySelector<HTMLButtonElement>('.ke-preset-yes')!.click();
    await wait(0);

    // 只剩新地图的怪物与掉落物，兜底行仍在末尾
    expect(controlRowNames(root, 'mon_control')).toEqual(['1003', 'all_miniboss', 'all_mvp', 'all']);
    expect(controlRowNames(root, 'pickupitems')).toEqual(['503', 'all']);
    expect(controlRowNames(root, 'items_control')).toEqual(['503', 'all']);
  });

  it('换图后点「暂不添加」保留上一张地图的预设规则', async () => {
    const { root, openBtn } = await mountRouteWithWorldmap();
    await pickWorldmapCell(root, openBtn, 'prt_fild08');
    root.querySelector<HTMLButtonElement>('.ke-preset-yes')!.click();
    await wait(0);

    await pickWorldmapCell(root, openBtn, 'prt_fild01');
    root.querySelector<HTMLButtonElement>('.ke-preset-no')!.click();
    await wait(0);

    expect(controlRowNames(root, 'mon_control')).toEqual(['1001', '1002', 'all_miniboss', 'all_mvp', 'all']);
    expect(controlRowNames(root, 'pickupitems')).toEqual(['501', '502', 'all']);
    expect(controlRowNames(root, 'items_control')).toEqual(['501', '502', 'all']);
  });

  it('换到无怪图的地图（城镇）时，上一张地图的预设行被清空', async () => {
    const { root, openBtn } = await mountRouteWithWorldmap();
    await pickWorldmapCell(root, openBtn, 'prt_fild08');
    root.querySelector<HTMLButtonElement>('.ke-preset-yes')!.click();
    await wait(0);

    // 城镇无预设数据：不弹浮层，但上一张地图的怪物/掉落行直接清空
    await pickWorldmapCell(root, openBtn, 'prontera');
    expect(root.querySelector('.ke-preset-overlay')).toBeNull();
    expect(controlRowNames(root, 'mon_control')).toEqual(['all_miniboss', 'all_mvp', 'all']);
    expect(controlRowNames(root, 'pickupitems')).toEqual(['all']);
    expect(controlRowNames(root, 'items_control')).toEqual(['all']);
  });

  it('map-mobs.json 加载失败时静默跳过预设询问，选图不受影响', async () => {
    const { root } = await mountProfileEditor('', { tab: 'route', mapMobs: false });
    await wait(0);
    const openBtn = root.querySelectorAll<HTMLButtonElement>('.ke-wmap-open')[0]!;
    const input = openBtn.parentElement!.querySelector<HTMLInputElement>('input')!;
    await pickWorldmapCell(root, openBtn, 'prt_fild08');
    expect(root.querySelector('.ke-preset-overlay')).toBeNull();
    expect(input.value).toBe('prt_fild08');
  });

  // —— 高级编辑（直接改 CONFIG.TXT / 规则文件） ——

  it('高级编辑：修改 CONFIG.TXT 文本后左侧表单同步更新', async () => {
    const { dom, root } = await mountProfileEditor('attackCheckLOS 1\nuseSelf_skill 29 {\n\tlvl 10\n}\n');
    const editor = root.querySelector<HTMLTextAreaElement>('#ke-config-editor')!;
    const adv = root.querySelector<HTMLButtonElement>('#ke-preview-adv')!;
    expect(editor.hidden).toBe(true);

    adv.click();
    expect(editor.hidden).toBe(false);
    expect(adv.getAttribute('aria-pressed')).toBe('true');
    expect(editor.value).toContain('attackCheckLOS 1');

    // 把开启改成关闭，左侧「检查视线」开关应同步切换
    editor.value = editor.value.replace('attackCheckLOS 1', 'attackCheckLOS 0');
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="combat"]')!.click();
    const field = Array.from(root.querySelectorAll<HTMLElement>('.ke-field'))
      .find((el) => el.textContent?.includes('检查视线'))!;
    expect(field).toBeTruthy();
    expect(field.querySelector<HTMLButtonElement>('.ke-seg button.is-on')!.textContent).toBe('关闭');
    expect(root.querySelector<HTMLElement>('#ke-dirty')!.hidden).toBe(false);

    // 退出高级编辑后恢复只读预览
    adv.click();
    expect(editor.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#ke-config-preview')!.hidden).toBe(false);
  });

  it('高级编辑：修改规则文件文本后规则表条目同步更新', async () => {
    const { dom, root } = await mountProfileEditor();
    root.querySelector<HTMLButtonElement>('#ke-nav [data-tab="mon_control"]')!.click();
    await wait(10);
    root.querySelector<HTMLButtonElement>('#ke-preview-adv')!.click();
    const editor = root.querySelector<HTMLTextAreaElement>('#ke-config-editor')!;
    expect(editor.value).toContain('all_mvp');

    editor.value = 'all 1 0 0\n';
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // 规则行被替换成单条 all，导航计数同步为 1
    const count = root.querySelector<HTMLElement>('#ke-nav [data-tab="mon_control"] .ke-count')!;
    expect(count.textContent).toBe('1');
    expect(count.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#ke-config-preview')!.textContent).toContain('all 1 0 0');
  });

  // —— demo：多角色与复制方案 ——

  async function mountDemoPage() {
    const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/ke/my?demo=1' });
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/ke/options.json') return jsonResponse(PROFILE_OPTIONS);
      if (path === '/ke/mapnames.json') return jsonResponse(MAPNAMES_FIXTURE);
      return jsonResponse({});
    }));
    const root = dom.window.document.querySelector<HTMLElement>('#app')!;
    mountKePage(root);
    await wait(20);
    return { dom, root };
  }

  it('演示模式：30 个角色，只有波利猎人有 3 套方案，其他角色为空状态', async () => {
    const { root } = await mountDemoPage();
    expect(root.querySelector<HTMLElement>('#ke-demo-chip')!.hidden).toBe(false);
    const chips = root.querySelectorAll<HTMLButtonElement>('.ke-char-card-chip');
    expect(chips).toHaveLength(30);
    // 默认平铺全部角色，不再有「展开 N 个角色」的折叠按钮
    expect(root.querySelector('.ke-char-card-more')).toBeNull();
    expect(root.querySelector<HTMLElement>('#ke-roster-count')!.textContent).toBe('30');
    expect(root.querySelector<HTMLElement>('#ke-roster-total')!.textContent).toBe('/ 30');
    expect(root.querySelector<HTMLElement>('#ke-roster-note')!.textContent).toContain('全部 30');
    expect(root.querySelector<HTMLElement>('#ke-char-name')!.textContent).toBe('波利猎人');
    expect(root.querySelector<HTMLElement>('#ke-stat-profiles')!.textContent).toBe('3');
    expect(root.querySelector<HTMLElement>('#ke-stat-active')!.textContent).toBe('1');
    expect(root.querySelector<HTMLElement>('#ke-stat-chars')!.textContent).toBe('30');
    expect(root.querySelector<HTMLElement>('#ke-profiles-who')!.textContent).toContain('波利猎人 · 3 套方案');
    expect(root.querySelectorAll('.ke-profile-card')).toHaveLength(3);
    expect(vi.mocked(fetch).mock.calls.some(([path]) => path === '/api/v1/ke/characters')).toBe(false);

    chips[1]!.click();
    await wait(10);
    expect(root.querySelector<HTMLElement>('#ke-char-name')!.textContent).toBe('初心者小明');
    expect(root.querySelectorAll('.ke-profile-card')).toHaveLength(0);
    expect(root.textContent).toContain('该角色还没有配置方案');
    expect(root.querySelector('.ke-empty-orbit')).not.toBeNull();
    expect(root.querySelector<HTMLElement>('#ke-stat-profiles')!.textContent).toBe('0');
  });

  it('演示模式：名册支持按角色名/职业过滤，清空后恢复全部', async () => {
    const { root } = await mountDemoPage();
    const filter = root.querySelector<HTMLInputElement>('#ke-roster-filter')!;
    filter.value = '初心';
    filter.dispatchEvent(new root.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    await wait(10);

    const matched = root.querySelectorAll<HTMLButtonElement>('.ke-char-card-chip');
    expect(matched).toHaveLength(2);
    expect(root.querySelector<HTMLElement>('#ke-roster-count')!.textContent).toBe('2');
    expect(root.querySelector<HTMLElement>('#ke-roster-total')!.textContent).toBe('/ 30');
    expect(root.querySelector<HTMLElement>('#ke-roster-note')!.textContent).toContain('匹配 2 / 30');
    expect(root.querySelector('.ke-roster-empty')).toBeNull();

    filter.value = '猎人';
    filter.dispatchEvent(new root.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    await wait(10);
    expect(root.querySelectorAll('.ke-char-card-chip')).toHaveLength(1);
    expect(root.querySelector<HTMLElement>('.ke-char-card-name')!.textContent).toBe('波利猎人');

    // 职业列同样参与过滤（demo 的 options 里没有这些职业，统一显示「未知职业」）
    filter.value = '未知职业';
    filter.dispatchEvent(new root.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    await wait(10);
    expect(root.querySelectorAll('.ke-char-card-chip')).toHaveLength(30);

    filter.value = '不存在';
    filter.dispatchEvent(new root.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    await wait(10);
    expect(root.querySelectorAll('.ke-char-card-chip')).toHaveLength(0);
    expect(root.querySelector('.ke-roster-empty')!.textContent).toContain('没有匹配「不存在」');

    filter.value = '';
    filter.dispatchEvent(new root.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    await wait(10);
    expect(root.querySelectorAll('.ke-char-card-chip')).toHaveLength(30);
    expect(root.querySelector<HTMLElement>('#ke-roster-note')!.textContent).toContain('全部 30');
  });

  it('演示模式：复制方案到另一名角色后，目标角色下出现同名方案', async () => {
    const { root } = await mountDemoPage();
    const copyBtn = Array.from(root.querySelectorAll<HTMLButtonElement>('.ke-profile-actions button'))
      .find((button) => button.textContent === '复制')!;
    copyBtn.click();

    const overlay = root.querySelector<HTMLElement>('.ke-copy-overlay')!;
    expect(overlay.hidden).toBe(false);
    expect(overlay.querySelectorAll('.ke-copy-char')).toHaveLength(29);
    const target = overlay.querySelector<HTMLButtonElement>('.ke-copy-char[data-key="1000001:2000002:3000002"]')!;
    target.click();
    const confirmBtn = overlay.querySelector<HTMLButtonElement>('#ke-copy-confirm')!;
    expect(confirmBtn.disabled).toBe(false);
    confirmBtn.click();
    await wait(10);

    expect(overlay.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('.ke-char-card-chip[data-key="1000001:2000002:3000002"]')!.click();
    await wait(10);
    expect(root.querySelector<HTMLElement>('#ke-char-name')!.textContent).toBe('初心者小明');
    const cards = root.querySelectorAll<HTMLElement>('.ke-profile-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelector('.ke-profile-name')!.textContent).toContain('斐扬打波利');
  });
});
