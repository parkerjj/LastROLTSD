// KE 监控台里的「离线挂机」面板：登记要交给服务器 24 小时挂机的角色，启动 / 停止 / 删除，查看最近一次上报的状态。
// 只是接口的展示层：资格、额度、调度全部由服务端判定，页面不缓存也不推断这些结论。
import type { AuthApiClient } from "./auth/api";
import type { AuthStoreState } from "./auth/store";
import { createDeathApi, deathDialogMarkup, type DeathApi, type DeathDialogState } from "./ke-death-report";

export interface HostedItem {
  id: string;
  char_name: string;
  nid: number;
  aid: number;
  cid: number;
  desired: string;
  phase: string;
  stop_reason: string | null;
  retry_at: number | null;
  agent: string | null;
  status: unknown;
  status_at: number | null;
}

export interface HostedEligibility {
  eligible: boolean;
  slots: number;
  has_hosting: boolean;
  hosting_expires_at: number | null;
  cap: number;
  hosted_count: number;
}

export interface HostableCharacter {
  aid: number;
  cid: number;
  nid: number;
  char_name: string;
  job_id: number | null;
  map_name: string | null;
  last_seen_at: number;
}

export interface CreateHostedForm {
  nid: number;
  aid: number;
  cid: number;
  charName: string;
  gameAccount: string;
  gamePassword: string;
  currentPassword: string;
}

