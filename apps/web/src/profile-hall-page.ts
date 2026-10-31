import { authStore, type AuthStore, type AuthStoreState } from './auth/store';
import { mountSiteNav, siteNavMarkup } from './nav';
import { HallApiError, normalizeShareCode, profileHallApi, type SharedProfileDetail, type SharedProfilePage, type SharedProfileQuery } from './profile-hall-api';
import { isLocalDemoMode } from './demo-mode';
import { createProfileHallDemoApi } from './profile-hall-demo-api';
import { buildHallJobFamilies, type HallJobFamily } from '../../../scripts/ke-job-map.mjs';
import './profile-hall.css';

type SessionStore = Pick<AuthStore, 'getState' | 'subscribe' | 'bootstrap'> & Partial<Pick<AuthStore, 'refreshForVisit'>>;
type Character = { aid: number; cid: number; nid: number; char_name: string; job_id: number | null };
const files = [
  ['config_text', 'config.txt'], ['mon_control', 'mon_control.txt'], ['pickupitems', 'pickupitems.txt'],
  ['items_control', 'items_control.txt'], ['timeouts', 'timeouts.txt'],
] as const;

function signedIn(state: Readonly<AuthStoreState>): string | null {
  return state.status === 'active' || state.status === 'pending' ? state.user.id : null;
}

function errorText(error: unknown): string {
  if (error instanceof HallApiError) {
    if (error.status === 404) return '这套共享配置已撤回或不存在。';
    if (error.code === 'KE_PROFILE_LIMIT_REACHED') return '该角色的方案已满 20 套。选择其他角色，或先删除一套已有方案。';
    if (error.code === 'KE_COPY_REQUEST_CONFLICT') return '上次复制请求无法继续，请使用新的复制请求重试。';
    return error.message;
  }
  return '网络连接失败，请重试。';
}

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = '', content = ''): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function button(doc: Document, label: string, dataName?: string, dataValue?: string): HTMLButtonElement {
  const node = element(doc, 'button', 'hall-button', label);
  node.type = 'button';
  if (dataName) node.dataset[dataName] = dataValue ?? '';
  return node;
}

function shareLink(code: string, demo: boolean): string {
  const params = new URLSearchParams({ code });
  if (demo) params.set('demo', '1');
  return `${window.location.origin}/ke/hall?${params}`;
}
function updateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
}

