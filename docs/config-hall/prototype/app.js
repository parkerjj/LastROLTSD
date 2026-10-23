import { characters, profiles, fileNames, filesFor } from './data.js';

const main = document.querySelector('#main');
const modal = document.querySelector('#modal');
const sceneSelect = document.querySelector('#scene');
const toast = document.querySelector('#toast');
const params = new URLSearchParams(location.search);
let scene = params.get('scene') || 'hall';
let filters = { job: '', code: '', sort: 'newest' };
let currentProfile = null;
let toastTimer;
let selectedCategory = '基础';

const icons = {
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  heart: '<path d="m12 20-7.8-7.5a4.8 4.8 0 0 1 6.8-6.8l1 1 1-1a4.8 4.8 0 0 1 6.8 6.8Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = job => `/ui/pticons/icon_jobs_${job}.png`;
const codeButton = (code, extra = '') => `<button class="code-button ${extra}" data-action="copy-code" data-code="${code}" title="复制分享码 ${code}" aria-label="复制分享码 ${code}">${code}${svg('copy')}</button>`;
const closeButton = () => `<button class="close-button" data-action="close" aria-label="关闭弹窗">${svg('close')}</button>`;

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function setScene(next, fromCopy = false) {
  if (modal.open) modal.close();
  scene = next;
  sceneSelect.value = next;
  document.body.classList.toggle('editor-preview', next === 'new' || next === 'shared');
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === (['new', 'shared'].includes(next) ? 'editor' : 'hall')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  history.replaceState({}, '', `?scene=${encodeURIComponent(next)}`);
  if (next === 'new' || next === 'shared') {
    if (!fromCopy) currentProfile = next === 'shared'
      ? { ...profiles[5], shared: true }
      : { title: '猎人 · 我的练级方案', job: '猎人', jobId: 11, description: '', shared: false, map: 'pay_fild08' };
    selectedCategory = '基础';
    renderEditor();
  } else renderHall();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function likeButton(p) {
  return `<button class="like-button" data-action="like" data-id="${p.id}" aria-pressed="${p.liked}" aria-label="${p.mine ? '自己的配置不能点赞' : p.liked ? '取消点赞' : '点赞'}：${esc(p.title)}" ${p.mine ? 'disabled title="自己的配置不能点赞"' : ''}>${svg('heart')}<span>${p.likes}</span></button>`;
}

function row(p) {
  return `<article class="profile-row" aria-label="${esc(p.title)}">
    <div class="profile-main">
      <button class="profile-title" data-action="detail" data-id="${p.id}">${esc(p.title)}</button>
      <div class="mobile-meta"><img src="${icon(p.jobId)}" alt=""><span>${p.job}</span><span>·</span><span>${esc(p.author)}${p.mine ? '（我）' : ''}</span>${codeButton(p.code)}</div>
      <p class="profile-description ${p.description ? '' : 'empty'}">${p.description ? esc(p.description) : '作者还没有填写说明，可以点标题查看配置内容。'}</p>
      <div class="mobile-row-foot"><span class="usage num">${p.uses}<span class="unit">人使用</span></span>${likeButton(p)}</div>
    </div>
    <div class="identity desktop-identity"><img class="job-icon" src="${icon(p.jobId)}" alt=""><div><span class="job-name">${p.job}</span><span class="author">${esc(p.author)}${p.mine ? '（我）' : ''}</span></div></div>
    <div class="usage num desktop-usage">${p.uses}<span class="unit">人</span></div>
    <div class="num desktop-like">${likeButton(p)}</div>
    <div class="row-actions"><button class="copy-button" data-action="copy" data-id="${p.id}">${p.used ? '再次复制' : '复制到我的配置'}</button><br>${codeButton(p.code)}${p.used ? '<span class="copied-note"> · 已复制</span>' : ''}</div>
  </article>`;
}

function visibleProfiles() {
  const code = filters.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return profiles.filter(p => (!filters.job || p.jobId === Number(filters.job)) && (!code || p.code.replace('-', '') === code))
    .sort((a, b) => (filters.sort === 'uses' ? b.uses - a.uses : filters.sort === 'likes' ? b.likes - a.likes : 0) || b.date.localeCompare(a.date) || b.id - a.id);
}

function renderHall() {
  const rows = scene === 'empty' ? [] : visibleProfiles();
  const filtered = filters.job || filters.code;
  const jobs = [...new Map(profiles.map(p => [p.jobId, p.job])).entries()];
  main.innerHTML = `<section class="page-title"><div><h1>配置大厅</h1><p>找到适合自己的方案，复制后按需调整。</p></div><a class="title-link" href="?scene=shared" data-go="shared">我的配置 ${svg('arrow')}</a></section>
    <section class="filters" aria-label="查找配置">
      <label class="job-filter"><span class="field-label">按职业查找</span><select id="job-filter" aria-label="按职业查找"><option value="">全部职业</option>${jobs.map(([id, name]) => `<option value="${id}" ${filters.job === String(id) ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
      <form class="code-search" id="code-search"><label for="code-input" class="field-label">有朋友的分享码？</label><div class="search-control"><input id="code-input" placeholder="输入分享码，如 HNT-0826" aria-label="分享码" value="${esc(filters.code)}" autocomplete="off" spellcheck="false"><button type="submit" aria-label="查找分享码">${svg('search')}</button></div></form>
      <div class="sort-filter"><span class="field-label">排序</span><div class="sort-options" role="group" aria-label="配置排序">${[['newest','最新发布'],['uses','最多人用'],['likes','最多点赞']].map(([v, text]) => `<button data-sort="${v}" aria-pressed="${filters.sort === v}">${text}</button>`).join('')}</div><select id="mobile-sort" class="mobile-sort" aria-label="配置排序">${[['newest','最新发布'],['uses','最多人用'],['likes','最多点赞']].map(([v, text]) => `<option value="${v}" ${filters.sort === v ? 'selected' : ''}>${text}</option>`).join('')}</select></div>
    </section>
    <section class="list-frame" aria-label="共享配置列表">
      <div class="list-info"><span><strong>${rows.length}</strong> 套${filtered ? '匹配的' : '共享'}配置${filtered ? '<button class="clear" data-action="clear-filters">清除筛选</button>' : ''}</span><span class="list-note">先看说明，复制后再按角色调整</span></div>
      ${scene === 'login' ? '<div class="state-block"><h2>登录后，挑选玩家分享的配置</h2><p>无需验证邮箱，即可浏览、复制和点赞。</p><button class="primary" data-action="demo-login">登录账号</button></div>' : scene === 'error' ? '<div class="state-block"><h2>配置暂时没有加载出来</h2><p>请稍后重试，你已有的配置不会受到影响。</p><button class="secondary" data-action="retry">重新加载</button></div>' : rows.length ? `<div class="table-head" aria-hidden="true"><span>配置方案</span><span>职业 / 作者</span><span class="num">使用人数</span><span class="num">点赞</span><span></span></div>${rows.map(row).join('')}<div class="paging"><span>第 1–${rows.length} 条，共 ${rows.length} 条</span><div class="paging-controls"><button disabled aria-label="上一页">上一页</button><button class="page-current" aria-current="page" aria-label="第1页">1</button><button disabled aria-label="下一页">下一页</button></div></div>` : '<div class="state-block"><h2>没有找到匹配的配置</h2><p>试试其他职业，或检查分享码是否完整。</p><button class="secondary" data-action="clear-filters">查看全部配置</button></div>'}
    </section>`;
  main.querySelector('#code-search').addEventListener('submit', e => {
    e.preventDefault(); filters.code = main.querySelector('#code-input').value.trim(); renderHall();
  });
  main.querySelector('#job-filter').addEventListener('change', e => { filters.job = e.target.value; renderHall(); });
  main.querySelector('#mobile-sort').addEventListener('change', e => { filters.sort = e.target.value; renderHall(); });
}

function openDialog(html, className = '') {
  modal.className = className;
  modal.innerHTML = html;
  if (!modal.open) modal.showModal();
}

function showDetail(p) {
  const files = filesFor(p);
  openDialog(`<div class="dialog-head"><h2 id="modal-title">${esc(p.title)}</h2>${closeButton()}</div><div class="dialog-body"><div class="detail-meta"><img class="job-icon" src="${icon(p.jobId)}" alt=""><span>${p.job} · ${esc(p.author)}</span><span>${p.date} 更新</span></div><p class="detail-description">${esc(p.description || '作者没有填写说明。可以展开下方文件查看完整配置。')}</p><div class="detail-stats"><span>${p.uses} 人使用</span>${likeButton(p)}</div><div class="detail-code"><span>分享给朋友</span>${codeButton(p.code)}</div><details class="file-list"><summary>查看完整配置 <span class="optional">5 个文件</span></summary>${fileNames.map(name => `<details class="file-item"><summary>${name}</summary><pre>${esc(files[name])}</pre></details>`).join('')}</details></div><div class="dialog-foot"><button class="secondary" data-action="copy-link" data-id="${p.id}">复制分享链接</button><button class="primary" data-action="copy" data-id="${p.id}">复制到我的配置</button></div>`, 'detail-dialog');
}

function showCopy(p) {
  openDialog(`<div class="dialog-head"><h2 id="modal-title">复制到我的配置</h2>${closeButton()}</div><div class="dialog-body"><p class="dialog-caption">保存为一套新方案，原有配置不会被覆盖。</p><div class="copy-source"><strong>${esc(p.title)}</strong><span>${p.job} · ${esc(p.author)} · ${p.code}</span></div><span class="dialog-label" id="character-label">给哪个角色使用？</span><div role="radiogroup" aria-labelledby="character-label">${characters.map((c, i) => `<label class="character-option"><input type="radio" name="target-character" value="${c.id}" ${i === 0 ? 'checked' : ''}><img class="job-icon" src="${icon(c.jobId)}" alt=""><span><strong>${c.name}</strong><span class="character-meta">${c.job}</span></span><span class="character-count">已有 ${c.profiles} 套方案</span></label>`).join('')}</div><p class="dialog-note">复制后先保存，暂不启用。你可以再调整技能、地图和补给。</p></div><div class="dialog-foot"><button class="secondary" data-action="close">取消</button><button class="primary" data-action="confirm-copy" data-id="${p.id}">确认复制</button></div>`);
}

function confirmCopy(p) {
  const target = characters.find(c => c.id === modal.querySelector('[name="target-character"]:checked').value);
  if (!p.used && !p.mine) p.uses += 1;
  p.used = true;
  target.profiles += 1;
  currentProfile = { ...p, job: target.job, jobId: target.jobId, character: target.name, shared: false, code: null };
  renderHall();
  openDialog(`<div class="dialog-head"><h2 id="modal-title">已复制到 ${target.name}</h2>${closeButton()}</div><div class="dialog-body"><div class="success-mark">${svg('check')}<span>已保存，尚未启用</span></div><p class="success-name">${esc(p.title)}</p><p class="dialog-caption">现在可以到“我的配置”里调整，然后手动启用。作者后续更新不会改变你的这套配置。</p><p class="dialog-note">这是交互预览，未写入实际账号。</p></div><div class="dialog-foot"><button class="secondary" data-action="close">继续浏览</button><button class="primary" data-action="edit-copy">去调整配置 ${svg('arrow')}</button></div>`);
}

const categories = {
  '基础': { caption: '决定角色在哪里挂机、怎么走路。', fields: '<label><span class="field-label">挂机地图</span><input value="pay_fild08"><p>填写地图代码，如 pay_fild08。</p></label><label><span class="field-label">回城地图</span><input value="payon"></label><label><span class="field-label">移动方式</span><select><option>步行寻路</option><option>使用瞬移</option></select></label>' },
  '战斗': { caption: '设置战斗方式与选怪规则。', fields: '<label><span class="field-label">攻击方式</span><select><option>主动攻击范围内的怪物</option><option>仅反击</option></select></label><label><span class="field-label">主要技能</span><input value="二连矢"></label><label><span class="field-label">技能等级</span><input type="number" min="1" max="10" value="10"></label>' },
  '补给': { caption: '设置回城与药水、箭矢补给。', fields: '<label><span class="field-label">补给物品</span><input value="红色药水"></label><label><span class="field-label">低于此数量时回城</span><input type="number" min="0" value="20"></label><label><span class="field-label">补充到此数量</span><input type="number" min="0" value="100"></label>' },
};

function renderEditor() {
  const p = currentProfile;
  const c = categories[selectedCategory];
  main.innerHTML = `<section class="page-title editor-title"><div><a class="back-link" href="?scene=hall" data-go="hall">${svg('back')}配置大厅</a><h1>编辑配置</h1><div class="character-line"><img src="${icon(p.jobId)}" alt=""><span>${esc(p.character || '波利猎人')} · ${p.job}</span></div></div><a class="title-link" href="?scene=hall" data-go="hall">浏览共享方案 ${svg('arrow')}</a></section>
    <section class="editor-frame" aria-label="配置编辑器">
      <div class="editor-name-row"><label><span class="field-label">方案名称</span><input id="profile-name" value="${esc(p.title)}" maxlength="64"></label><span class="draft-note">修改后记得保存</span></div>
      <div class="editor-body"><nav class="config-nav" aria-label="配置分区">${Object.keys(categories).map(name => `<button data-category="${name}" aria-pressed="${name === selectedCategory}">${name}</button>`).join('')}</nav>
      <section class="config-panel"><h2>${selectedCategory}</h2><p>${c.caption}</p><div class="config-fields">${c.fields}</div></section>
      <aside class="share-area" aria-label="共享设置"><label class="share-toggle"><input type="checkbox" id="share-checkbox" checked><span id="share-label">${p.shared ? '同时更新共享的配置' : '同时将此配置共享给他人'}</span></label><p class="share-intro">让其他玩家也能使用你的方案。勾选后保存，完整配置将出现在配置大厅。</p><div id="share-description-wrap"><label for="share-description" class="field-label">配置说明<span class="optional">选填</span></label><textarea id="share-description" rows="4" placeholder="适合什么场景？需要哪些技能或补给？留几句话，方便其他玩家上手。">${esc(p.shared ? p.description : '')}</textarea></div><p class="share-result" id="share-result">${p.shared ? '本次保存会同时更新大厅里的版本，分享码不变。' : p.withdrawn ? '已撤回，勾选保存后重新发布，沿用原分享码。' : '标题沿用方案名称，保存后生成分享码。'}</p>${p.code ? `<div class="existing-code"><span>原分享码</span>${codeButton(p.code)}</div>${p.shared ? '<button class="withdraw" data-action="withdraw">撤回分享</button>' : ''}` : ''}</aside></div>
      <div class="editor-foot"><span class="save-caption" id="save-caption">${p.shared ? '个人修改与共享版本一起保存' : '个人配置与首次分享一起保存'}</span><button class="secondary" data-go="hall">取消</button><button class="primary" data-action="save-profile" id="save-profile">${p.shared ? '保存并更新共享' : '保存并分享'}</button></div>
    </section><p class="editor-help">这里仅预览原编辑器的基础、战斗和补给分区，以及新增的分享区域。</p>`;
  main.querySelector('#share-checkbox').addEventListener('change', e => {
    const enabled = e.target.checked;
    main.querySelector('#share-description-wrap').hidden = !enabled;
    main.querySelector('#share-result').textContent = enabled ? p.shared ? '本次保存会同时更新大厅里的版本，分享码不变。' : p.withdrawn ? '已撤回，勾选保存后重新发布，沿用原分享码。' : '标题沿用方案名称，保存后生成分享码。' : p.shared ? '本次只保存个人配置，大厅里的共享版本保持不变。' : '本次只保存个人配置，不会发布到大厅。';
    main.querySelector('#save-profile').textContent = enabled ? p.shared ? '保存并更新共享' : '保存并分享' : '保存方案';
    main.querySelector('#save-caption').textContent = enabled ? p.shared ? '个人修改与共享版本一起保存' : '个人配置与分享一起保存' : '仅保存到自己的配置';
  });
}

function saveProfile() {
  const name = main.querySelector('#profile-name');
  if (!name.value.trim()) { name.setCustomValidity('请填写方案名称'); name.reportValidity(); return; }
  name.setCustomValidity('');
  currentProfile.title = name.value.trim();
  const sharing = main.querySelector('#share-checkbox').checked;
  const wasShared = currentProfile.shared;
  if (sharing) {
    currentProfile.description = main.querySelector('#share-description').value;
    currentProfile.shared = true;
    currentProfile.withdrawn = false;
    currentProfile.code ||= 'NEW-1023';
  }
  notify(sharing ? `${wasShared ? '已保存并更新共享' : '已保存并分享'} · ${currentProfile.code}（预览）` : '已保存个人配置（预览）');
  renderEditor();
  main.querySelector('#share-checkbox').checked = sharing;
  main.querySelector('#share-checkbox').dispatchEvent(new Event('change'));
}

document.addEventListener('click', async e => {
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); setScene(go.dataset.go); return; }
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); setScene(nav.dataset.nav === 'hall' ? 'hall' : 'shared'); return; }
  const sort = e.target.closest('[data-sort]');
  if (sort) { filters.sort = sort.dataset.sort; renderHall(); main.querySelector(`[data-sort="${filters.sort}"]`).focus({ preventScroll: true }); return; }
  const category = e.target.closest('[data-category]');
  if (category) {
    currentProfile.title = main.querySelector('#profile-name').value;
    const shareEnabled = main.querySelector('#share-checkbox').checked;
    const description = main.querySelector('#share-description').value;
    selectedCategory = category.dataset.category; renderEditor();
    main.querySelector('#share-description').value = description;
    main.querySelector('#share-checkbox').checked = shareEnabled;
    main.querySelector('#share-checkbox').dispatchEvent(new Event('change'));
    return;
  }
  const b = e.target.closest('[data-action]');
  if (!b || b.disabled) return;
  const p = profiles.find(p => p.id === Number(b.dataset.id));
  switch (b.dataset.action) {
    case 'close': modal.close(); break;
    case 'detail': showDetail(p); break;
    case 'copy': showCopy(p); break;
    case 'confirm-copy': confirmCopy(p); break;
    case 'edit-copy': setScene('new', true); break;
    case 'like': {
      if (p.mine) return;
      p.liked = !p.liked; p.likes += p.liked ? 1 : -1;
      const inDialog = modal.contains(b);
      renderHall();
      if (inDialog) { showDetail(p); modal.querySelector('[data-action="like"]').focus({ preventScroll: true }); }
      else [...main.querySelectorAll(`[data-action="like"][data-id="${p.id}"]`)].find(button => button.offsetParent !== null)?.focus({ preventScroll: true });
      break;
    }
    case 'copy-code':
    case 'copy-link': {
      const value = b.dataset.action === 'copy-code' ? b.dataset.code : `${location.origin}/?scene=hall&code=${p.code}`;
      try { await navigator.clipboard.writeText(value); notify(b.dataset.action === 'copy-code' ? `分享码 ${value} 已复制` : '预览分享链接已复制'); }
      catch { notify(`分享码：${b.dataset.code || p.code}`); }
      break;
    }
    case 'clear-filters': filters = { job: '', code: '', sort: 'newest' }; setScene('hall'); break;
    case 'retry':
    case 'demo-login': setScene('hall'); notify(b.dataset.action === 'demo-login' ? '已切换到登录后的预览' : '示例配置已加载'); break;
    case 'save-profile': saveProfile(); break;
    case 'withdraw': openDialog(`<div class="dialog-head"><h2 id="modal-title">撤回这套配置的分享？</h2>${closeButton()}</div><div class="dialog-body"><p class="success-name">${esc(currentProfile.title)}</p><p class="dialog-caption">配置将从大厅移除。已经复制给别人的配置会保留，你自己的配置也不会被删除。</p><p class="dialog-note">以后勾选分享并保存，可以用原分享码重新发布。</p></div><div class="dialog-foot"><button class="secondary" data-action="close">暂不撤回</button><button class="primary" data-action="confirm-withdraw">确认撤回</button></div>`); break;
    case 'confirm-withdraw': currentProfile.shared = false; currentProfile.withdrawn = true; modal.close(); renderEditor(); notify('共享已撤回（预览）'); break;
  }
});
sceneSelect.addEventListener('change', e => { filters = { job: '', code: '', sort: 'newest' }; setScene(e.target.value); });
modal.addEventListener('click', e => { if (e.target === modal) { const r = modal.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) modal.close(); } });
if (params.get('code')) filters.code = params.get('code');
setScene(scene);
if (params.get('dialog') === 'copy') showCopy(profiles[0]);
if (params.get('dialog') === 'detail') showDetail(profiles[0]);
