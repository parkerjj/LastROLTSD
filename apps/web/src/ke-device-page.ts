// KoreEngine 设备授权页（/ke/device）：核对 KE 面板上的验证码并允许/拒绝，同时管理已授权的设备。
// KE 运行在 IWA（isolated-app://…），拿不到本站会话 cookie，因此通过「设备授权」换取 Bearer token：
// KE 发起 → 用户在这里（已登录的普通浏览器）核对验证码并批准 → KE 轮询拿到 token。token 不经过本页，也不经过 URL。
// 所有来自接口的文本（设备名等由客户端自报）一律用 textContent 渲染，禁止拼进 innerHTML。

import { siteNavMarkup, mountSiteNav } from "./nav";
import { authStore, type AuthStore } from "./auth/store";
import { keFetch } from "./ke-page";

interface DeviceLookup {
  user_code: string;
  label: string;
  created_at: number;
  expires_at: number;
}

interface KeToken {
  id: number;
  label: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
}

export interface KeDevicePageDeps {
  store?: Pick<AuthStore, "getState" | "subscribe">;
}

/** 唤起 KE 的深链接：只用于把窗口切回 KE，不携带任何凭据（token 由 KE 轮询取得）。 */
const KE_LAUNCH_URL = "web+lastro://launch";

const FRIENDLY_ERRORS: Record<string, string> = {
  KE_DEVICE_NOT_FOUND: "验证码无效或已过期，请回到 KoreEngine 重新发起登录。",
  KE_RATE_LIMITED: "操作过于频繁，请稍后再试。",
  KE_TOKEN_NOT_FOUND: "该设备已被撤销或不存在。",
};

function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (error.message.startsWith("AUTH:")) return "登录状态已失效，请重新登录后再试。";
  const separator = error.message.indexOf(":");
  const code = separator > 0 ? error.message.slice(0, separator) : "";
  return FRIENDLY_ERRORS[code] ?? (separator > 0 ? error.message.slice(separator + 1) : error.message);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/gu, "");
}

