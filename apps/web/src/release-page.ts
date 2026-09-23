import { releaseNotes, type ReleaseNote } from './release-notes';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderReleaseEntry(note: ReleaseNote, index: number): string {
  const isCurrent = index === 0;
  const currentLabel = isCurrent ? '<span class="release-current-label">当前版本</span>' : '';
  const changes = note.changes.map((change) => `
    <li class="release-change">
      <span class="release-change-category">${escapeHtml(change.category)}</span>
      <div>
        <h3>${escapeHtml(change.title)}</h3>
        <p>${escapeHtml(change.description)}</p>
      </div>
    </li>
  `).join('');

  return `
    <article id="release-${index}" class="release-entry${isCurrent ? ' is-current' : ''}">
      <header class="release-entry-header">
        <div>
          <p class="release-entry-meta"><time datetime="${escapeHtml(note.date)}">${escapeHtml(note.date.replaceAll('-', '.'))}</time><span>版本 ${escapeHtml(note.version)}</span>${currentLabel}</p>
          <h2>${escapeHtml(note.title)}</h2>
          <p class="release-summary">${escapeHtml(note.summary)}</p>
        </div>
      </header>
      <ul class="release-change-list">${changes}</ul>
    </article>
  `;
}

function renderReleaseIndex(note: ReleaseNote, index: number): string {
  return `<a class="release-index-link${index === 0 ? ' is-current' : ''}" href="#release-${index}"><span>${escapeHtml(note.date.replaceAll('-', '.'))}</span><strong>${escapeHtml(note.title)}</strong></a>`;
}

export function mountReleasePage(root: HTMLElement): void {
  document.title = '更新说明 · 露天商店.Ro';
  const latest = releaseNotes[0]!;
  root.innerHTML = `
    <header class="site-header">
      <div class="topbar page-width">
        <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      <nav class="site-nav" aria-label="主导航"><a href="/#search">搜索市场</a><a href="/guestbook">玩家登记簿</a><a class="active" href="/updates" aria-current="page">更新说明</a><a href="https://github.com/parkerjj/LastROLTSD" target="_blank" rel="noreferrer">代码仓库</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></nav>
      </div>
    </header>
    <main class="release-main">
      <section class="release-hero page-width" aria-labelledby="release-page-title">
        <div class="release-hero-copy">
          <p class="eyebrow">露天市场 / 版本记录</p>
          <h1 id="release-page-title">更新说明</h1>
          <p class="release-hero-subtitle">记录露天商店.Ro 的每一次变化。内容按版本整理，方便你快速找到最近新增的能力。</p>
        </div>
        <div class="release-latest" aria-label="当前版本">
          <span class="release-latest-kicker">当前版本</span>
          <strong>${escapeHtml(latest.version)}</strong>
          <span>${escapeHtml(latest.date.replaceAll('-', '.'))}</span>
        </div>
      </section>
      <div class="release-layout page-width">
        <aside class="release-index" aria-label="版本目录">
          <p class="release-index-heading">版本目录</p>
          <nav>${releaseNotes.map(renderReleaseIndex).join('')}</nav>
          <a class="release-back-link" href="/#search"><span aria-hidden="true">←</span> 返回市场搜索</a>
        </aside>
        <section class="release-feed" aria-label="版本更新列表">
          ${releaseNotes.map(renderReleaseEntry).join('')}
        </section>
      </div>
    </main>
    <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>
  `;
}