export interface HostingApi {
  load(): Promise<{ eligibility: HostedEligibility; items: HostedItem[] }>;
  characters(): Promise<HostableCharacter[]>;
  create(form: CreateHostedForm): Promise<{ id: string }>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** 让托管服务器重新拉取该角色在 LTSD 上保存的配置并 reload all（约 1～2 分钟生效）。 */
  syncConfig(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** 死亡报告（可选：没有这组接口时卡片上不显示「死亡记录」）。 */
  deaths?: DeathApi;
}

export function createHostingApi(api: Pick<AuthApiClient, "sessionRead" | "sessionRequest">): HostingApi {
  const path = (id: string, action = "") => `/api/v1/ke/hosted/${encodeURIComponent(id)}${action}`;
  return {
    async load() {
      const body = await api.sessionRead<{ eligibility: HostedEligibility; items: HostedItem[] }>("/api/v1/ke/hosted");
      if (!body || typeof body !== "object" || !body.eligibility || !Array.isArray(body.items)) {
        throw new Error("托管服务返回了无效数据，请稍后刷新重试");
      }
      return body;
    },
    async characters() {
      const body = await api.sessionRead<{ characters: HostableCharacter[] }>("/api/v1/ke/characters");
      return Array.isArray(body?.characters) ? body.characters : [];
    },
    create(form) {
      return api.sessionRequest<{ id: string }>("/api/v1/ke/hosted", "POST", {
        nid: form.nid,
        aid: form.aid,
        cid: form.cid,
        char_name: form.charName,
        game_account: form.gameAccount,
        game_password: form.gamePassword,
        current_password: form.currentPassword,
      });
    },
    async start(id) { await api.sessionRequest<void>(path(id, "/start"), "POST", {}); },
    async stop(id) { await api.sessionRequest<void>(path(id, "/stop"), "POST", {}); },
    async syncConfig(id) { await api.sessionRequest<void>(path(id, "/sync-config"), "POST", {}); },
    async remove(id) { await api.sessionRequest<void>(path(id), "DELETE"); },
    deaths: createDeathApi(api),
  };
}

export interface HostingStore {
  getState(): Readonly<AuthStoreState>;
  subscribe(listener: (state: Readonly<AuthStoreState>) => void): () => void;
}

export interface HostingPanelOptions {
  now?: () => number;
  /** 过渡状态下自动重新读取的间隔（毫秒），默认 30 秒；主要给测试缩短。 */
  pollMs?: number;
}

const SERVER_LABELS: Record<number, { label: string; code: string }> = {
  5: { label: "二转", code: "V6-Eden" },
  3: { label: "三转", code: "V6-Online" },
  6: { label: "App服", code: "V6-APP" },
};
/** 状态快照随 5 分钟心跳上报；超过两个周期没有更新就提示数据较旧。 */
const STALE_AFTER_MS = 12 * 60 * 1000;
const DELETE_ARM_MS = 3000;
/** 这些阶段是“启动 / 停止还没落定”，页面要自动刷新才能看到结果。 */
const SETTLING_PHASES = new Set(["queued", "assigned", "starting", "stopping", "migrating"]);
const POLL_MS = 30_000;
/** 一直落不定（例如没有可用的托管服务器）时最多自动读取这么多次，之后改回手动刷新。 */
const POLL_MAX = 20;

type Tone = "good" | "wait" | "idle" | "warn" | "bad";

interface PhaseMeta {
  label: string;
  tone: Tone;
}

const PHASES: Record<string, PhaseMeta> = {
  queued: { label: "排队中", tone: "wait" },
  assigned: { label: "启动中", tone: "wait" },
  starting: { label: "启动中", tone: "wait" },
  running: { label: "运行中", tone: "good" },
  backoff: { label: "等待重连", tone: "warn" },
  stopping: { label: "停止中", tone: "wait" },
  stopped: { label: "已停止", tone: "idle" },
  migrating: { label: "迁移中", tone: "wait" },
  error: { label: "需要处理", tone: "bad" },
};

const STOP_REASONS: Record<string, string> = {
  user: "你手动停止了托管。",
  "no-hosting-entitlement": "离线挂机已到期或不可用，实例已自动停止。续费后需要手动重新启动。",
  "over-hosting-cap": "托管数量超过了实例额度，最新启动的实例已被自动停止。",
  error: "托管遇到无法自动恢复的问题（常见原因是游戏账号或密码不正确），请检查后重新启动。",
};

/** 购买页入口。带 plan=hosting，购买页会直接勾选离线挂机且不额外买额度。 */
const BUY_URL = "/ke/buy?plan=hosting";

const AI_MODES: Record<string, string> = { auto: "自动挂机", manual: "手动", off: "已关闭" };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const numberFormatter = new Intl.NumberFormat("zh-CN");
function formatNumber(value: unknown): string {
  const number = Number(value);
  return numberFormatter.format(Number.isFinite(number) ? number : 0);
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 带正负号的整数，Zeny 变化用：+1,268,400 / -5,000 / 0。 */
function formatSigned(value: unknown): string {
  const number = finite(value);
  return `${number > 0 ? "+" : number < 0 ? "-" : ""}${numberFormatter.format(Math.abs(number))}`;
}

/** 中文习惯的大数：≥1 亿写“x.x 亿”，≥1 万写“x 万”，否则原样。 */
function formatCompact(value: unknown): string {
  const number = Math.abs(finite(value));
  const sign = finite(value) < 0 ? "-" : "";
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  if (number >= 100_000_000) return `${sign}${trim(number / 100_000_000)} 亿`;
  if (number >= 10_000) return `${sign}${trim(number / 10_000)} 万`;
  return `${sign}${numberFormatter.format(number)}`;
}

function formatElapsed(ms: unknown): string {
  const minutes = Math.floor(finite(ms) / 60_000);
  if (minutes < 1) return "不到 1 分";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} 时 ${minutes % 60} 分` : `${minutes} 分`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function formatRelative(timestamp: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - timestamp) / 60000));
  if (minutes < 1) return "1 分钟内";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatUntil(timestamp: number, nowMs: number): string {
  const minutes = Math.max(0, Math.ceil((timestamp - nowMs) / 60000));
  if (minutes < 1) return "马上";
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟后`;
}

function formatDay(timestamp: number): string {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function characterKey(value: { aid: number; cid: number; nid: number }): string {
  return `${value.aid}:${value.cid}:${value.nid}`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function mountHostingPanel(
  container: HTMLElement,
  api: HostingApi,
  store: HostingStore,
  options: HostingPanelOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? POLL_MS;
  type View =
    | { kind: "loading" }
    | { kind: "anonymous" }
    | { kind: "error"; message: string }
    | { kind: "ready"; eligibility: HostedEligibility; items: HostedItem[] };

  let view: View = { kind: "loading" };
  let notice = "";
  let noticeTone: "ok" | "error" | "" = "";
  let busyIds = new Set<string>();
  let armedDelete: string | null = null;
  const runOpen = new Set<string>();
  let armedTimer: ReturnType<typeof setTimeout> | null = null;
  let dialogOpen = false;
  let dialogCharacters: HostableCharacter[] | null = null;
  let dialogError = "";
  let dialogBusy = false;
  let loadSequence = 0;
  /** 每个托管实例的死亡记录条数（只在读到后才显示按钮）。 */
  const deathCounts = new Map<string, number>();
  let deathDialog: DeathDialogState | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollCount = 0;
  let disposed = false;
  const initial = store.getState();
  let lastUserId: string | null = initial.status === "active" ? initial.user.id : null;

  container.innerHTML = `<div class="kc-hosting" data-kc-root></div>`;
  const root = container.querySelector<HTMLElement>("[data-kc-root]")!;

  /** 曾经开通过、现在到期了。到期的用户该看到“续费”，从没开通过的看到“开通”。 */
  function lapsed(eligibility: HostedEligibility): boolean {
    return !eligibility.has_hosting && eligibility.hosting_expires_at !== null && eligibility.hosting_expires_at <= now();
  }

  /** 当前没有离线挂机资格时的资格信息；有资格或还没读到数据时为 null。 */
  function unentitled(): HostedEligibility | null {
    return view.kind === "ready" && !view.eligibility.has_hosting ? view.eligibility : null;
  }

  function statTile(label: string, value: string, sub: string, tone: Tone | "" = ""): string {
    return `<div class="kc-stat${tone ? ` kc-stat--${tone}` : ""}"><span class="kc-stat-label">${label}</span><b class="kc-stat-value">${value}</b><span class="kc-stat-sub">${sub}</span></div>`;
  }

  function statsMarkup(eligibility: HostedEligibility, items: HostedItem[]): string {
    const nowMs = now();
    const expiresAt = eligibility.hosting_expires_at;
    const days = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - nowMs) / 86_400_000));
    const hosting = eligibility.has_hosting
      ? statTile(
          "离线挂机",
          "已开通",
          expiresAt === null ? "" : `${formatDay(expiresAt)} 到期${days !== null && days <= 7 ? ` · 剩 ${days} 天` : ""}`,
          days !== null && days <= 7 ? "warn" : "good",
        )
      : lapsed(eligibility)
        ? statTile("离线挂机", "已到期", `<a href="${BUY_URL}">去续费 →</a>`, "warn")
        : statTile("离线挂机", "未开通", `<a href="${BUY_URL}">去开通 →</a>`, "idle");
    const running = items.filter((item) => item.phase === "running").length;
    const attention = items.filter((item) => item.phase === "error" || item.phase === "backoff").length;
    return `<div class="kc-stats" role="list">
      <div role="listitem">${hosting}</div>
      <div role="listitem">${statTile("托管中", `${running}<small> / ${eligibility.cap}</small>`, `已登记 ${eligibility.hosted_count} 个角色`)}</div>
      <div role="listitem">${statTile("实例额度", `${eligibility.slots}`, "含免费 1 个，托管数量不超过它", "")}</div>
      <div role="listitem">${statTile("需要处理", `${attention}`, attention > 0 ? "重连等待或出错" : "一切正常", attention > 0 ? "warn" : "good")}</div>
    </div>`;
  }

