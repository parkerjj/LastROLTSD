// 管理员后台（/account/admin）：查看 / 赠送 / 扣减任意账号的 KE 额度与模块、修改到期时间、强制改密、查看审计日志。
// 入口只对 permission_level >= 100 的账号显示；页面本身不做任何信任——所有接口都由服务端再次校验管理员身份。
// 所有来自接口的文本（昵称、备注、邮箱等用户可控内容）一律用 textContent 渲染，禁止拼进 innerHTML。

import { siteNavMarkup, mountSiteNav } from "./nav";
import { authApi, type AuthApiClient } from "./auth/api";
import { authStore, type AuthStore } from "./auth/store";

const ADMIN_LEVEL = 100;
const AUDIT_PAGE_SIZE = 50;
/** 超过 90 年的有效期按「永久」展示（永久权益 = 99 年）。 */
const PERMANENT_THRESHOLD_MS = 90 * 365 * 24 * 60 * 60 * 1000;

interface AdminUser {
  id: number;
  email: string;
  display_name: string;
  status: string;
  permission_level: number;
  email_verified_at: number | null;
  created_at: number;
}

interface AdminEntitlement {
  id: number;
  user_id: number;
  resource: string;
  quantity: number;
  starts_at: number;
  expires_at: number;
  source: string;
  source_ref: string;
  actor_user_id: number | null;
  note: string | null;
  revoked_at: number | null;
  created_at: number;
}

interface AdminUserDetail {
  user: AdminUser;
  effective: { slots: number; modules: string[] };
  entitlements: AdminEntitlement[];
  entitlements_truncated?: boolean;
}

interface AdminAuditRecord {
  id: number;
  actor_user_id: number;
  action: string;
  target_user_id: number | null;
  detail: Record<string, unknown> | null;
  request_id: string | null;
  created_at: number;
}

