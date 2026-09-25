import { MarketApi, type MarketApiClient } from "./api";
import { siteNavMarkup, mountSiteNav } from "./nav";
import type { LastroAccountData } from "./types";
import { openGamePopup, startPopupHandshake } from "./game-launch";
import { AnalyticsEvent, track } from "./analytics";

const STORAGE_KEY = "lastro.accounts.v1";
const LAUNCH_POPUP_KEY = "lastro.launch.popup.v1";
const PLAY_PAGE_URL = "/play";
const STALE_AFTER_MS = 5 * 60 * 1000;
const DELETE_ARM_MS = 3000;

export interface StoredAccount {
  id: string;
  password: string;
  label?: string;
  addedAt: number;
}

interface AccountsPageOptions {
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
}

type CardStatus =
  | "loading"
  | "online"
  | "dead"
  | "offline"
  | "auth_failed"
  | "error";

interface AccountRow {
  account: StoredAccount;
  status: CardStatus;
  data?: LastroAccountData | undefined;
  error?: string | undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const numberFormatter = new Intl.NumberFormat("zh-CN");
function formatNumber(value: unknown): string {
  return numberFormatter.format(toFiniteNumber(value, 0));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function parseApiTimestamp(value: unknown): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    String(value ?? ""),
  );
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const dayNumber = Number(day);
  const monthNumber = Number(month);
  const maxDay =
    monthNumber >= 1 && monthNumber <= 12
      ? new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate()
      : 0;
  if (
    dayNumber < 1 ||
    dayNumber > maxDay ||
    Number(hour) > 23 ||
    Number(minute) > 59
  )
    return null;
  return Date.UTC(
    Number(year),
    monthNumber - 1,
    dayNumber,
    Number(hour) - 8,
    Number(minute),
    0,
    0,
  );
}

function formatServerTime(timestamp: number): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatRelativeTime(timestamp: number, nowMs: number): string {
  if (!timestamp) return "等待数据";
  const minutes = Math.max(0, Math.floor((nowMs - timestamp) / 60000));
  if (minutes < 1) return "1 分钟内";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

const STATUS_META: Record<CardStatus, { label: string; className: string }> = {
  loading: { label: "查询中", className: "wait" },
  online: { label: "运行中", className: "good" },
  dead: { label: "已死亡", className: "bad" },
  offline: { label: "已离线", className: "idle" },
  auth_failed: { label: "密码错误", className: "bad" },
  error: { label: "查询失败", className: "bad" },
};

export function loadStoredAccounts(
  storage: Pick<Storage, "getItem" | "setItem">,
): StoredAccount[] {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is StoredAccount =>
      Boolean(
        entry &&
        typeof entry === "object" &&
        typeof (entry as StoredAccount).id === "string" &&
        (entry as StoredAccount).id.length > 0 &&
        typeof (entry as StoredAccount).password === "string" &&
        (entry as StoredAccount).password.length > 0 &&
        ((entry as StoredAccount).label === undefined ||
          typeof (entry as StoredAccount).label === "string") &&
        typeof (entry as StoredAccount).addedAt === "number",
      ),
    );
  } catch {
    return [];
  }
}

function persistAccounts(
  storage: Pick<Storage, "getItem" | "setItem">,
  accounts: StoredAccount[],
): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(accounts));
    return true;
  } catch {
    return false;
  }
}