function displayCode(raw: string): string {
  const code = normalizeCode(raw);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4, 8)}` : code;
}

export function mountKeDevicePage(root: HTMLElement, deps: KeDevicePageDeps = {}): void {
  const store = deps.store ?? authStore;
  document.title = "KoreEngine 设备授权 · 露天商店.Ro";

  // 验证码来自授权链接 ?code=…；读取后立刻从地址栏移除，避免残留在历史记录里。
  const initialCode = new URLSearchParams(window.location.search).get("code");
  if (initialCode !== null) window.history.replaceState(null, "", window.location.pathname);
  let pendingCode: string | null = initialCode !== null && normalizeCode(initialCode) !== "" ? displayCode(initialCode) : null;

  root.innerHTML = `
  <header class="site-header">
    <div class="topbar page-width">
      <a class="brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup(null)}
    </div>
  </header>
  <main class="page-width kd-main">
    <section class="kd-hero" aria-labelledby="kd-title">
      <p class="eyebrow">KoreEngine · 设备授权</p>
      <h1 class="kd-title" id="kd-title">授权 KoreEngine 登录</h1>
      <p class="kd-sub">在 KoreEngine 面板点击「登录 LTSD」后，会显示一个验证码。核对无误并允许，KoreEngine 就能以你的账号使用授权与配置服务。授权只开放 KoreEngine 相关接口，不能修改账号资料或密码。</p>
      <p id="kd-status" class="kd-status" role="status" aria-live="polite"></p>
    </section>

    <section id="kd-gate" class="kd-card" hidden></section>

    <section id="kd-approve" class="kd-card" aria-labelledby="kd-approve-title" hidden>
      <h2 id="kd-approve-title">核对验证码</h2>
      <form id="kd-code-form" class="kd-code-form">
        <label for="kd-code-input">KoreEngine 面板上显示的验证码</label>
        <div class="kd-code-row">
          <input id="kd-code-input" class="kd-code-input" maxlength="9" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX" />
          <button type="submit" class="kd-btn kd-btn-ghost">查找</button>
        </div>
      </form>
      <div id="kd-request" class="kd-request" hidden>
        <p class="kd-request-label">发起授权的设备</p>
        <p id="kd-request-device" class="kd-request-device"></p>
        <p id="kd-request-code" class="kd-request-code" aria-label="验证码"></p>
        <p class="kd-warn">请确认上面的验证码与 KoreEngine 面板上显示的完全一致。如果这不是你本人刚刚发起的登录，请点「拒绝」。</p>
        <div class="kd-actions">
          <button type="button" id="kd-allow" class="kd-btn kd-btn-primary">允许</button>
          <button type="button" id="kd-deny" class="kd-btn kd-btn-danger">拒绝</button>
        </div>
      </div>
      <div id="kd-result" class="kd-result" hidden>
        <p id="kd-result-text"></p>
        <a id="kd-return" class="kd-btn kd-btn-ghost" href="${KE_LAUNCH_URL}" hidden>返回 KoreEngine</a>
      </div>
    </section>

    <section id="kd-devices" class="kd-card" aria-labelledby="kd-devices-title" hidden>
      <div class="kd-devices-head">
        <h2 id="kd-devices-title">已授权的设备</h2>
        <button type="button" id="kd-refresh" class="kd-btn kd-btn-ghost">刷新</button>
      </div>
      <ul id="kd-device-list" class="kd-device-list"></ul>
      <p id="kd-device-empty" class="kd-empty" hidden>还没有已授权的设备。</p>
    </section>
  </main>
  <style>
    .kd-main { padding-bottom: 48px; }
    .kd-hero { padding: 30px 0 4px; }
    .kd-hero .eyebrow { color: var(--red-dark); }
    .kd-title { margin: 8px 0 6px; color: var(--forest); font-family: Georgia, "Microsoft YaHei", serif; font-size: clamp(1.5rem, 2.6vw, 2rem); font-weight: 700; }
    .kd-sub { max-width: 640px; margin: 0; color: var(--muted); font-size: .86rem; line-height: 1.7; }
    .kd-status { margin: 8px 0 0; min-height: 1.2em; color: var(--muted); font-size: .84rem; }
    .kd-status.is-error { color: var(--red-dark); font-weight: 700; }
    .kd-card { margin-top: 20px; padding: 18px 20px; background: #f7f3ea; border: 1px solid #b9ab94; border-radius: 12px; box-shadow: 0 22px 45px rgba(80,62,38,.11); }
    .kd-card h2 { margin: 0 0 12px; color: var(--forest); font-size: 1rem; }
    .kd-card[hidden], .kd-request[hidden], .kd-result[hidden], .kd-empty[hidden], .kd-btn[hidden] { display: none; }
    .kd-gate-text { margin: 0 0 12px; color: var(--ink); font-size: .88rem; line-height: 1.7; }
    .kd-code-form label { display: block; margin-bottom: 6px; color: #4c5a50; font-size: .76rem; font-weight: 800; }
    .kd-code-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .kd-code-input { width: 190px; min-height: 42px; padding: 6px 12px; border-radius: 8px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 1.1rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .kd-request { margin-top: 18px; padding: 14px 16px; background: #fffdf8; border: 1px solid var(--line); border-radius: 10px; }
    .kd-request-label { margin: 0 0 4px; color: var(--muted); font-size: .72rem; font-weight: 800; }
    .kd-request-device { margin: 0; color: var(--forest); font-size: 1rem; font-weight: 800; overflow-wrap: anywhere; }
    .kd-request-code { margin: 10px 0; color: var(--red-dark); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 1.8rem; font-weight: 900; letter-spacing: .14em; }
    .kd-warn { margin: 0 0 14px; color: #835f18; font-size: .8rem; line-height: 1.65; }
    .kd-actions { display: flex; gap: 10px; }
    .kd-result { margin-top: 16px; display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
    .kd-result p { margin: 0; color: var(--forest); font-size: .88rem; font-weight: 700; }
    .kd-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 4px 18px; border-radius: 8px; font-size: .82rem; font-weight: 800; text-decoration: none; cursor: pointer; }
    .kd-btn-primary { color: #fff; background: var(--forest); border: 1px solid var(--forest); }
    .kd-btn-ghost { color: var(--ink); background: #f7f3ea; border: 1px solid #aa9d88; }
    .kd-btn-danger { color: var(--red-dark); background: #fdf6f3; border: 1px solid #d8b3a9; }
    .kd-devices-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .kd-devices-head h2 { margin: 0; }
    .kd-device-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 10px; }
    .kd-device { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 12px 14px; background: #fffdf8; border: 1px solid var(--line); border-radius: 10px; }
    .kd-device-name { color: var(--forest); font-weight: 800; font-size: .9rem; overflow-wrap: anywhere; }
    .kd-device-meta { margin-top: 3px; color: var(--muted); font-size: .72rem; line-height: 1.6; }
    .kd-empty { margin: 12px 0 0; color: var(--muted); font-size: .84rem; }
  </style>`;

  mountSiteNav(root);

  const status = root.querySelector<HTMLElement>("#kd-status")!;
  const gate = root.querySelector<HTMLElement>("#kd-gate")!;
  const approve = root.querySelector<HTMLElement>("#kd-approve")!;
  const codeForm = root.querySelector<HTMLFormElement>("#kd-code-form")!;
  const codeInput = root.querySelector<HTMLInputElement>("#kd-code-input")!;
  const request = root.querySelector<HTMLElement>("#kd-request")!;
  const requestDevice = root.querySelector<HTMLElement>("#kd-request-device")!;
  const requestCode = root.querySelector<HTMLElement>("#kd-request-code")!;
  const allowButton = root.querySelector<HTMLButtonElement>("#kd-allow")!;
  const denyButton = root.querySelector<HTMLButtonElement>("#kd-deny")!;
  const result = root.querySelector<HTMLElement>("#kd-result")!;
  const resultText = root.querySelector<HTMLElement>("#kd-result-text")!;
  const returnLink = root.querySelector<HTMLAnchorElement>("#kd-return")!;
  const devices = root.querySelector<HTMLElement>("#kd-devices")!;
  const deviceList = root.querySelector<HTMLElement>("#kd-device-list")!;
  const deviceEmpty = root.querySelector<HTMLElement>("#kd-device-empty")!;
  const refreshButton = root.querySelector<HTMLButtonElement>("#kd-refresh")!;

  let current: DeviceLookup | null = null;
  let loadedFor: string | null = null;

  function say(text: string, isError = false): void {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  }

  function resetRequest(): void {
    current = null;
    request.hidden = true;
    result.hidden = true;
    returnLink.hidden = true;
  }

  async function lookup(rawCode: string): Promise<void> {
    resetRequest();
    const code = displayCode(rawCode);
    codeInput.value = code;
    say("正在查找…");
    try {
      const found = await keFetch<DeviceLookup>(`/api/v1/ke/device/lookup?user_code=${encodeURIComponent(code)}`);
      current = found;
      requestDevice.textContent = found.label;
      requestCode.textContent = found.user_code;
      request.hidden = false;
      say(`请在 ${formatTime(found.expires_at)} 前完成确认。`);
    } catch (error) {
      say(describeError(error, "查找失败，请重试。"), true);
    }
  }

  async function decide(approveRequest: boolean): Promise<void> {
    if (current === null) return;
    const code = current.user_code;
    allowButton.disabled = true;
    denyButton.disabled = true;
    try {
      await keFetch<void>("/api/v1/ke/device/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: code, approve: approveRequest }),
      });
      request.hidden = true;
      result.hidden = false;
      resultText.textContent = approveRequest
        ? "已授权。回到 KoreEngine，几秒内会自动完成登录；这个页面可以关闭。"
        : "已拒绝，KoreEngine 不会获得授权。";
      returnLink.hidden = !approveRequest;
      current = null;
      say("");
      if (approveRequest) void loadDevices();
    } catch (error) {
      say(describeError(error, "操作失败，请重试。"), true);
    } finally {
      allowButton.disabled = false;
      denyButton.disabled = false;
    }
  }

  function renderDevices(tokens: KeToken[]): void {
    deviceList.replaceChildren();
    deviceEmpty.hidden = tokens.length > 0;
    for (const token of tokens) {
      const item = document.createElement("li");
      item.className = "kd-device";
      const info = document.createElement("div");
      const name = document.createElement("div");
      name.className = "kd-device-name";
      name.textContent = token.label;
      const meta = document.createElement("div");
      meta.className = "kd-device-meta";
      meta.textContent = `授权于 ${formatTime(token.created_at)} · 最近使用 ${formatTime(token.last_used_at)} · 有效至 ${formatTime(token.expires_at)}`;
      info.append(name, meta);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "kd-btn kd-btn-danger";
      revoke.textContent = "撤销授权";
      revoke.addEventListener("click", () => void revokeDevice(token));
      item.append(info, revoke);
      deviceList.append(item);
    }
  }

  async function loadDevices(): Promise<void> {
    try {
      const body = await keFetch<{ tokens: KeToken[] }>("/api/v1/ke/tokens");
      renderDevices(body.tokens);
    } catch (error) {
      say(describeError(error, "加载已授权设备失败。"), true);
    }
  }

  async function revokeDevice(token: KeToken): Promise<void> {
    if (!window.confirm(`确定撤销「${token.label}」的授权？该设备上的 KoreEngine 将需要重新登录。`)) return;
    try {
      await keFetch<void>(`/api/v1/ke/tokens/${token.id}`, { method: "DELETE" });
      say("已撤销。");
      await loadDevices();
    } catch (error) {
      say(describeError(error, "撤销失败，请重试。"), true);
      await loadDevices();
    }
  }

  function syncAuth(): void {
    const state = store.getState();
    const authed = state.status === "pending" || state.status === "active";
    gate.hidden = authed;
    approve.hidden = !authed;
    devices.hidden = !authed;
    if (!authed) {
      loadedFor = null;
      resetRequest();
      gate.replaceChildren();
      const text = document.createElement("p");
      text.className = "kd-gate-text";
      if (state.status === "loading") {
        text.textContent = "账号状态加载中…";
        gate.append(text);
      } else {
        text.textContent = "请先登录 LTSD 账号，再核对并允许 KoreEngine 的登录请求。";
        const login = document.createElement("button");
        login.type = "button";
        login.className = "kd-btn kd-btn-primary";
        login.setAttribute("data-open-login", "");
        login.textContent = "登录账号";
        gate.append(text, login);
      }
      return;
    }
    if (loadedFor === state.user.id) return;
    loadedFor = state.user.id;
    void loadDevices();
    if (pendingCode !== null) {
      const code = pendingCode;
      pendingCode = null;
      void lookup(code);
    }
  }

  codeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (normalizeCode(codeInput.value).length === 0) {
      say("请输入 KoreEngine 面板上显示的验证码。", true);
      return;
    }
    void lookup(codeInput.value);
  });
  allowButton.addEventListener("click", () => void decide(true));
  denyButton.addEventListener("click", () => void decide(false));
  refreshButton.addEventListener("click", () => void loadDevices());
  store.subscribe(() => syncAuth());
  syncAuth();
}