  function upsellMarkup(eligibility: HostedEligibility): string {
    const renew = lapsed(eligibility);
    return `<aside class="kc-upsell" aria-labelledby="kc-upsell-title">
      <div class="kc-upsell-copy">
        <p class="eyebrow">${renew ? "已到期" : "付费功能"}</p>
        <h3 id="kc-upsell-title">${renew ? "离线挂机已到期：续费后，角色继续在服务器上打怪" : "离线挂机：关掉电脑，角色继续在服务器上打怪"}</h3>
        <p>把角色交给服务器 24 小时挂机，断线自动重连、故障自动换机。购买时<b>自动包含</b>等时长的全平台脱机 KoreEngine。</p>
      </div>
      <div class="kc-upsell-action"><b>¥50 <small>/ 月</small></b><a class="kc-link-button" href="${BUY_URL}">${renew ? "立即续费" : "立即开通"}</a></div>
    </aside>`;
  }

  /** 运行统计：收起时一行摘要 + 卡片/装备数量，点开看详情。旧版 agent 的快照没有 stats，就不画。 */
  function runMarkup(item: HostedItem, snapshot: Record<string, unknown>): string {
    const stats = record(snapshot.stats);
    if (!stats) return "";
    const open = runOpen.has(item.id);
    const cards = finite(stats.important_cards);
    const equips = finite(stats.important_equips);
    const badges = cards > 0 || equips > 0
      ? `<div class="kc-run-badges">${cards > 0 ? `<span class="kc-tag kc-tag--card">★ 卡片 ×${formatNumber(cards)}</span>` : ""}${equips > 0 ? `<span class="kc-tag kc-tag--equip">★ 装备 ×${formatNumber(equips)}</span>` : ""}</div>`
      : "";
    const zenyClass = finite(stats.zeny_net) > 0 ? " is-up" : finite(stats.zeny_net) < 0 ? " is-down" : "";
    const summary = `<div class="kc-run-head"><span class="kc-run-summary">击杀 <b>${formatNumber(stats.kills)}</b> · 道具 <b>${formatNumber(stats.item_count)}</b> · Zeny <b class="kc-zeny${zenyClass}">${formatSigned(stats.zeny_net)}</b></span><button type="button" class="kc-run-toggle" data-kc-run="${escapeHtml(item.id)}" aria-expanded="${open}">${open ? "收起 ▴" : "展开 ▾"}</button></div>${badges}`;
    return `<div class="kc-run"><hr class="acc-divider">${summary}${open ? runDetail(stats) : ""}</div>`;
  }