export function mountAccountsPage(
  root: HTMLElement,
  api: MarketApiClient = new MarketApi(),
  options: AccountsPageOptions = {},
): void {
  document.title = "菜农监控台 · 露天商店.Ro";
  const storage = options.storage ?? window.localStorage;
  const now = options.now ?? Date.now;

  root.innerHTML = `
    <header class="site-header"><div class="topbar page-width">
      <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup("accounts")}
    </div></header>
    <main class="accounts-main page-width">
      <section class="accounts-hero">
        <div class="accounts-hero-copy">
          <p class="eyebrow">LastRO 角色监控</p>
          <h1>菜农监控台</h1>
          <p>把游戏账号添加到这里，随时查看角色等级、经验进度、所在地图和在线状态。</p>
        </div>
        <div class="accounts-launchers" aria-label="游戏客户端入口">
          <button class="accounts-launch accounts-launch--primary" type="button" id="accounts-launch-v1"><i class="ph ph-play" aria-hidden="true"></i>启动稳定版 V1</button>
          <button class="accounts-launch accounts-launch--disabled" type="button" disabled><i class="ph ph-play" aria-hidden="true"></i>测试版 V2<span class="accounts-launch-tag">尚未开放</span></button>
          <label class="accounts-launch-option" title="勾选后以独立全屏窗口启动；默认在新标签页内启动，兼容性更好">
            <input type="checkbox" id="accounts-launch-popup" />
            <span>以全屏新窗口打开</span>
          </label>
        </div>
      </section>

      <section class="accounts-privacy" aria-labelledby="accounts-privacy-title">
        <span class="accounts-privacy-icon" aria-hidden="true"><i class="ph ph-shield-check"></i></span>
        <div class="accounts-privacy-body">
          <h2 id="accounts-privacy-title">开始之前，请先了解你的密码会如何被处理</h2>
          <ul>
            <li><strong>密码只保存在你自己的浏览器里。</strong>添加的账号和密码存放在这台设备的浏览器存储中，不会保存到我们的服务器上；换一台设备、或清理浏览器数据后，需要重新添加。</li>
            <li><strong>查询时需要本站帮你「转发」一次。</strong>由于 LastRO 官方网站的设置限制，浏览器无法直接连接LRO服务器(技术名词CORS跨域限制)。每次查询时，本站服务器会替你把账号密码转发到LRO服务器，拿到结果后直接返回，整个过程不会做任何记录。如果对此有顾虑，可以不使用本功能或安装油猴脚本。</li>
            <li><strong>不想经过本站中转？可以装油猴脚本。</strong>安装 Tampermonkey（油猴）浏览器扩展和直连脚本后，查询会由你的浏览器直接发给 LastRO 官方服务器，不再经过本站。<a class="accounts-script-link" href="/lastro-direct.user.js" target="_blank" rel="noreferrer">安装直连脚本<i class="ph ph-arrow-square-out" aria-hidden="true"></i></a>（需先安装 Tampermonkey 扩展）</li>
            <li><strong>网站代码完全公开。</strong>本站所有源代码都在 GitHub 上开放，欢迎随时监督、查看我们是如何处理你的数据的。</li>
          </ul>
          <a class="accounts-github" href="https://github.com/parkerjj/LastROLTSD" target="_blank" rel="noreferrer"><i class="ph ph-github-logo" aria-hidden="true"></i>在 GitHub 查看源代码</a>
        </div>
      </section>

      <section class="accounts-panel" aria-labelledby="accounts-title">
        <div class="section-heading accounts-heading">
          <div><p class="eyebrow">我的账号</p><h2 id="accounts-title">账号列表</h2></div>
          <div class="accounts-toolbar">
            <span id="accounts-summary" class="accounts-summary">共 0 个账号</span>
            <button type="button" id="accounts-refresh-all" class="secondary-button"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 全部刷新</button>
            <button type="button" id="accounts-add"><i class="ph ph-plus" aria-hidden="true"></i> 添加账号</button>
          </div>
        </div>
        <div id="accounts-grid" class="accounts-grid" aria-live="polite"></div>
        <div id="accounts-empty" class="accounts-empty" hidden>
          <i class="ph ph-user-plus" aria-hidden="true"></i>
          <h3>还没有添加账号</h3>
          <p>账号只保存在你自己的浏览器中。添加之后，就能随时查看角色等级、经验进度、所在地图和在线状态。</p>
          <button type="button" data-open-modal><i class="ph ph-plus" aria-hidden="true"></i> 添加第一个账号</button>
        </div>
        <p id="accounts-status" class="accounts-status" role="status" aria-live="polite"></p>
      </section>
    </main>
    <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/accounts">菜农监控台</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>

    <div class="account-modal-overlay" id="account-modal" hidden>
      <div class="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-modal-title">
        <h2 id="account-modal-title">添加账号</h2>
        <p class="account-modal-hint">输入 LastRO 游戏账号和密码。账号信息只会保存在当前浏览器中。</p>
        <form id="account-form" novalidate>
          <label for="account-label">名称<span class="account-field-hint">可选，方便你区分多个账号</span><input id="account-label" autocomplete="off" maxlength="24" placeholder="例如：主号 · 商人" /></label>
          <label for="account-userid">游戏账号<input id="account-userid" autocomplete="off" maxlength="64" placeholder="例如 game123" /></label>
          <label for="account-password">游戏密码<input id="account-password" type="password" autocomplete="off" maxlength="64" placeholder="游戏登录密码" /></label>
          <p id="account-modal-status" class="account-modal-status" role="status" aria-live="polite"></p>
          <div class="account-modal-actions">
            <button type="button" id="account-test" class="secondary-button">测试连接</button>
            <span class="account-modal-spacer"></span>
            <button type="button" id="account-cancel" class="secondary-button">取消</button>
            <button type="submit" id="account-save">保存账号</button>
          </div>
        </form>
      </div>
    </div>`;

  mountSiteNav(root);

  const grid = root.querySelector<HTMLElement>("#accounts-grid")!;
  const emptyState = root.querySelector<HTMLElement>("#accounts-empty")!;
  const summary = root.querySelector<HTMLElement>("#accounts-summary")!;
  const statusLine = root.querySelector<HTMLElement>("#accounts-status")!;
  const refreshAllButton = root.querySelector<HTMLButtonElement>(
    "#accounts-refresh-all",
  )!;
  const addButton = root.querySelector<HTMLButtonElement>("#accounts-add")!;
  const launchV1Button = root.querySelector<HTMLButtonElement>(
    "#accounts-launch-v1",
  )!;
  const launchPopupToggle = root.querySelector<HTMLInputElement>(
    "#accounts-launch-popup",
  )!;
  const modal = root.querySelector<HTMLElement>("#account-modal")!;
  const form = root.querySelector<HTMLFormElement>("#account-form")!;
  const useridInput = root.querySelector<HTMLInputElement>("#account-userid")!;
  const passwordInput =
    root.querySelector<HTMLInputElement>("#account-password")!;
  const labelInput = root.querySelector<HTMLInputElement>("#account-label")!;
  const modalStatus = root.querySelector<HTMLElement>("#account-modal-status")!;
  const testButton = root.querySelector<HTMLButtonElement>("#account-test")!;
  const cancelButton =
    root.querySelector<HTMLButtonElement>("#account-cancel")!;
  const saveButton = root.querySelector<HTMLButtonElement>("#account-save")!;

  let accounts = loadStoredAccounts(storage);
  let rows: AccountRow[] = accounts.map((account) => ({
    account,
    status: "loading" as const,
  }));
  const inflight = new Set<string>();
  let armedDeleteId: string | null = null;
  let armedDeleteTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFocused: HTMLElement | null = null;

  function cardBodyMarkup(row: AccountRow): string {
    if (row.status === "loading") {
      return '<p class="acc-note"><span class="account-spinner" aria-hidden="true"></span>正在查询角色状态…</p>';
    }
    if (row.status === "offline") {
      return '<p class="acc-note"><i class="ph ph-moon" aria-hidden="true"></i>角色当前不在线。上线后再刷新，就能看到等级、经验和所在地图。</p>';
    }
    if (row.status === "auth_failed") {
      return '<p class="acc-note acc-note--warn"><i class="ph ph-warning" aria-hidden="true"></i>账号或密码不正确，官方服务器拒绝了查询。请删除后重新添加。</p>';
    }
    if (row.status === "error") {
      return `<p class="acc-note acc-note--warn"><i class="ph ph-warning" aria-hidden="true"></i>${escapeHtml(row.error || "查询失败，请稍后重试")}</p>`;
    }
    const data = row.data ?? {};
    const hp = Math.max(0, toFiniteNumber(data.hp, 0));
    const maxHp = Math.max(0, toFiniteNumber(data.max_hp, 0));
    const sp = Math.max(0, toFiniteNumber(data.sp, 0));
    const maxSp = Math.max(0, toFiniteNumber(data.max_sp, 0));
    const baseExp = Math.max(0, toFiniteNumber(data.base_exp, 0));
    const nextBaseExp = Math.max(0, toFiniteNumber(data.nextbaseexp, 0));
    const expPercent =
      nextBaseExp > 0
        ? Math.min(100, Math.round((baseExp / nextBaseExp) * 1000) / 10)
        : 0;
    const jobExp = Math.max(0, toFiniteNumber(data.job_exp, 0));
    const nextJobExp = Math.max(0, toFiniteNumber(data.nextjobexp, 0));
    const jobExpPercent =
      nextJobExp > 0
        ? Math.min(100, Math.round((jobExp / nextJobExp) * 1000) / 10)
        : 0;
    const weight = Math.max(0, toFiniteNumber(data.weight, 0));
    const maxWeight = Math.max(0, toFiniteNumber(data.maxweight, 0));
    const weightPercent =
      maxWeight > 0 ? Math.min(100, (weight / maxWeight) * 100) : 0;
    const onlineMinutes =
      typeof data.inminute === "string" ? data.inminute.trim() : "";
    const baseExpGain = toFiniteNumber(data.changebexp, 0);
    const jobExpGain = toFiniteNumber(data.changejexp, 0);
    const hpPercent = maxHp > 0 ? Math.min(100, (hp / maxHp) * 100) : 0;
    const spPercent = maxSp > 0 ? Math.min(100, (sp / maxSp) * 100) : 0;
    const gains =
      baseExpGain !== 0 || jobExpGain !== 0
        ? `<p class="account-gains">经验变化 B ${baseExpGain >= 0 ? "+" : ""}${formatNumber(baseExpGain)} · J ${jobExpGain >= 0 ? "+" : ""}${formatNumber(jobExpGain)}</p>`
        : "";
    return `
      <div class="acc-hero"><span class="acc-char">${escapeHtml(String(data.name ?? "未命名角色"))}</span><div class="acc-levels"><div class="acc-level"><b>${toFiniteNumber(data.base_level, 0)}</b><span>BASE</span></div><div class="acc-level"><b>${toFiniteNumber(data.job_level, 0)}</b><span>JOB</span></div></div></div>
      <div class="acc-gauges">
        <div class="gauge"><span class="gauge-label">HP</span><span class="gauge-track" role="progressbar" aria-label="HP" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${hpPercent.toFixed(1)}"><i class="gauge-fill gauge-fill--hp" style="width:${hpPercent}%"></i></span><span class="gauge-value">${formatNumber(hp)} <em>/ ${formatNumber(maxHp)}</em></span></div>
        <div class="gauge"><span class="gauge-label">SP</span><span class="gauge-track" role="progressbar" aria-label="SP" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${spPercent.toFixed(1)}"><i class="gauge-fill gauge-fill--sp" style="width:${spPercent}%"></i></span><span class="gauge-value">${formatNumber(sp)} <em>/ ${formatNumber(maxSp)}</em></span></div>
        <div class="gauge"><span class="gauge-label">BASE 经验</span><span class="gauge-track" role="progressbar" aria-label="Base 经验进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${expPercent}"><i class="gauge-fill gauge-fill--bexp" style="width:${expPercent}%"></i></span><span class="gauge-value">${expPercent.toFixed(1)}%</span></div>
        <div class="gauge"><span class="gauge-label">JOB 经验</span><span class="gauge-track" role="progressbar" aria-label="Job 经验进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${jobExpPercent}"><i class="gauge-fill gauge-fill--jexp" style="width:${jobExpPercent}%"></i></span><span class="gauge-value">${jobExpPercent.toFixed(1)}%</span></div>
        ${maxWeight > 0 ? `<div class="gauge"><span class="gauge-label">负重</span><span class="gauge-track" role="progressbar" aria-label="负重" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${weightPercent.toFixed(1)}"><i class="gauge-fill gauge-fill--weight${weightPercent >= 90 ? " is-heavy" : ""}" style="width:${weightPercent}%"></i></span><span class="gauge-value">${weightPercent.toFixed(1)}%</span></div>` : ""}
      </div>
      <hr class="acc-divider">
      <div class="acc-chips">
        ${onlineMinutes ? `<span class="chip"><i class="ph ph-timer" aria-hidden="true"></i>在线 ${escapeHtml(onlineMinutes)}</span>` : ""}
        ${baseExpGain !== 0 || jobExpGain !== 0 ? `<span class="chip chip--gain"><i class="ph ph-trend-up" aria-hidden="true"></i>B ${baseExpGain >= 0 ? "+" : ""}${formatNumber(baseExpGain)} · J ${jobExpGain >= 0 ? "+" : ""}${formatNumber(jobExpGain)}</span>` : ""}
        <span class="chip chip--map"><i class="ph ph-map-pin" aria-hidden="true"></i>${escapeHtml(String(data.last_map ?? "—"))}</span>
        <span class="chip">战斗 ${toFiniteNumber(data.autoattack, 0) ? "开" : "关"} · 拾取 ${toFiniteNumber(data.autoloot, 0) ? "开" : "关"}</span>
      </div>`;
  }

  function cardMarkup(row: AccountRow): string {
    const meta = STATUS_META[row.status];
    const busy = inflight.has(row.account.id);
    const updatedAt = row.data ? parseApiTimestamp(row.data.updatetime) : null;
    const isStale = updatedAt !== null && now() - updatedAt > STALE_AFTER_MS;
    const updatedMarkup =
      updatedAt !== null
        ? `<span class="account-updated">${escapeHtml(formatRelativeTime(updatedAt, now()))} <small>${escapeHtml(formatServerTime(updatedAt))}</small>${isStale ? '<small class="account-stale">数据较旧</small>' : ""}</span>`
        : '<span class="account-updated">等待数据</span>';
    const armed = armedDeleteId === row.account.id;
    const title = row.account.label
      ? escapeHtml(row.account.label)
      : escapeHtml(row.account.id);
    const subtitle = row.account.label
      ? `<small>${escapeHtml(row.account.id)}</small>`
      : "";
    return `<article class="account-card account-card--${meta.className}" data-account-card="${escapeHtml(row.account.id)}">
      <div class="acc-inner">
        <header class="acc-head"><div class="acc-who"><span class="acc-label">${title}</span><span class="acc-id">${subtitle}</span></div><span class="acc-stamp acc-stamp--${meta.className}"><i></i>${meta.label}</span></header>
        <div class="acc-body">${cardBodyMarkup(row)}</div>
      </div>
      <footer class="acc-foot">${updatedMarkup}<span class="acc-actions">
        <button type="button" class="acc-btn" data-refresh="${escapeHtml(row.account.id)}" ${busy ? "disabled" : ""} aria-label="刷新账号 ${escapeHtml(row.account.id)}" title="刷新"><i class="ph ${busy ? "ph-circle-notch account-spin" : "ph-arrows-clockwise"}" aria-hidden="true"></i></button>
        <button type="button" class="acc-btn acc-btn--danger${armed ? " is-armed" : ""}" data-delete="${escapeHtml(row.account.id)}" aria-label="删除账号 ${escapeHtml(row.account.id)}" title="删除">${armed ? "确认删除？" : '<i class="ph ph-trash" aria-hidden="true"></i>'}</button>
      </span></footer>
    </article>`;
  }

  function renderAll(): void {
    grid.innerHTML = rows.map(cardMarkup).join("");
    emptyState.hidden = accounts.length > 0;
    grid.hidden = accounts.length === 0;
    const running = rows.filter((row) => row.status === "online").length;
    const attention = rows.filter(
      (row) =>
        row.status === "dead" ||
        row.status === "auth_failed" ||
        row.status === "error",
    ).length;
    summary.textContent =
      accounts.length === 0
        ? "共 0 个账号"
        : `共 ${accounts.length} 个账号 · 运行中 ${running} · 需处理 ${attention}`;
    refreshAllButton.disabled = accounts.length === 0 || inflight.size > 0;
  }

  async function fetchAccount(account: StoredAccount): Promise<void> {
    if (inflight.has(account.id)) return;
    inflight.add(account.id);
    const row = rows.find((entry) => entry.account.id === account.id);
    if (row) {
      row.status = "loading";
      row.data = undefined;
      row.error = undefined;
    }
    renderAll();
    try {
      const result = await api.getAccountStatus(account.id, account.password);
      const target = rows.find((entry) => entry.account.id === account.id);
      if (target) {
        if (result.state === "offline") {
          target.status = "offline";
          target.data = undefined;
        } else if (result.state === "auth_failed") {
          target.status = "auth_failed";
          target.data = undefined;
        } else {
          target.data = result.data;
          target.status =
            Math.max(0, toFiniteNumber(result.data?.hp, 0)) <= 0
              ? "dead"
              : "online";
        }
        target.error = undefined;
      }
    } catch (error) {
      const target = rows.find((entry) => entry.account.id === account.id);
      if (target) {
        target.status = "error";
        target.error =
          error instanceof Error ? error.message : "查询失败，请稍后重试";
      }
    } finally {
      inflight.delete(account.id);
      renderAll();
    }
  }

  async function refreshAll(): Promise<void> {
    statusLine.textContent = `正在查询 ${accounts.length} 个账号…`;
    await Promise.all(accounts.map((account) => fetchAccount(account)));
    statusLine.textContent = `最近刷新 ${new Date(now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }

  function openModal(): void {
    const active = document.activeElement;
    lastFocused =
      active && typeof (active as HTMLElement).focus === "function"
        ? (active as HTMLElement)
        : null;
    modal.hidden = false;
    modalStatus.textContent = "";
    modalStatus.className = "account-modal-status";
    useridInput.focus();
  }

  function closeModal(): void {
    modal.hidden = true;
    form.reset();
    modalStatus.textContent = "";
    testButton.disabled = false;
    saveButton.disabled = false;
    lastFocused?.focus();
  }

  function setModalBusy(busy: boolean): void {
    testButton.disabled = busy;
    saveButton.disabled = busy;
    cancelButton.disabled = busy;
  }

  testButton.addEventListener("click", async () => {
    const userid = useridInput.value.trim();
    const password = passwordInput.value;
    if (!userid || !password) {
      modalStatus.textContent = "请先填写账号和密码。";
      modalStatus.className = "account-modal-status is-error";
      return;
    }
    setModalBusy(true);
    modalStatus.textContent = "正在连接官方服务器测试…";
    modalStatus.className = "account-modal-status";
    try {
      const result = await api.getAccountStatus(userid, password);
      if (result.state === "auth_failed") {
        modalStatus.textContent = "账号或密码不正确，请检查后再试。";
        modalStatus.className = "account-modal-status is-error";
      } else if (result.state === "offline") {
        modalStatus.textContent = "连接成功！账号密码正确，角色当前不在线。";
        modalStatus.className = "account-modal-status is-ok";
      } else {
        const name =
          typeof result.data?.name === "string" && result.data.name
            ? `「${result.data.name}」`
            : "";
        modalStatus.textContent = `连接成功！已读取到角色 ${name} 的状态。`;
        modalStatus.className = "account-modal-status is-ok";
      }
    } catch (error) {
      modalStatus.textContent =
        error instanceof Error ? error.message : "测试失败，请稍后重试。";
      modalStatus.className = "account-modal-status is-error";
    } finally {
      setModalBusy(false);
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const userid = useridInput.value.trim();
    const password = passwordInput.value;
    if (!userid || !password) {
      modalStatus.textContent = "请先填写账号和密码。";
      modalStatus.className = "account-modal-status is-error";
      return;
    }
    if (accounts.some((account) => account.id === userid)) {
      modalStatus.textContent = "这个账号已经添加过了。";
      modalStatus.className = "account-modal-status is-error";
      return;
    }
    const account: StoredAccount = {
      id: userid,
      password,
      addedAt: now(),
      ...(labelInput.value.trim() ? { label: labelInput.value.trim() } : {}),
    };
    const nextAccounts = [...accounts, account];
    if (!persistAccounts(storage, nextAccounts)) {
      modalStatus.textContent =
        "浏览器存储不可用，无法保存账号。请检查浏览器设置。";
      modalStatus.className = "account-modal-status is-error";
      return;
    }
    accounts = nextAccounts;
    rows = [...rows, { account, status: "loading" }];
    closeModal();
    statusLine.textContent = `账号 ${account.id} 已添加，正在查询…`;
    renderAll();
    void fetchAccount(account);
  });

  addButton.addEventListener("click", openModal);
  emptyState
    .querySelector("[data-open-modal]")!
    .addEventListener("click", openModal);
  cancelButton.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeModal();
  });

  refreshAllButton.addEventListener("click", () => {
    if (accounts.length > 0) void refreshAll();
  });

  // 启动方式偏好（默认关 = 新标签页内嵌 iframe；勾选 = 全屏独立窗口），记忆在本地。
  launchPopupToggle.checked = storage.getItem(LAUNCH_POPUP_KEY) === "1";
  launchPopupToggle.addEventListener("change", () => {
    try {
      storage.setItem(LAUNCH_POPUP_KEY, launchPopupToggle.checked ? "1" : "0");
    } catch {
      // 隐私模式等场景写入失败时，仅本次生效。
    }
  });

  launchV1Button.addEventListener("click", () => {
    if (launchPopupToggle.checked) {
      // 全屏独立窗口（官方 POPUP 模式）：带特性弹窗与 opener 同窗口组，握手可靠。
      const popup = openGamePopup();
      if (!popup) {
        statusLine.textContent =
          "浏览器拦截了游戏窗口，请允许本站弹出窗口后重试。";
        return;
      }
      startPopupHandshake(popup);
      return;
    }
    // 默认：新标签打开同源 /play 页，由该前台标签内的 iframe 完成握手，
    // 避开跨域新标签 opener 失活导致 postMessage 丢失的问题。
    const tab = window.open(PLAY_PAGE_URL, "_blank");
    if (!tab) {
      statusLine.textContent =
        "浏览器拦截了游戏标签页，请允许本站弹出窗口后重试。";
    }
  });

  grid.addEventListener("click", (event) => {
    const target =
      event.target && typeof (event.target as Element).closest === "function"
        ? (event.target as Element)
        : null;
    const refreshButton = target?.closest("[data-refresh]");
    if (refreshButton) {
      const id = refreshButton.getAttribute("data-refresh")!;
      const account = accounts.find((entry) => entry.id === id);
      if (account) void fetchAccount(account);
      return;
    }
    const deleteButton = target?.closest("[data-delete]");
    if (deleteButton) {
      const id = deleteButton.getAttribute("data-delete")!;
      if (armedDeleteId === id) {
        if (armedDeleteTimer) clearTimeout(armedDeleteTimer);
        armedDeleteId = null;
        accounts = accounts.filter((entry) => entry.id !== id);
        rows = rows.filter((entry) => entry.account.id !== id);
        persistAccounts(storage, accounts);
        statusLine.textContent = `账号 ${id} 已删除。`;
        renderAll();
      } else {
        armedDeleteId = id;
        if (armedDeleteTimer) clearTimeout(armedDeleteTimer);
        armedDeleteTimer = setTimeout(() => {
          armedDeleteId = null;
          renderAll();
        }, DELETE_ARM_MS);
        renderAll();
      }
    }
  });

  renderAll();
  if (accounts.length > 0) {
    // 仅上报监控账号数量用于统计功能使用情况，绝不包含账号、密码、名称等任何信息。
    track(AnalyticsEvent.AccountsUsage, { account_count: accounts.length });
    void refreshAll();
  }
}