export interface AdminPageDeps {
  store?: Pick<AuthStore, "getState" | "subscribe">;
  auth?: Pick<AuthApiClient, "sessionRequest">;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function resourceLabel(resource: string): string {
  if (resource === "slots") return "实例额度";
  if (resource.startsWith("module:")) return `模块 ${resource.slice("module:".length)}`;
  return resource;
}

function entitlementState(row: AdminEntitlement, now: number): string {
  if (row.revoked_at !== null) return "已撤销";
  if (row.starts_at > now) return "未生效";
  if (row.expires_at <= now) return "已过期";
  return "生效中";
}

function sourceLabel(source: string): string {
  if (source === "signup") return "验证邮箱赠送";
  if (source === "admin") return "管理员";
  if (source === "purchase") return "购买";
  return source;
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** 「2030-01-01 00:00」或 ISO 写法 → 毫秒时间戳；无法解析返回 null。 */
function parseLocalTime(raw: string): number | null {
  const text = raw.trim().replace(" ", "T");
  if (text === "") return null;
  const value = new Date(text).getTime();
  return Number.isFinite(value) ? value : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function adminGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (response.status === 401) throw new Error("登录状态已失效，请重新登录后再试。");
    throw new Error(body?.error?.message ?? "请求失败");
  }
  return (await response.json()) as T;
}

export function mountAdminPage(root: HTMLElement, deps: AdminPageDeps = {}): void {
  const store = deps.store ?? authStore;
  const auth = deps.auth ?? authApi;
  document.title = "管理员后台 · 露天商店.Ro";

  root.innerHTML = `
  <header class="site-header">
    <div class="topbar page-width">
      <a class="brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup(null)}
    </div>
  </header>
  <main class="page-width adm-main">
    <section class="adm-hero">
      <p class="eyebrow">管理员后台</p>
      <h1 class="adm-title">账号权益与内容管理</h1>
      <p id="adm-status" class="adm-status" role="status" aria-live="polite"></p>
    </section>
    <section id="adm-gate" class="adm-card"></section>
    <div id="adm-main" hidden>
      <section class="adm-card" aria-labelledby="adm-search-title">
        <h2 id="adm-search-title">查找账号</h2>
        <form id="adm-search-form" class="adm-row">
          <input id="adm-search-q" type="search" placeholder="账号 ID / 邮箱 / 昵称（留空显示最近注册）" autocomplete="off">
          <button type="submit" class="adm-btn adm-btn-primary">搜索</button>
        </form>
        <ul id="adm-user-list" class="adm-list"></ul>
      </section>

      <section id="adm-detail" class="adm-card" aria-labelledby="adm-detail-title" hidden>
        <h2 id="adm-detail-title">账号详情</h2>
        <p id="adm-user-info" class="adm-info"></p>
        <p id="adm-effective" class="adm-effective"></p>
        <div class="adm-table-wrap">
          <table class="adm-table">
            <thead><tr><th>资源</th><th>数量</th><th>有效期</th><th>来源</th><th>状态</th><th>备注</th><th>操作</th></tr></thead>
            <tbody id="adm-ent-body"></tbody>
          </table>
        </div>

        <p id="adm-ent-note" class="adm-hint" hidden>流水较多，这里只显示最近的记录；上面的「当前生效」仍是全部记录汇总的结果。</p>

        <h3>赠送 / 扣减</h3>
        <form id="adm-adjust-form" class="adm-form">
          <label>资源
            <input id="adm-adjust-resource" list="adm-resources" value="slots" autocomplete="off">
            <datalist id="adm-resources"><option value="slots">实例额度</option><option value="module:core">核心模块</option></datalist>
          </label>
          <label>数量（+N 赠送，-N 扣减）<input id="adm-adjust-delta" inputmode="numeric" placeholder="例如 3 或 -1" autocomplete="off"></label>
          <label>有效期
            <select id="adm-adjust-validity">
              <option value="days">按天数</option>
              <option value="until">到指定时间</option>
              <option value="permanent">永久（99 年）</option>
            </select>
          </label>
          <label id="adm-adjust-days-field">天数<input id="adm-adjust-days" inputmode="numeric" value="30" autocomplete="off"></label>
          <label id="adm-adjust-until-field" hidden>到期时间<input id="adm-adjust-until" type="datetime-local"></label>
          <label>备注<input id="adm-adjust-note" maxlength="200" autocomplete="off" placeholder="可选，例如：活动奖励"></label>
          <button type="submit" class="adm-btn adm-btn-primary">提交</button>
        </form>

        <h3>强制改密</h3>
        <form id="adm-password-form" class="adm-form">
          <label>新密码<input id="adm-password" type="password" autocomplete="new-password" placeholder="至少 5 个字符"></label>
          <button type="submit" class="adm-btn adm-btn-danger">修改密码</button>
        </form>
        <p class="adm-hint">修改后该账号的所有登录会话与 KoreEngine 授权立即失效，并会给用户发一封「密码已变更」通知邮件。管理员账号不能被强制改密。</p>
      </section>

      <section class="adm-card" aria-labelledby="adm-audit-title">
        <div class="adm-head">
          <h2 id="adm-audit-title">审计日志</h2>
          <button type="button" id="adm-audit-load" class="adm-btn adm-btn-ghost">加载最近记录</button>
        </div>
        <ul id="adm-audit-list" class="adm-list"></ul>
        <button type="button" id="adm-audit-more" class="adm-btn adm-btn-ghost" hidden>加载更多</button>
      </section>
    </div>
  </main>
  <style>
    .adm-main { padding-bottom: 48px; }
    .adm-hero { padding: 30px 0 4px; }
    .adm-hero .eyebrow { color: var(--red-dark); }
    .adm-title { margin: 8px 0 6px; color: var(--forest); font-family: Georgia, "Microsoft YaHei", serif; font-size: clamp(1.5rem, 2.6vw, 2rem); font-weight: 700; }
    .adm-status { margin: 8px 0 0; min-height: 1.2em; color: var(--muted); font-size: .84rem; }
    .adm-status.is-error { color: var(--red-dark); font-weight: 700; }
    .adm-card { margin-top: 20px; padding: 18px 20px; background: #f7f3ea; border: 1px solid #b9ab94; border-radius: 12px; box-shadow: 0 22px 45px rgba(80,62,38,.11); }
    .adm-card h2 { margin: 0 0 12px; color: var(--forest); font-size: 1rem; }
    .adm-card h3 { margin: 18px 0 8px; color: var(--forest); font-size: .9rem; }
    .adm-card[hidden], .adm-btn[hidden], .adm-form label[hidden], .adm-hint[hidden] { display: none; }
    .adm-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .adm-row input { flex: 1 1 260px; min-height: 40px; padding: 6px 12px; border-radius: 8px; }
    .adm-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
    .adm-list li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 10px 14px; background: #fffdf8; border: 1px solid var(--line); border-radius: 10px; font-size: .82rem; overflow-wrap: anywhere; }
    .adm-info, .adm-effective { margin: 0 0 6px; font-size: .86rem; line-height: 1.7; overflow-wrap: anywhere; }
    .adm-effective { color: var(--forest); font-weight: 800; }
    .adm-table-wrap { overflow-x: auto; }
    .adm-table { width: 100%; border-collapse: collapse; font-size: .78rem; }
    .adm-table th, .adm-table td { padding: 7px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    .adm-table td.is-negative { color: var(--red-dark); font-weight: 800; }
    .adm-table td .adm-btn { margin: 0 4px 4px 0; }
    .adm-form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .adm-form label { display: grid; gap: 4px; color: #4c5a50; font-size: .76rem; font-weight: 800; }
    .adm-form input, .adm-form select { min-height: 38px; padding: 4px 10px; border-radius: 8px; }
    .adm-hint { margin: 8px 0 0; color: var(--muted); font-size: .76rem; line-height: 1.6; }
    .adm-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .adm-head h2 { margin: 0; }
    .adm-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 2px 14px; border-radius: 8px; font-size: .78rem; font-weight: 800; cursor: pointer; }
    .adm-btn-primary { color: #fff; background: var(--forest); border: 1px solid var(--forest); }
    .adm-btn-ghost { color: var(--ink); background: #f7f3ea; border: 1px solid #aa9d88; }
    .adm-btn-danger { color: var(--red-dark); background: #fdf6f3; border: 1px solid #d8b3a9; }
    .adm-btn:disabled { opacity: .55; cursor: not-allowed; }
  </style>`;

  mountSiteNav(root);

  const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const status = q<HTMLElement>("#adm-status");
  const gate = q<HTMLElement>("#adm-gate");
  const main = q<HTMLElement>("#adm-main");
  const searchForm = q<HTMLFormElement>("#adm-search-form");
  const searchInput = q<HTMLInputElement>("#adm-search-q");
  const userList = q<HTMLElement>("#adm-user-list");
  const detail = q<HTMLElement>("#adm-detail");
  const userInfo = q<HTMLElement>("#adm-user-info");
  const effective = q<HTMLElement>("#adm-effective");
  const entBody = q<HTMLElement>("#adm-ent-body");
  const entNote = q<HTMLElement>("#adm-ent-note");
  const adjustForm = q<HTMLFormElement>("#adm-adjust-form");
  const adjustResource = q<HTMLInputElement>("#adm-adjust-resource");
  const adjustDelta = q<HTMLInputElement>("#adm-adjust-delta");
  const adjustValidity = q<HTMLSelectElement>("#adm-adjust-validity");
  const adjustDays = q<HTMLInputElement>("#adm-adjust-days");
  const adjustUntil = q<HTMLInputElement>("#adm-adjust-until");
  const adjustNote = q<HTMLInputElement>("#adm-adjust-note");
  const daysField = q<HTMLElement>("#adm-adjust-days-field");
  const untilField = q<HTMLElement>("#adm-adjust-until-field");
  const passwordForm = q<HTMLFormElement>("#adm-password-form");
  const passwordInput = q<HTMLInputElement>("#adm-password");
  const auditList = q<HTMLElement>("#adm-audit-list");
  const auditLoad = q<HTMLButtonElement>("#adm-audit-load");
  const auditMore = q<HTMLButtonElement>("#adm-audit-more");

  let selected: AdminUser | null = null;
  let loadedFor: string | null = null;
  let lastAuditId: number | null = null;

  function say(text: string, isError = false): void {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  }

  /* ---- 账号列表与详情 ---- */

  function renderUsers(users: AdminUser[]): void {
    userList.replaceChildren();
    if (users.length === 0) {
      userList.append(el("li", undefined, "没有符合条件的账号。"));
      return;
    }
    for (const user of users) {
      const item = el("li");
      item.append(el("span", undefined, `#${user.id} ${user.display_name} · ${user.email} · 等级 ${user.permission_level} · ${user.status}`));
      const pick = el("button", "adm-btn adm-btn-ghost", "管理");
      pick.type = "button";
      pick.dataset.userId = String(user.id);
      pick.addEventListener("click", () => void openUser(user.id));
      item.append(pick);
      userList.append(item);
    }
  }

  async function search(query: string): Promise<void> {
    try {
      const body = await adminGet<{ users: AdminUser[] }>(`/api/v1/admin/users?q=${encodeURIComponent(query)}`);
      renderUsers(body.users);
    } catch (error) {
      say(describeError(error, "搜索失败，请重试。"), true);
    }
  }

  function renderDetail(data: AdminUserDetail): void {
    selected = data.user;
    detail.hidden = false;
    userInfo.textContent = `#${data.user.id} ${data.user.display_name} · ${data.user.email} · 等级 ${data.user.permission_level} · ${data.user.status} · 注册于 ${formatTime(data.user.created_at)}`;
    effective.textContent = `当前生效：实例额度 ${data.effective.slots} · 模块 ${data.effective.modules.length > 0 ? data.effective.modules.join("、") : "无"}`;
    entNote.hidden = data.entitlements_truncated !== true;
    entBody.replaceChildren();
    const now = Date.now();
    for (const row of data.entitlements) {
      const tr = el("tr");
      const quantity = el("td", row.quantity < 0 ? "is-negative" : undefined, row.quantity > 0 ? `+${row.quantity}` : String(row.quantity));
      const permanent = row.expires_at - row.starts_at >= PERMANENT_THRESHOLD_MS;
      const window = permanent ? `${formatTime(row.starts_at)} 起 · 永久` : `${formatTime(row.starts_at)} → ${formatTime(row.expires_at)}`;
      tr.append(
        el("td", undefined, resourceLabel(row.resource)),
        quantity,
        el("td", undefined, window),
        el("td", undefined, sourceLabel(row.source)),
        el("td", undefined, entitlementState(row, now)),
        el("td", undefined, row.note ?? ""),
      );
      const actions = el("td");
      const expiry = el("button", "adm-btn adm-btn-ghost", "改到期");
      expiry.type = "button";
      expiry.dataset.entExpiry = "";
      expiry.addEventListener("click", () => void editExpiry(row));
      const toggle = el("button", "adm-btn adm-btn-ghost", row.revoked_at === null ? "撤销" : "恢复");
      toggle.type = "button";
      toggle.dataset[row.revoked_at === null ? "entRevoke" : "entRestore"] = "";
      toggle.addEventListener("click", () => void patchEntitlement(row.id, { revoked: row.revoked_at === null }, row.revoked_at === null ? "已撤销。" : "已恢复。"));
      actions.append(expiry, toggle);
      tr.append(actions);
      entBody.append(tr);
    }
  }

  async function loadDetail(userId: number): Promise<void> {
    try {
      renderDetail(await adminGet<AdminUserDetail>(`/api/v1/admin/users/${userId}`));
    } catch (error) {
      say(describeError(error, "读取账号详情失败。"), true);
    }
  }

  async function openUser(userId: number): Promise<void> {
    say("");
    await loadDetail(userId);
  }

  /* ---- 权益：赠送 / 扣减 / 修改 / 撤销 ---- */

  function syncValidityFields(): void {
    daysField.hidden = adjustValidity.value !== "days";
    untilField.hidden = adjustValidity.value !== "until";
  }

  async function patchEntitlement(id: number, body: Record<string, unknown>, done: string): Promise<void> {
    try {
      await auth.sessionRequest(`/api/v1/admin/entitlements/${id}`, "PATCH", body);
      say(done);
      if (selected !== null) await loadDetail(selected.id);
    } catch (error) {
      say(describeError(error, "操作失败，请重试。"), true);
    }
  }

  async function editExpiry(row: AdminEntitlement): Promise<void> {
    const raw = window.prompt("新的到期时间（例如 2030-01-31 23:59）", "");
    if (raw === null) return;
    const value = parseLocalTime(raw);
    if (value === null) {
      say("到期时间格式无法识别，请按 2030-01-31 23:59 填写。", true);
      return;
    }
    await patchEntitlement(row.id, { expires_at: value }, "到期时间已修改。");
  }

  function buildAdjustBody(): Record<string, unknown> | string {
    const resource = adjustResource.value.trim();
    if (resource === "") return "请填写资源，例如 slots 或 module:core。";
    const rawDelta = adjustDelta.value.trim();
    if (!/^[+-]?\d+$/u.test(rawDelta) || Number(rawDelta) === 0) return "数量必须是非零整数，例如 3 或 -1。";
    const body: Record<string, unknown> = { resource, delta: Number(rawDelta) };
    if (adjustValidity.value === "permanent") {
      body.permanent = true;
    } else if (adjustValidity.value === "days") {
      const days = adjustDays.value.trim();
      if (!/^\d+$/u.test(days) || Number(days) < 1) return "天数必须是正整数。";
      body.duration_days = Number(days);
    } else {
      const until = parseLocalTime(adjustUntil.value);
      if (until === null) return "请选择到期时间。";
      body.expires_at = until;
    }
    const note = adjustNote.value.trim();
    if (note !== "") body.note = note;
    return body;
  }

  adjustForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (selected === null) return;
    const body = buildAdjustBody();
    if (typeof body === "string") {
      say(body, true);
      return;
    }
    const target = selected;
    void (async () => {
      try {
        await auth.sessionRequest(`/api/v1/admin/users/${target.id}/entitlements`, "POST", body);
        say(`已${(body.delta as number) > 0 ? "赠送" : "扣减"} ${resourceLabel(String(body.resource))} ${Math.abs(body.delta as number)}。`);
        adjustDelta.value = "";
        adjustNote.value = "";
        await loadDetail(target.id);
      } catch (error) {
        say(describeError(error, "提交失败，请重试。"), true);
      }
    })();
  });
  adjustValidity.addEventListener("change", syncValidityFields);

  /* ---- 强制改密 ---- */

  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (selected === null) return;
    const password = passwordInput.value;
    if (password === "") {
      say("请先输入新密码。", true);
      return;
    }
    const target = selected;
    if (!window.confirm(`确定把「${target.display_name}」的密码改为新密码吗？该账号的所有登录会话将立即失效。`)) return;
    void (async () => {
      try {
        await auth.sessionRequest(`/api/v1/admin/users/${target.id}/password`, "POST", { new_password: password });
        passwordInput.value = "";
        say("密码已修改，该账号的所有会话已失效。");
      } catch (error) {
        say(describeError(error, "修改密码失败，请重试。"), true);
      }
    })();
  });

  /* ---- 审计日志 ---- */

  function renderAudit(entries: AdminAuditRecord[], append: boolean): void {
    if (!append) auditList.replaceChildren();
    for (const entry of entries) {
      const item = el("li");
      const summary = entry.detail === null ? "" : JSON.stringify(entry.detail);
      item.append(el("span", undefined, `#${entry.id} ${formatTime(entry.created_at)} · ${entry.action} · 操作者 ${entry.actor_user_id} → 目标 ${entry.target_user_id ?? "-"}${summary === "" ? "" : ` · ${summary.length > 160 ? `${summary.slice(0, 160)}…` : summary}`}`));
      auditList.append(item);
    }
    if (entries.length > 0) lastAuditId = entries[entries.length - 1]!.id;
    auditMore.hidden = entries.length < AUDIT_PAGE_SIZE;
  }

  async function loadAudit(more: boolean): Promise<void> {
    try {
      const path = more && lastAuditId !== null ? `/api/v1/admin/audit?before=${lastAuditId}` : "/api/v1/admin/audit";
      const body = await adminGet<{ entries: AdminAuditRecord[] }>(path);
      renderAudit(body.entries, more);
    } catch (error) {
      say(describeError(error, "读取审计日志失败。"), true);
    }
  }

  auditLoad.addEventListener("click", () => void loadAudit(false));
  auditMore.addEventListener("click", () => void loadAudit(true));

  /* ---- 登录态 ---- */

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void search(searchInput.value.trim());
  });

  function syncAuth(): void {
    const state = store.getState();
    const authed = state.status === "pending" || state.status === "active";
    const admin = authed && state.user.permission_level >= ADMIN_LEVEL;
    main.hidden = !admin;
    gate.hidden = admin;
    if (admin) {
      if (loadedFor !== state.user.id) {
        loadedFor = state.user.id;
        void search("");
      }
      return;
    }
    loadedFor = null;
    gate.replaceChildren();
    const text = el("p", "adm-info");
    if (state.status === "loading") {
      text.textContent = "账号状态加载中…";
      gate.append(text);
    } else if (!authed) {
      text.textContent = "请先登录管理员账号。";
      const login = el("button", "adm-btn adm-btn-primary", "登录账号");
      login.type = "button";
      login.setAttribute("data-open-login", "");
      gate.append(text, login);
    } else {
      text.textContent = "页面不存在。";
      gate.append(text);
    }
  }

  syncValidityFields();
  store.subscribe(() => syncAuth());
  syncAuth();
}