export function mountProfileHall(root: HTMLElement, store: SessionStore = authStore): () => void {
  const doc = root.ownerDocument;
  const demo = isLocalDemoMode(doc.defaultView?.location);
  const api = demo ? createProfileHallDemoApi() : profileHallApi;
  const editorHref = demo ? '/ke/my?demo=1' : '/ke/my';
  const editorLabel = demo ? '预览配置编辑器 →' : '我的配置 →';
  root.innerHTML = `<header class="site-header"><div class="topbar page-width"><a class="brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>${siteNavMarkup("ke")}</div></header>
    <main class="page-width hall-page"><header class="hall-heading"><div><h1>配置大厅</h1><p class="hall-sub">找一套适合自己的配置，复制到角色后再按需要调整。</p></div><a href="${editorHref}" class="hall-editor-link">${editorLabel}</a></header>
    ${demo ? '<aside class="hall-demo-notice" role="note"><span><strong>演示模式</strong> · 示例数据只在当前页面模拟，刷新后恢复。</span><a href="/ke/hall">进入正式大厅</a></aside>' : ''}
    <section class="hall-tools" aria-label="查找配置"><select data-job aria-label="职业系"><option value="">全部职业系</option></select><select data-sort aria-label="排序"><option value="newest">最新分享</option><option value="uses">使用人数</option><option value="likes">点赞数</option></select><span class="hall-tools-gap"></span><input data-code-input class="hall-code-input" placeholder="分享码 ABC-1234" autocomplete="off" /><button type="button" class="hall-find" data-code-find>查找</button></section>
    <p class="hall-message" data-status role="status" aria-live="polite"></p><section data-list class="hall-list" aria-label="共享配置"></section><div data-pagination class="hall-pagination"></div><section data-detail class="hall-detail" hidden></section><section data-copy-panel class="hall-copy-panel" hidden></section></main>`;
  if (store === authStore) mountSiteNav(root);
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const list = root.querySelector<HTMLElement>('[data-list]')!;
  const detailPanel = root.querySelector<HTMLElement>('[data-detail]')!;
  const copyPanel = root.querySelector<HTMLElement>('[data-copy-panel]')!;
  const pagination = root.querySelector<HTMLElement>('[data-pagination]')!;
  const sort = root.querySelector<HTMLSelectElement>('[data-sort]')!;
  const job = root.querySelector<HTMLSelectElement>('[data-job]')!;
  const codeInput = root.querySelector<HTMLInputElement>('[data-code-input]')!;
  let query: SharedProfileQuery = { sort: 'newest', page: 1 };
  let account = demo ? 'local-demo-viewer' : signedIn(store.getState());
  let generation = 0;
  let listSeq = 0;
  let detailSeq = 0;
  let copySeq = 0;
  let listAbort: AbortController | null = null;
  let detailAbort: AbortController | null = null;
  let page: SharedProfilePage | null = null;
  let detail: SharedProfileDetail | null = null;
  let characters: Character[] = [];
  let pendingCopy: { source: number; target: Character; requestId: string } | null = null;
  let disposed = false;
  let jobs: Record<string, string> = {};
  let jobFamilies: HallJobFamily[] = [];
  let icons: Record<string, string> = {};
  let assetsRequested = false;
  let activeFile: string = files[0][0];

  function loadAssets(): void {
    if (assetsRequested) return;
    assetsRequested = true;
    void fetch('/ke/options.json').then((response) => response.ok ? response.json() : null).then((options) => {
      if (disposed || !options) return;
      jobs = { ...(options.jobs ?? {}), ...(options.jobs_zh ?? {}) };
      jobFamilies = buildHallJobFamilies(options.jobs ?? {});
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const family of jobFamilies) {
        let group = groups.get(family.category);
        if (!group) {
          group = doc.createElement('optgroup');
          group.label = family.category;
          groups.set(family.category, group);
        }
        const option = element(doc, 'option', '', family.label);
        option.value = family.value;
        group.append(option);
      }
      job.append(...groups.values());
      renderList(); renderDetail();
    }).catch(() => undefined);
    void fetch('/ui/pticons/pticon-map.json').then((response) => response.ok ? response.json() : null).then((map) => { if (!disposed && map) { icons = map; renderList(); } }).catch(() => undefined);
  }

  function valid(token: number): boolean { return !disposed && token === generation && account !== null; }
  function clearPrivate(): void {
    generation++; listSeq++; detailSeq++; copySeq++;
    listAbort?.abort(); detailAbort?.abort();
    page = null; detail = null; characters = []; pendingCopy = null;
    list.replaceChildren(); detailPanel.replaceChildren(); detailPanel.hidden = true;
    copyPanel.replaceChildren(); copyPanel.hidden = true; pagination.replaceChildren();
  }
  function requireLogin(): void {
    clearPrivate();
    status.replaceChildren(doc.createTextNode('登录后可以浏览、点赞和复制配置。 '), button(doc, '登录账号', 'openLogin'));
  }
  function sessionError(error: unknown): boolean {
    if (error instanceof HallApiError && error.status === 401) {
      requireLogin();
      void store.refreshForVisit?.(true);
      return true;
    }
    return false;
  }
  function jobName(id: number | null): string { return id === null ? '未知职业' : (jobs[String(id)] ?? `职业 ${id}`); }
  function jobIcon(id: number | null): HTMLImageElement | null {
    const path = id === null ? null : icons[String(id)];
    if (!path) return null;
    const image = element(doc, 'img', 'hall-job-icon');
    image.src = path; image.alt = '';
    return image;
  }
  function renderList(): void {
    list.replaceChildren(); pagination.replaceChildren();
    if (!page) return;
    if (page.items.length === 0) {
      list.append(element(doc, 'p', 'hall-empty', '没有符合条件的共享配置。试试其他职业，或输入朋友的分享码。'));
      return;
    }
    const head = element(doc, 'div', 'hall-row hall-row-head');
    const headTitle = element(doc, 'span', '', '配置');
    const headUses = element(doc, 'span', 'hall-number', '使用');
    const headLikes = element(doc, 'span', 'hall-number', '点赞');
    head.append(headTitle, headUses, headLikes, element(doc, 'span', '', '操作'));
    list.append(head);
    for (const item of page.items) {
      const row = element(doc, 'article', 'hall-row hall-item');
      const info = element(doc, 'div', 'hall-item-main');
      const title = button(doc, item.title, 'detail', String(item.id));
      title.className = 'hall-title';
      if (item.is_mine) title.appendChild(element(doc, 'span', 'hall-mine-tag', '（我的分享）'));
      const description = element(doc, 'p', 'hall-description', item.description || '暂无说明');
      const meta = element(doc, 'p', 'hall-meta');
      const icon = jobIcon(item.job_id);
      if (icon) meta.append(icon);
      meta.append(doc.createTextNode(`${jobName(item.job_id)} · ${item.author.display_name} · ${item.share_code} · 更新时间 ${updateTime(item.updated_at)}`));
      info.append(title, description, meta);
      const uses = element(doc, 'span', 'hall-number', String(item.use_count)); uses.dataset.label = '使用人数';
      const likes = element(doc, 'span', 'hall-number', String(item.like_count)); likes.dataset.label = '点赞';
      const actions = element(doc, 'div', 'hall-actions');
      if (item.is_mine) {
        const manage = element(doc, 'a', 'hall-button', '我的配置');
        manage.href = editorHref; manage.dataset.manage = '';
        const withdraw = button(doc, '撤回分享', 'withdraw', String(item.id));
        withdraw.className = 'hall-quiet hall-quiet-danger';
        const code = button(doc, '分享码', 'copyCode', item.share_code);
        code.className = 'hall-quiet';
        actions.append(manage, withdraw, code);
      } else {
        const copy = button(doc, '复制配置', 'copy', String(item.id));
        copy.className = 'hall-copy';
        const like = button(doc, item.liked_by_me ? '取消赞' : '点赞', 'like', String(item.id));
        like.className = `hall-quiet${item.liked_by_me ? ' hall-quiet-liked' : ''}`;
        const code = button(doc, '分享码', 'copyCode', item.share_code);
        code.className = 'hall-quiet';
        actions.append(copy, like, code);
      }
      row.append(info, uses, likes, actions);
      list.append(row);
    }
    const totalPages = Math.ceil(page.total / 20);
    if (totalPages > 1) {
      const prev = button(doc, '上一页', 'page', String(page.page - 1)); prev.disabled = page.page <= 1;
      const next = button(doc, '下一页', 'page', String(page.page + 1)); next.disabled = page.page >= totalPages;
      pagination.append(prev, element(doc, 'span', '', `${page.page} / ${totalPages}`), next);
    }
  }
  async function loadList(afterLoadMessage?: string): Promise<void> {
    if (!account) return;
    listAbort?.abort(); listAbort = new AbortController();
    const seq = ++listSeq, token = generation;
    page = null; renderList(); status.textContent = '正在加载共享配置…';
    try {
      const result = await api.list(query, listAbort.signal);
      if (!valid(token) || seq !== listSeq) return;
      page = result; status.textContent = afterLoadMessage ?? (result.total ? `找到 ${result.total} 套共享配置` : '');
      renderList();
    } catch (error) {
      if (!valid(token) || seq !== listSeq || sessionError(error)) return;
      status.replaceChildren(doc.createTextNode(`${errorText(error)} `), button(doc, '重新加载', 'retryList'));
    }
  }
  function renderDetail(): void {
    detailPanel.replaceChildren(); detailPanel.hidden = !detail;
    if (!detail) return;
    const back = button(doc, '← 返回列表', 'closeDetail');
    back.className = 'hall-quiet';
    const head = element(doc, 'div', 'hall-detail-head');
    const icon = jobIcon(detail.job_id);
    if (icon) { icon.className = 'hall-detail-cover'; head.appendChild(icon); }
    const who = element(doc, 'div', 'hall-detail-who');
    const title = element(doc, 'h2', '', detail.title);
    const meta = element(doc, 'p', 'hall-detail-meta', `${jobName(detail.job_id)} · ${detail.author.display_name} · ${detail.share_code} · 更新时间 ${updateTime(detail.updated_at)} · 使用 ${detail.use_count} · 点赞 ${detail.like_count}`);
    who.append(title, meta);
    const actions = element(doc, 'div', 'hall-detail-acts');
    if (detail.is_mine) {
      const manage = element(doc, 'a', 'hall-button', '我的配置');
      manage.href = editorHref; manage.dataset.manage = '';
      const withdraw = button(doc, '撤回分享', 'withdraw', String(detail.id));
      withdraw.className = 'hall-quiet hall-quiet-danger';
      actions.append(manage, withdraw);
    } else {
      const copy = button(doc, '复制配置', 'copy', String(detail.id));
      copy.className = 'hall-copy';
      actions.appendChild(copy);
    }
    const linkBtn = button(doc, '复制分享链接', 'copyLink', detail.share_code);
    linkBtn.className = 'hall-button';
    actions.appendChild(linkBtn);
    head.append(who, actions);
    detailPanel.append(back, head);
    if (detail.description) detailPanel.appendChild(element(doc, 'p', 'hall-detail-desc', detail.description));
    const tabs = element(doc, 'div', 'hall-tabs');
    for (const [key, label] of files) {
      const tab = button(doc, label, 'file', key);
      tab.className = `hall-tab${key === activeFile ? ' is-active' : ''}`;
      tabs.appendChild(tab);
    }
    const current = files.find(([key]) => key === activeFile) ?? files[0];
    const code = element(doc, 'pre', 'hall-code', detail[current[0]] ?? '（无内容）');
    detailPanel.append(tabs, code);
  }
  async function openDetail(idOrCode: number | string): Promise<void> {
    if (!account) return;
    detailAbort?.abort(); detailAbort = new AbortController();
    const seq = ++detailSeq, token = generation;
    detail = null; activeFile = files[0][0]; renderDetail(); status.textContent = '正在读取配置详情…';
    try {
      const result = typeof idOrCode === 'number'
        ? await api.byId(idOrCode, detailAbort.signal)
        : await api.byCode(idOrCode, detailAbort.signal);
      if (!valid(token) || seq !== detailSeq) return;
      detail = result; status.textContent = ''; renderDetail();
      detailPanel.scrollIntoView?.({ block: 'start' });
    } catch (error) {
      if (!valid(token) || seq !== detailSeq || sessionError(error)) return;
      status.replaceChildren(doc.createTextNode(`${errorText(error)} `), button(doc, '重试查询', 'retryDetail', String(idOrCode)));
    }
  }
  function renderCopy(message = ''): void {
    copyPanel.replaceChildren(); copyPanel.hidden = false;
    copyPanel.append(element(doc, 'h2', '', '复制到我的角色'), element(doc, 'p', '', '复制后会保存为独立方案，暂不启用，也不会自动分享。'));
    if (characters.length === 0) {
      copyPanel.append(element(doc, 'p', '', '还没有绑定角色。请先用 KoreEngine 登录角色，然后刷新本页。'));
    } else {
      const label = element(doc, 'label', '', '目标角色');
      const select = element(doc, 'select'); select.dataset.copyTarget = '';
      characters.forEach((character, index) => {
        const option = element(doc, 'option', '', character.char_name);
        option.value = String(index); select.append(option);
      });
      if (pendingCopy) select.value = String(characters.findIndex((character) => character.aid === pendingCopy!.target.aid && character.cid === pendingCopy!.target.cid && character.nid === pendingCopy!.target.nid));
      label.append(select);
      const confirmBtn = button(doc, '确认复制', 'copyConfirm');
      confirmBtn.className = 'hall-copy';
      copyPanel.append(label, confirmBtn);
    }
    if (message) copyPanel.append(element(doc, 'p', 'hall-copy-message', message));
    const closeBtn = button(doc, '关闭', 'closeCopy');
    closeBtn.className = 'hall-button';
    copyPanel.append(closeBtn);
  }
  async function startCopy(source: number): Promise<void> {
    if (!account) return;
    const seq = ++copySeq, token = generation;
    pendingCopy = null; copyPanel.hidden = false;
    copyPanel.textContent = '正在读取我的角色…';
    try {
      characters = (await api.characters()).characters;
      if (!valid(token) || seq !== copySeq) return;
      pendingCopy = characters[0] ? { source, target: characters[0], requestId: crypto.randomUUID() } : null;
      renderCopy();
    } catch (error) {
      if (!valid(token) || seq !== copySeq || sessionError(error)) return;
      copyPanel.textContent = errorText(error);
      copyPanel.append(button(doc, '重试', 'copy', String(source)));
    }
  }
  async function confirmCopy(): Promise<void> {
    if (!pendingCopy || !account) return;
    const index = Number(copyPanel.querySelector<HTMLSelectElement>('[data-copy-target]')?.value ?? '0');
    const target = characters[index]; if (!target) return;
    const prior = pendingCopy;
    if (prior.target.aid !== target.aid || prior.target.cid !== target.cid || prior.target.nid !== target.nid)
      pendingCopy = { source: prior.source, target, requestId: crypto.randomUUID() };
    const operation = pendingCopy;
    const seq = ++copySeq, token = generation;
    copyPanel.querySelectorAll<HTMLButtonElement>('button').forEach((node) => { node.disabled = true; });
    try {
      const result = await api.copy(operation.source, { aid: target.aid, cid: target.cid, nid: target.nid, request_id: operation.requestId });
      if (!valid(token) || seq !== copySeq) return;
      pendingCopy = null;
      copyPanel.replaceChildren(
        element(doc, 'h2', '', demo ? '演示复制完成' : '已保存，尚未启用'),
        element(doc, 'p', '', demo
          ? `已模拟复制「${result.name}」。不会写入账号，刷新后恢复。`
          : `已复制为「${result.name}」。可前往编辑器调整，再决定是否激活。`),
      );
      const link = element(doc, 'a', 'hall-editor-link', demo ? '继续预览编辑器 →' : '去调整配置 →');
      link.dataset.openCopy = '';
      link.href = demo ? '/ke/my?demo=1' : `/ke/my?aid=${target.aid}&cid=${target.cid}&nid=${target.nid}&profile=${result.profile_id}`;
      const doneClose = button(doc, '关闭', 'closeCopy');
      doneClose.className = 'hall-button';
      copyPanel.append(link, doneClose);
      if (detail?.id === operation.source) { detail.use_count = result.use_count; renderDetail(); }
      void loadList();
    } catch (error) {
      if (!valid(token) || seq !== copySeq || sessionError(error)) return;
      if (error instanceof HallApiError && error.code === 'KE_COPY_REQUEST_CONFLICT') {
        pendingCopy = { ...pendingCopy!, requestId: crypto.randomUUID() };
      }
      renderCopy(errorText(error));
      copyPanel.querySelector<HTMLButtonElement>('[data-copy-confirm]')!.dataset.copyRetry = '';
      copyPanel.querySelector<HTMLButtonElement>('[data-copy-confirm]')!.textContent = '重试复制';
    }
  }
  function onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof (doc.defaultView?.Element ?? Element))) return;
    const control = target.closest<HTMLElement>('[data-detail],[data-copy],[data-copy-confirm],[data-code-find],[data-page],[data-like],[data-copy-code],[data-copy-link],[data-withdraw],[data-close-detail],[data-close-copy],[data-retry-list],[data-retry-detail],[data-open-login],[data-file]');
    if (!control) return;
    if (control.hasAttribute('data-file')) { activeFile = control.dataset.file ?? files[0][0]; renderDetail(); return; }
    if (control.hasAttribute('data-detail')) void openDetail(Number(control.dataset.detail));
    else if (control.hasAttribute('data-copy')) void startCopy(Number(control.dataset.copy));
    else if (control.hasAttribute('data-copy-confirm')) void confirmCopy();
    else if (control.hasAttribute('data-withdraw')) void withdrawFromHall(Number(control.dataset.withdraw), control);
    else if (control.hasAttribute('data-code-find')) {
      const code = normalizeShareCode(codeInput.value);
      if (!code) { status.textContent = '请输入格式为 ABC-1234 的分享码。'; return; }
      codeInput.value = code; void openDetail(code);
    } else if (control.hasAttribute('data-page')) { query.page = Number(control.dataset.page); void loadList(); }
    else if (control.hasAttribute('data-like')) void toggleLike(Number(control.dataset.like));
    else if (control.hasAttribute('data-copy-code')) void copyText(control.dataset.copyCode ?? '').then((ok) => { status.textContent = ok ? '分享码已复制。' : '复制失败，请手动复制分享码。'; });
    else if (control.hasAttribute('data-copy-link')) void copyText(shareLink(control.dataset.copyLink ?? '', demo)).then((ok) => { status.textContent = ok ? '分享链接已复制。' : '复制失败，请手动复制链接。'; });
    else if (control.hasAttribute('data-close-detail')) { detailSeq++; detailAbort?.abort(); detail = null; renderDetail(); }
    else if (control.hasAttribute('data-close-copy')) { copySeq++; pendingCopy = null; copyPanel.hidden = true; }
    else if (control.hasAttribute('data-retry-list')) void loadList();
    else if (control.hasAttribute('data-retry-detail')) { const value = control.dataset.retryDetail ?? ''; void openDetail(/^\d+$/.test(value) ? Number(value) : value); }
  }
  async function toggleLike(id: number): Promise<void> {
    const item = page?.items.find((entry) => entry.id === id);
    if (!item || item.is_mine) return;
    const token = generation, current = item.liked_by_me;
    try {
      const result = await api.like(id, !current);
      if (!valid(token)) return;
      item.liked_by_me = result.liked; item.like_count = result.like_count;
      if (detail?.id === id) { detail.liked_by_me = result.liked; detail.like_count = result.like_count; }
      renderList(); renderDetail();
    } catch (error) { if (!valid(token) || sessionError(error)) return; status.textContent = errorText(error); }
  }
  async function withdrawFromHall(id: number, control: HTMLElement): Promise<void> {
    if (!account || !window.confirm('撤回后，其他玩家将无法查看或复制这套配置；已复制的方案不受影响。确定撤回吗？')) return;
    const token = generation;
    if (control instanceof (doc.defaultView?.HTMLButtonElement ?? HTMLButtonElement)) control.disabled = true;
    status.textContent = '正在撤回共享配置…';
    try {
      await api.withdraw(id);
      if (!valid(token)) return;
      if (detail?.id === id) { detailSeq++; detailAbort?.abort(); detail = null; renderDetail(); }
      status.textContent = '共享配置已撤回。可以在“我的配置”中重新发布。';
      void loadList('共享配置已撤回。可以在“我的配置”中重新发布。');
    } catch (error) {
      if (!valid(token) || sessionError(error)) return;
      status.textContent = errorText(error);
    } finally {
      if (control instanceof (doc.defaultView?.HTMLButtonElement ?? HTMLButtonElement)) control.disabled = false;
    }
  }
  function onSession(state: Readonly<AuthStoreState>): void {
    const next = signedIn(state);
    if (next !== account) {
      clearPrivate(); account = next;
      if (next) {
        loadAssets(); void loadList();
        const initialCode = normalizeShareCode(new URLSearchParams(window.location.search).get('code') ?? '');
        if (initialCode) void openDetail(initialCode);
      } else requireLogin();
      return;
    }
    if (!next) requireLogin();
  }
  let unsubscribe = (): void => undefined;
  root.addEventListener('click', onClick);
  sort.addEventListener('change', () => { query = { ...query, sort: sort.value as SharedProfileQuery['sort'], page: 1 }; void loadList(); });
  job.addEventListener('change', () => {
    const family = jobFamilies.find((candidate) => candidate.value === job.value);
    query = { sort: query.sort, page: 1, ...(family ? { job_ids: family.job_ids } : {}) };
    void loadList();
  });
  codeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); root.querySelector<HTMLButtonElement>('[data-code-find]')?.click(); } });
  if (demo) {
    if (store === authStore) mountSiteNav(root);
    loadAssets(); void loadList();
    const initialCode = normalizeShareCode(new URLSearchParams(window.location.search).get('code') ?? '');
    if (initialCode) void openDetail(initialCode);
  } else {
    unsubscribe = store.subscribe(onSession);
    void store.bootstrap();
    onSession(store.getState());
    if (account) {
      loadAssets(); void loadList();
      const initialCode = normalizeShareCode(new URLSearchParams(window.location.search).get('code') ?? '');
      if (initialCode) void openDetail(initialCode);
    }
  }
  return () => { disposed = true; clearPrivate(); unsubscribe(); root.removeEventListener('click', onClick); };
}