  function runDetail(stats: Record<string, unknown>): string {
    const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record).filter((row): row is Record<string, unknown> => row !== null) : []);
    const section = (title: string, aside: string, body: string): string =>
      body ? `<div class="kc-run-section"><div class="kc-run-title"><span>${title}</span><span>${aside}</span></div>${body}</div>` : "";
    const row = (label: string, value: string): string => `<div class="kc-run-row"><span>${label}</span><b>${value}</b></div>`;
    const important = rows(stats.important).map((entry) => {
      const card = entry.kind === "card";
      return row(`<span class="kc-tag kc-tag--${card ? "card" : "equip"}">${card ? "卡片" : "装备"}</span>${escapeHtml(String(entry.name ?? "?"))}`, `×${formatNumber(entry.count)}`);
    }).join("");
    const topItems = rows(stats.top_items).map((entry) => row(escapeHtml(String(entry.name ?? "?")), `×${formatNumber(entry.count)}`)).join("");
    const topMonsters = rows(stats.top_monsters).map((entry) => row(escapeHtml(String(entry.name ?? "?")), formatNumber(entry.count))).join("");
    const perHour = (value: unknown): string => (value === null || value === undefined ? "" : ` (${formatCompact(value)}/时)`);
    const hasZenyRate = stats.zeny_per_hour !== null && stats.zeny_per_hour !== undefined;
    const other = [
      row("挂机时长", escapeHtml(formatElapsed(stats.elapsed_ms))),
      row("Base 经验", `+${formatCompact(stats.base_exp_gained)}${perHour(stats.base_exp_per_hour)}`),
      row("Job 经验", `+${formatCompact(stats.job_exp_gained)}${perHour(stats.job_exp_per_hour)}`),
      row("死亡", `${formatNumber(stats.deaths)} 次`),
      row("获得道具", `${formatNumber(stats.item_kinds)} 种 / ${formatNumber(stats.item_count)} 件`),
      hasZenyRate ? row("Zeny 每小时", `约 ${formatCompact(stats.zeny_per_hour)}`) : "",
    ].join("");
    return `<div class="kc-run-detail">
      ${section("重要掉落", `卡片 ${formatNumber(stats.important_cards)} · 装备 ${formatNumber(stats.important_equips)}`, important)}
      ${section("掉落最多", "前 5 名", topItems)}
      ${section("击杀排行", "前 5 名", topMonsters)}
      ${section("本次其他数据", "", other)}
      <p class="kc-run-note">统计自本次托管启动起累计；卖出、存仓、使用不会减少“获得”，从仓库取出、商店买入不算获得。</p>
    </div>`;
  }

  function snapshotMarkup(item: HostedItem): string {
    const snapshot = record(item.status);
    if (!snapshot) {
      const text: Record<string, string> = {
        queued: "正在等待托管服务器分配名额。",
        assigned: "已分配服务器，正在启动进程。",
        starting: "正在登录游戏，通常一两分钟内完成。",
        migrating: "原服务器失联，正在迁移到另一台。",
        running: "已在运行，状态会随下一次心跳（约 5 分钟）显示在这里。",
        backoff: "游戏连接中断，正在按退避规则等待重连。",
      };
      return `<p class="acc-note"><i class="ph ph-hourglass-medium" aria-hidden="true"></i>${escapeHtml(text[item.phase] ?? "暂无状态数据。")}</p>`;
    }
    const character = record(snapshot.character) ?? {};
    const vitals = record(snapshot.vitals) ?? {};
    const map = record(snapshot.map) ?? {};
    const hp = finite(vitals.hp);
    const hpMax = finite(vitals.hp_max);
    const sp = finite(vitals.sp);
    const spMax = finite(vitals.sp_max);
    const weight = finite(vitals.weight);
    const weightMax = finite(vitals.weight_max);
    const hpPercent = hpMax > 0 ? Math.min(100, (hp / hpMax) * 100) : 0;
    const spPercent = spMax > 0 ? Math.min(100, (sp / spMax) * 100) : 0;
    const weightPercent = weightMax > 0 ? Math.min(100, (weight / weightMax) * 100) : 0;
    const mapName = typeof map.name === "string" && map.name ? map.name : "—";
    const hasXY = map.x !== null && map.x !== undefined && map.y !== null && map.y !== undefined;
    const ai = typeof snapshot.ai === "string" ? snapshot.ai : "";
    const gauge = (label: string, fillClass: string, percent: number, value: string) =>
      `<div class="gauge"><span class="gauge-label">${label}</span><span class="gauge-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(1)}"><i class="gauge-fill ${fillClass}" style="width:${percent}%"></i></span><span class="gauge-value">${value}</span></div>`;
    return `
      <div class="acc-hero"><span class="acc-char">${escapeHtml(String(character.name ?? item.char_name))}</span><div class="acc-levels"><div class="acc-level"><b>${finite(character.base_level)}</b><span>BASE</span></div><div class="acc-level"><b>${finite(character.job_level)}</b><span>JOB</span></div></div></div>
      <div class="acc-gauges">
        ${gauge("HP", "gauge-fill--hp", hpPercent, `${formatNumber(hp)} <em>/ ${formatNumber(hpMax)}</em>`)}
        ${gauge("SP", "gauge-fill--sp", spPercent, `${formatNumber(sp)} <em>/ ${formatNumber(spMax)}</em>`)}
        ${weightMax > 0 ? gauge("负重", `gauge-fill--weight${weightPercent >= 90 ? " is-heavy" : ""}`, weightPercent, `${weightPercent.toFixed(1)}%`) : ""}
      </div>
      <hr class="acc-divider">
      <div class="acc-chips">
        <span class="chip chip--map"><i class="ph ph-map-pin" aria-hidden="true"></i>${escapeHtml(mapName)}${hasXY ? ` (${finite(map.x)}, ${finite(map.y)})` : ""}</span>
        <span class="chip"><i class="ph ph-coins" aria-hidden="true"></i>${formatNumber(vitals.zeny)} z</span>
        ${ai ? `<span class="chip">${escapeHtml(AI_MODES[ai] ?? ai)}</span>` : ""}
      </div>${runMarkup(item, snapshot)}`;
  }

  function cardMarkup(item: HostedItem): string {
    const nowMs = now();
    const meta = PHASES[item.phase] ?? { label: item.phase, tone: "idle" as Tone };
    const server = SERVER_LABELS[item.nid] ?? { label: `服务器 ${item.nid}`, code: "" };
    const busy = busyIds.has(item.id);
    const running = item.desired === "running";
    const removable = !running && item.phase === "stopped";
    const armed = armedDelete === item.id;
    let hint = "";
    if (item.phase === "backoff" && item.retry_at !== null) {
      hint = `<p class="kc-hint kc-hint--warn"><i class="ph ph-clock-countdown" aria-hidden="true"></i>${escapeHtml(formatUntil(item.retry_at, nowMs))}自动重试。被其他设备顶下线时会等得更久（30 分钟起），避免互相抢号。</p>`;
    } else if (item.phase === "stopped" && item.stop_reason) {
      const renewLink = item.stop_reason === "no-hosting-entitlement" && unentitled() ? ` <a href="${BUY_URL}">去续费 →</a>` : "";
      hint = `<p class="kc-hint${item.stop_reason === "user" ? "" : " kc-hint--warn"}"><i class="ph ph-info" aria-hidden="true"></i><span>${escapeHtml(STOP_REASONS[item.stop_reason] ?? "托管已停止。")}${renewLink}</span></p>`;
    } else if (item.phase === "error") {
      hint = `<p class="kc-hint kc-hint--bad"><i class="ph ph-warning" aria-hidden="true"></i>${escapeHtml(STOP_REASONS.error!)}</p>`;
    }
    // 等待重连、已停止、出错时已经有一句说明，没有快照就不再重复显示占位文案。
    const body = item.status || (!hint && item.phase !== "stopped" && item.phase !== "error")
      ? snapshotMarkup(item)
      : "";
    const stale = item.status_at !== null && nowMs - item.status_at > STALE_AFTER_MS;
    const updated = item.status_at !== null
      ? `<span class="account-updated">${escapeHtml(formatRelative(item.status_at, nowMs))}更新${stale && running ? '<small class="account-stale">数据较旧</small>' : ""}</span>`
      : `<span class="account-updated">${running && item.agent ? `由 ${escapeHtml(item.agent)} 托管` : running ? "等待分配" : "未在托管"}</span>`;
    // 只有进程在运行时才有配置可同步；排队、启动中、等待重连的实例启动时本来就会拉最新配置。
    const sync = item.phase === "running"
      ? `<button type="button" class="acc-btn kc-btn-sync" data-kc-sync="${escapeHtml(item.id)}" ${busy ? "disabled" : ""} aria-label="同步并重载 ${escapeHtml(item.char_name)} 的配置" title="从 LTSD 同步最新配置并重载"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i><span>同步并重载配置</span></button>`
      : "";
    const toggle = running
      ? `${sync}<button type="button" class="acc-btn kc-btn-stop" data-kc-stop="${escapeHtml(item.id)}" ${busy ? "disabled" : ""} aria-label="停止托管 ${escapeHtml(item.char_name)}" title="停止"><i class="ph ph-stop-circle" aria-hidden="true"></i><span>停止</span></button>`
      : `<button type="button" class="acc-btn kc-btn-start" data-kc-start="${escapeHtml(item.id)}" ${busy ? "disabled" : ""} aria-label="启动托管 ${escapeHtml(item.char_name)}" title="启动"><i class="ph ph-play-circle" aria-hidden="true"></i><span>启动</span></button>`;
    const deaths = deathCounts.get(item.id) ?? 0;
    const deathButton = deaths > 0
      ? `<button type="button" class="acc-btn acc-btn--wide kc-btn-deaths" data-kc-deaths="${escapeHtml(item.id)}" aria-label="查看 ${escapeHtml(item.char_name)} 的死亡记录" title="死亡记录"><i class="ph ph-skull" aria-hidden="true"></i><span>死亡记录</span><b class="kc-badge">${deaths}</b></button>`
      : "";
    return `<article class="account-card kc-card kc-card--${meta.tone}" data-kc-card="${escapeHtml(item.id)}">
      <div class="acc-inner">
        <header class="acc-head"><div class="acc-who"><span class="acc-label">${escapeHtml(item.char_name)}</span><span class="acc-id"><span class="acc-server acc-server--${item.nid}" title="${escapeHtml(server.code)}">${escapeHtml(server.label)}</span></span></div><span class="kc-stamp kc-stamp--${meta.tone}"><i></i>${escapeHtml(meta.label)}</span></header>
        <div class="acc-body">${hint}${body}</div>
      </div>
      <footer class="acc-foot">${updated}<span class="acc-actions">
        ${deathButton}
        ${toggle}
        ${removable ? `<button type="button" class="acc-btn acc-btn--danger${armed ? " is-armed" : ""}" data-kc-delete="${escapeHtml(item.id)}" ${busy ? "disabled" : ""} aria-label="删除托管 ${escapeHtml(item.char_name)}" title="删除">${armed ? "确认删除？" : '<i class="ph ph-trash" aria-hidden="true"></i>'}</button>` : ""}
      </span></footer>
    </article>`;
  }

  function emptyMarkup(eligibility: HostedEligibility): string {
    return `<div class="accounts-empty kc-empty">
      <i class="ph ph-cloud-arrow-up" aria-hidden="true"></i>
      <h3>还没有托管角色</h3>
      <p>${eligibility.has_hosting
        ? "把用 KoreEngine 登录过的角色添加进来，再点「启动」，它就会在服务器上持续挂机。游戏密码加密保存在服务器，只用于托管登录。"
        : lapsed(eligibility) ? "离线挂机已到期，续费后就可以继续把角色交给服务器挂机。" : "开通离线挂机后，就可以把角色交给服务器挂机。"}</p>
      ${eligibility.has_hosting
        ? '<button type="button" data-kc-open-dialog><i class="ph ph-plus" aria-hidden="true"></i> 添加第一个托管角色</button>'
        : `<a class="kc-link-button" href="${BUY_URL}">${lapsed(eligibility) ? "续费离线挂机" : "开通离线挂机"}</a>`}
    </div>`;
  }

  function dialogMarkup(): string {
    if (!dialogOpen) return "";
    const hostedKeys = new Set(view.kind === "ready" ? view.items.map(characterKey) : []);
    const available = (dialogCharacters ?? []).filter((character) => !hostedKeys.has(characterKey(character)));
    let characterField: string;
    if (dialogCharacters === null) {
      characterField = '<p class="acc-note"><span class="account-spinner" aria-hidden="true"></span>正在读取你的角色…</p>';
    } else if (available.length === 0) {
      characterField = `<p class="acc-note acc-note--warn"><i class="ph ph-warning" aria-hidden="true"></i>${dialogCharacters.length === 0
        ? "还没有可托管的角色。请先用 KoreEngine 登录角色，并在「我的 KE」里为它建好配置。"
        : "你的角色都已经登记过托管了。"}</p>`;
    } else {
      characterField = `<div class="kc-char-list" role="radiogroup" aria-label="选择角色">${available.map((character, index) => {
        const server = SERVER_LABELS[character.nid]?.label ?? `服务器 ${character.nid}`;
        return `<label class="kc-char-option"><input type="radio" name="kc-character" value="${escapeHtml(characterKey(character))}" ${index === 0 ? "checked" : ""}><span><b>${escapeHtml(character.char_name)}</b><small>${escapeHtml(server)}${character.map_name ? ` · ${escapeHtml(character.map_name)}` : ""}</small></span></label>`;
      }).join("")}</div>`;
    }
    return `<div class="account-modal-overlay" data-kc-overlay>
      <div class="account-modal" role="dialog" aria-modal="true" aria-labelledby="kc-dialog-title">
        <h2 id="kc-dialog-title">添加托管角色</h2>
        <p class="account-modal-hint">选择角色并填写它所在的游戏账号。账号密码会加密保存在服务器，只用于让托管服务器替你登录游戏。</p>
        <form id="kc-form" novalidate>
          <fieldset class="account-server"><legend>角色</legend>${characterField}</fieldset>
          <label for="kc-game-account">游戏账号<input id="kc-game-account" name="kc-game-account" autocomplete="off" maxlength="64" placeholder="例如 game123"></label>
          <label for="kc-game-password">游戏密码<input id="kc-game-password" name="kc-game-password" type="password" autocomplete="off" maxlength="64" placeholder="游戏登录密码"></label>
          <label for="kc-current-password">本站登录密码<span class="account-field-hint">再确认一次，防止他人借你的登录状态登记账号</span><input id="kc-current-password" name="kc-current-password" type="password" autocomplete="current-password" maxlength="128" placeholder="你在本站的登录密码"></label>
          <p class="kc-warning"><i class="ph ph-shield-warning" aria-hidden="true"></i>托管期间请不要在其他设备登录这个角色，否则会互相顶下线；被顶下线后系统会等 30 分钟再重试，避免抢号。</p>
          <p class="account-modal-status${dialogError ? " is-error" : ""}" role="status" aria-live="polite">${escapeHtml(dialogError)}</p>
          <div class="account-modal-actions">
            <span class="account-modal-spacer"></span>
            <button type="button" class="secondary-button" data-kc-close-dialog ${dialogBusy ? "disabled" : ""}>取消</button>
            <button type="submit" ${dialogBusy || available.length === 0 ? "disabled" : ""}>${dialogBusy ? "正在保存…" : "保存托管角色"}</button>
          </div>
        </form>
      </div>
    </div>`;
  }

  function render(): void {
    const buyAfterError = noticeTone === "error" && unentitled() ? ` <a href="${BUY_URL}">${lapsed(unentitled()!) ? "去续费" : "去开通"} →</a>` : "";
    const noticeMarkup = notice ? `<p class="accounts-status kc-notice${noticeTone ? ` is-${noticeTone}` : ""}" role="status" aria-live="polite">${escapeHtml(notice)}${buyAfterError}</p>` : '<p class="accounts-status kc-notice" role="status" aria-live="polite"></p>';
    if (view.kind === "loading") {
      root.innerHTML = '<p class="acc-note kc-loading"><span class="account-spinner" aria-hidden="true"></span>正在读取托管状态…</p>';
      return;
    }
    if (view.kind === "anonymous") {
      root.innerHTML = `<div class="accounts-empty kc-empty">
        <i class="ph ph-sign-in" aria-hidden="true"></i>
        <h3>登录后管理离线挂机</h3>
        <p>离线挂机把你的角色交给服务器 24 小时挂机。登录账号后，可以在这里添加角色、启动、停止并查看状态。</p>
        <button type="button" data-open-login><i class="ph ph-sign-in" aria-hidden="true"></i> 登录账号</button>
      </div>`;
      return;
    }
    if (view.kind === "error") {
      root.innerHTML = `<div class="accounts-empty kc-empty"><i class="ph ph-warning" aria-hidden="true"></i><h3>暂时读不到托管状态</h3><p>${escapeHtml(view.message)}</p><button type="button" data-kc-reload><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 重试</button></div>`;
      return;
    }
    const { eligibility, items } = view;
    const canAdd = eligibility.eligible;
    root.innerHTML = `
      ${statsMarkup(eligibility, items)}
      ${eligibility.has_hosting ? "" : upsellMarkup(eligibility)}
      <div class="section-heading accounts-heading kc-heading">
        <div><p class="eyebrow">离线挂机</p><h2>托管角色</h2></div>
        <div class="accounts-toolbar">
          <button type="button" class="secondary-button" data-kc-reload><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 刷新</button>
          ${eligibility.has_hosting
            ? `<button type="button" data-kc-open-dialog ${canAdd ? "" : "disabled"} title="${canAdd ? "" : "实例额度不足，无法添加"}"><i class="ph ph-plus" aria-hidden="true"></i> 添加角色</button>`
            : `<a class="kc-link-button" href="${BUY_URL}"><i class="ph ph-shopping-cart" aria-hidden="true"></i> ${lapsed(eligibility) ? "续费离线挂机" : "开通离线挂机"}</a>`}
        </div>
      </div>
      ${items.length > 0 ? `<div class="accounts-grid kc-grid" aria-live="polite">${items.map(cardMarkup).join("")}</div>` : emptyMarkup(eligibility)}
      ${noticeMarkup}
      <p class="kc-foot">状态随游戏进程的心跳（约每 5 分钟）更新；启动、停止过程中页面会自动刷新，其余时候需要最新状态请点「刷新」。</p>
      ${dialogMarkup()}
      ${deathDialog ? deathDialogMarkup(deathDialog) : ""}`;
  }

  async function load(silent = false): Promise<void> {
    const sequence = ++loadSequence;
    const state = store.getState();
    if (state.status !== "active") {
      view = state.status === "loading" ? { kind: "loading" } : { kind: "anonymous" };
      render();
      return;
    }
    if (!silent && view.kind !== "ready") {
      view = { kind: "loading" };
      render();
    }
    try {
      const data = await api.load();
      if (disposed || sequence !== loadSequence) return;
      view = { kind: "ready", eligibility: data.eligibility, items: data.items };
    } catch (error) {
      if (disposed || sequence !== loadSequence) return;
      view = { kind: "error", message: errorText(error, "托管服务暂时不可用，请稍后重试") };
    }
    render();
    schedulePoll();
    void refreshDeathCounts();
  }

  /** 读各个托管实例的死亡记录条数（失败或没有就不显示按钮）；有变化才重画，打开弹窗时不打扰。 */
  async function refreshDeathCounts(): Promise<void> {
    const deaths = api.deaths;
    if (!deaths || view.kind !== "ready") return;
    let changed = false;
    await Promise.all(view.items.map(async (entry) => {
      try {
        const total = (await deaths.list(entry.id)).items.length;
        if (deathCounts.get(entry.id) !== total) { deathCounts.set(entry.id, total); changed = true; }
      } catch {
        // 读不到就保持原样。
      }
    }));
    if (changed && !disposed && !deathDialog && !dialogOpen) render();
  }

  async function openDeaths(instanceId: string): Promise<void> {
    const deaths = api.deaths;
    const entry = view.kind === "ready" ? view.items.find((candidate) => candidate.id === instanceId) : undefined;
    if (!deaths || !entry) return;
    deathDialog = { instanceId, charName: entry.char_name, loading: true, error: "", list: null, selectedKey: null, detail: null, fixBusy: null, fixError: "" };
    render();
    try {
      const list = await deaths.list(instanceId);
      if (!deathDialog || deathDialog.instanceId !== instanceId) return;
      deathCounts.set(instanceId, list.items.length);
      deathDialog = { ...deathDialog, loading: false, list };
      render();
      if (list.items[0]) await pickDeath(list.items[0].reportKey);
    } catch (error) {
      if (!deathDialog) return;
      deathDialog = { ...deathDialog, loading: false, error: errorText(error, "读取死亡记录失败，请稍后重试") };
      render();
    }
  }

  async function pickDeath(reportKey: string): Promise<void> {
    const deaths = api.deaths;
    if (!deaths || !deathDialog) return;
    const instanceId = deathDialog.instanceId;
    deathDialog = { ...deathDialog, selectedKey: reportKey, detail: null, fixError: "" };
    render();
    try {
      const detail = await deaths.get(instanceId, reportKey);
      if (!deathDialog || deathDialog.selectedKey !== reportKey) return;
      deathDialog = { ...deathDialog, detail };
    } catch (error) {
      if (!deathDialog) return;
      deathDialog = { ...deathDialog, fixError: errorText(error, "读取这份报告失败，请稍后重试") };
    }
    render();
  }

  async function applyDeathFix(fixId: string, action: "apply" | "undo"): Promise<void> {
    const deaths = api.deaths;
    const dialog = deathDialog;
    if (!deaths || !dialog || !dialog.selectedKey || !dialog.detail || dialog.fixBusy) return;
    const reportKey = dialog.selectedKey;
    deathDialog = { ...dialog, fixBusy: fixId, fixError: "" };
    render();
    try {
      const fixesState = await deaths.fix(dialog.instanceId, reportKey, fixId, action);
      if (!deathDialog || deathDialog.selectedKey !== reportKey || !deathDialog.detail) return;
      deathDialog = { ...deathDialog, fixBusy: null, detail: { ...deathDialog.detail, fixesState } };
      const list = await deaths.list(dialog.instanceId).catch(() => null);
      if (list && deathDialog) deathDialog = { ...deathDialog, list };
    } catch (error) {
      if (!deathDialog) return;
      deathDialog = { ...deathDialog, fixBusy: null, fixError: errorText(error, "应用失败，请稍后重试") };
    }
    render();
  }

  function closeDeaths(): void {
    deathDialog = null;
    render();
  }

  /** 有实例处于启动 / 停止过渡中时，隔几秒静默重新读取，直到全部落定。 */
  function schedulePoll(): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    const settling = view.kind === "ready" && view.items.some((entry) => SETTLING_PHASES.has(entry.phase));
    if (!settling) { pollCount = 0; return; }
    if (disposed || pollCount >= POLL_MAX) return;
    pollCount += 1;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      // 添加对话框打开时重画会清掉正在输入的内容，先跳过这一次。
      if (dialogOpen || deathDialog) schedulePoll(); else void load(true);
    }, pollMs);
  }

  function setNotice(text: string, tone: "ok" | "error" | ""): void {
    notice = text;
    noticeTone = tone;
  }

  async function act(id: string, run: () => Promise<void>, doing: string, done: string): Promise<void> {
    if (busyIds.has(id)) return;
    pollCount = 0;
    busyIds = new Set(busyIds).add(id);
    setNotice(doing, "");
    render();
    try {
      await run();
      setNotice(done, "ok");
    } catch (error) {
      setNotice(errorText(error, "操作失败，请稍后重试"), "error");
    } finally {
      const next = new Set(busyIds);
      next.delete(id);
      busyIds = next;
    }
    await load(true);
  }

  function disarm(): void {
    armedDelete = null;
    if (armedTimer) clearTimeout(armedTimer);
    armedTimer = null;
  }

  async function openDialog(): Promise<void> {
    dialogOpen = true;
    dialogError = "";
    dialogBusy = false;
    dialogCharacters = null;
    render();
    root.querySelector<HTMLInputElement>("#kc-game-account")?.focus();
    try {
      dialogCharacters = await api.characters();
    } catch (error) {
      dialogCharacters = [];
      dialogError = errorText(error, "读取角色失败，请稍后重试");
    }
    if (dialogOpen) render();
  }

  function closeDialog(): void {
    dialogOpen = false;
    dialogError = "";
    render();
  }

  async function submitDialog(form: HTMLFormElement): Promise<void> {
    if (dialogBusy) return;
    const selected = form.querySelector<HTMLInputElement>('input[name="kc-character"]:checked')?.value;
    const character = (dialogCharacters ?? []).find((entry) => characterKey(entry) === selected);
    const gameAccount = form.querySelector<HTMLInputElement>("#kc-game-account")!.value.trim();
    const gamePassword = form.querySelector<HTMLInputElement>("#kc-game-password")!.value;
    const currentPassword = form.querySelector<HTMLInputElement>("#kc-current-password")!.value;
    if (!character) { dialogError = "请先选择一个角色。"; render(); return; }
    if (!gameAccount || !gamePassword) { dialogError = "请填写游戏账号和游戏密码。"; render(); return; }
    if (!currentPassword) { dialogError = "请输入你在本站的登录密码。"; render(); return; }
    dialogBusy = true;
    dialogError = "";
    render();
    try {
      await api.create({
        nid: character.nid, aid: character.aid, cid: character.cid, charName: character.char_name,
        gameAccount, gamePassword, currentPassword,
      });
      dialogOpen = false;
      dialogBusy = false;
      setNotice(`已登记「${character.char_name}」。点卡片上的「启动」开始托管。`, "ok");
      await load(true);
    } catch (error) {
      dialogBusy = false;
      dialogError = errorText(error, "保存失败，请稍后重试");
      render();
    }
  }

  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const pick = <T extends string>(attribute: T): string | null => target.closest<HTMLElement>(`[${attribute}]`)?.getAttribute(attribute) ?? null;
    const start = pick("data-kc-start");
    if (start) { void act(start, () => api.start(start), "正在启动…", "已提交启动，托管服务器会在一分钟内接手。"); return; }
    const sync = pick("data-kc-sync");
    if (sync) { void act(sync, () => api.syncConfig(sync), "正在提交…", "已提交，托管服务器会在 1～2 分钟内拉取最新配置并重载。"); return; }
    const deathsId = pick("data-kc-deaths");
    if (deathsId) { void openDeaths(deathsId); return; }
    if (deathDialog) {
      const pickKey = pick("data-kc-death-pick");
      if (pickKey) { void pickDeath(pickKey); return; }
      const applyId = pick("data-kc-fix");
      if (applyId) { void applyDeathFix(applyId, "apply"); return; }
      const undoId = pick("data-kc-fix-undo");
      if (undoId) { void applyDeathFix(undoId, "undo"); return; }
      const copyId = pick("data-kc-fix-copy");
      if (copyId) {
        const text = deathDialog.detail?.report.fixes.find((fix) => fix.id === copyId)?.to ?? "";
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        return;
      }
      if (target.closest("[data-kc-death-close]") || target.matches("[data-kc-death-overlay]")) { closeDeaths(); return; }
    }
    const stop = pick("data-kc-stop");
    if (stop) { void act(stop, () => api.stop(stop), "正在停止…", "已提交停止，进程会先让角色正常下线。"); return; }
    const statsId = pick("data-kc-run");
    if (statsId) {
      if (runOpen.has(statsId)) runOpen.delete(statsId); else runOpen.add(statsId);
      render();
      return;
    }
    const remove = pick("data-kc-delete");
    if (remove) {
      if (armedDelete === remove) {
        disarm();
        void act(remove, () => api.remove(remove), "正在删除…", "已删除，保存的游戏密码一并清除。");
      } else {
        disarm();
        armedDelete = remove;
        armedTimer = setTimeout(() => { armedDelete = null; if (!disposed) render(); }, DELETE_ARM_MS);
        render();
      }
      return;
    }
    if (target.closest("[data-kc-reload]")) { setNotice("", ""); pollCount = 0; void load(); return; }
    if (target.closest("[data-kc-open-dialog]")) { void openDialog(); return; }
    if (target.closest("[data-kc-close-dialog]")) { closeDialog(); return; }
    if (target.matches("[data-kc-overlay]")) closeDialog();
  };
  const onSubmit = (event: Event): void => {
    const form = event.target as HTMLFormElement | null;
    if (form?.id !== "kc-form") return;
    event.preventDefault();
    void submitDialog(form);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && deathDialog) { closeDeaths(); return; }
    if (event.key === "Escape" && dialogOpen && !dialogBusy) closeDialog();
  };

  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  document.addEventListener("keydown", onKey);

  const unsubscribe = store.subscribe((state) => {
    const userId = state.status === "active" ? state.user.id : null;
    if (userId === lastUserId && view.kind !== "loading") return;
    lastUserId = userId;
    dialogOpen = false;
    notice = "";
    void load();
  });
  void load();

  return () => {
    disposed = true;
    if (pollTimer) clearTimeout(pollTimer);
    disarm();
    unsubscribe();
    root.removeEventListener("click", onClick);
    root.removeEventListener("submit", onSubmit);
    document.removeEventListener("keydown", onKey);
  };
}
