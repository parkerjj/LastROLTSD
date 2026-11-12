// 托管页的死亡报告弹窗：报告由 KE core 生成（结论、原因、建议都已写好），这里只排版；
// 「一键应用」把建议交给 LTSD 服务端去改配置并让托管进程重载。
import type { AuthApiClient } from "./auth/api";
import "./ke-death-report.css";

export interface HpPoint { tMs: number; pct: number }
export interface HpMark { tMs: number; kind: string; label: string }
export interface DeathFix {
  id: string;
  title: string;
  why: string;
  from: string;
  to: string;
  patch?: unknown;
}
export interface DeathReport {
  reportVersion: number;
  id: string;
  atMs: number;
  aiMode: string;
  activity: string;
  character: { name: string };
  map: { name: string; x: number; y: number };
  killer: { kind: string; mobId?: number; name: string; skillName: string; damage: number };
  summary: { title: string; reason: string };
  cause: string;
  causeLabel: string;
  totalDamage: number;
  hp: { points: HpPoint[]; marks: HpMark[]; teleportHpLine?: number | null };
  sources: Array<{ name: string; count: number; hits: number; skills: Array<{ name: string; hits: number }>; damage: number; sharePct: number }>;
  timeline: Array<{ tMs: number; text: string; severity: string }>;
  state: { statuses: string[]; weightPct?: number | null; consumables: Array<{ name: string; amount: number; warn: boolean }> };
  fixes: DeathFix[];
  log: Array<{ tMs: number; level: string; domain: string; text: string }>;
}

export interface FixState { status: "applied" | "reverted"; at: number; revert: unknown }
export type FixesState = Record<string, FixState>;

export interface DeathListItem {
  reportKey: string;
  diedAt: number;
  map: string;
  killerName: string;
  skillName: string;
  causeLabel: string;
  fixesTotal: number;
  fixesApplied: number;
}
export interface DeathListResponse {
  items: DeathListItem[];
  stats: {
    last7Days: number;
    perDay7: number[];
    topKiller: { name: string; count: number } | null;
    topCause: { label: string; count: number } | null;
    fixesApplied: number;
    fixesTotal: number;
  };
  profileName: string | null;
}

export interface DeathApi {
  list(instanceId: string): Promise<DeathListResponse>;
  get(instanceId: string, reportKey: string): Promise<{ report: DeathReport; fixesState: FixesState }>;
  fix(instanceId: string, reportKey: string, fixId: string, action: "apply" | "undo"): Promise<FixesState>;
}

export function createDeathApi(api: Pick<AuthApiClient, "sessionRead" | "sessionRequest">): DeathApi {
  const base = (id: string) => `/api/v1/ke/hosted/${encodeURIComponent(id)}/death-reports`;
  return {
    list: (id) => api.sessionRead<DeathListResponse>(base(id)),
    get: (id, key) => api.sessionRead<{ report: DeathReport; fixesState: FixesState }>(`${base(id)}/${encodeURIComponent(key)}`),
    async fix(id, key, fixId, action) {
      const body = await api.sessionRequest<{ fixesState: FixesState }>(`${base(id)}/${encodeURIComponent(key)}/fixes/${encodeURIComponent(fixId)}`, "POST", { action });
      return body.fixesState;
    },
  };
}

export interface DeathDialogState {
  instanceId: string;
  charName: string;
  loading: boolean;
  error: string;
  list: DeathListResponse | null;
  selectedKey: string | null;
  detail: { report: DeathReport; fixesState: FixesState } | null;
  /** 正在应用/撤销的建议 id。 */
  fixBusy: string | null;
  fixError: string;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const number = new Intl.NumberFormat("zh-CN");
const fmt = (value: number): string => number.format(Number(value) || 0);
/** 报告来自 core、可被篡改：所有进 HTML 的数字也要先转成数字再转义。 */
const num = (value: unknown): string => esc(String(Number(value) || 0));

/** "MM-DD HH:MM"（UTC+8，与脱机版 App 一致）。 */
export function timeText(ms: number): string {
  const local = new Date(ms + 8 * 3600 * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
}

const seconds = (tMs: number): string => `${(tMs / 1000).toFixed(1)}s`;
const CURVE_MS = 15_000;
const xOf = (tMs: number): number => Math.min(1, Math.max(0, (tMs + CURVE_MS) / CURVE_MS)) * 100;
const yOf = (pct: number): number => 100 - Math.min(100, Math.max(0, pct));

export function hpPath(points: HpPoint[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.tMs).toFixed(1)} ${yOf(p.pct).toFixed(1)}`).join(" ");
}

const AI_MODE: Record<string, string> = { auto: "全自动", manual: "半自动", off: "AI 关闭" };

function dayBars(perDay: number[]): string {
  const max = Math.max(1, ...perDay);
  return `<svg class="kdr-bars" viewBox="0 0 160 26" role="img" aria-label="近 7 天每天死亡次数">${perDay.map((n, i) => {
    const h = n === 0 ? 2 : Math.max(6, (n / max) * 26);
    return `<rect x="${i * 23}" y="${26 - h}" width="18" height="${h}" rx="2" class="${n === 0 ? "is-zero" : ""}"></rect>`;
  }).join("")}</svg>`;
}

function statCards(list: DeathListResponse): string {
  const { stats } = list;
  const pct = stats.fixesTotal > 0 ? Math.round((stats.fixesApplied / stats.fixesTotal) * 100) : 0;
  return `<div class="kdr-stats">
    <div class="kdr-stat"><span>近 7 天死亡</span><b class="is-bad">${num(stats.last7Days)}<small>次</small></b>${dayBars(stats.perDay7)}</div>
    <div class="kdr-stat"><span>最常被谁杀</span><b class="is-killer">${esc(stats.topKiller?.name ?? "—")}</b><small>${stats.topKiller ? `${num(stats.topKiller.count)} 次` : ""}</small></div>
    <div class="kdr-stat"><span>最常见原因</span><b class="is-warn">${esc(stats.topCause?.label ?? "—")}</b><small>${stats.topCause ? `${num(stats.topCause.count)} 次` : ""}</small></div>
    <div class="kdr-stat"><span>建议已应用</span><b class="is-good">${num(stats.fixesApplied)}<small>/ ${num(stats.fixesTotal)} 条</small></b><i class="kdr-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${num(pct)}"><u style="width:${num(pct)}%"></u></i></div>
  </div>`;
}

function fixMarkup(fix: DeathFix, index: number, state: DeathDialogState): string {
  const fixState = state.detail?.fixesState[fix.id];
  const busy = state.fixBusy !== null;
  const diff = fix.to
    ? `<div class="kdr-diff">${fix.from ? `<span class="is-old">- ${esc(fix.from)}</span>` : ""}<span class="is-new">+ ${esc(fix.to)}</span></div>`
    : "";
  let action = "";
  if (fixState?.status === "applied") {
    action = `<div class="kdr-applied"><span>✓ 已应用并重载 · ${esc(timeText(fixState.at).slice(6))}</span><button type="button" class="kdr-link" data-kc-fix-undo="${esc(fix.id)}" ${busy ? "disabled" : ""}>撤销</button></div>`;
  } else if (fix.patch) {
    action = `<div class="kdr-actions"><button type="button" class="kdr-primary" data-kc-fix="${esc(fix.id)}" ${busy ? "disabled" : ""}>${state.fixBusy === fix.id ? "应用中…" : "一键应用"}</button><button type="button" class="kdr-secondary" data-kc-fix-copy="${esc(fix.id)}">复制</button></div>`;
  }
  return `<article class="kdr-card kdr-fix"><b>${index + 1}. ${esc(fix.title)}</b><p>${esc(fix.why)}</p>${diff}${action}</article>`;
}

function detailMarkup(state: DeathDialogState): string {
  const detail = state.detail;
  if (!detail) return `<p class="kdr-empty">${state.selectedKey ? "正在读取这份报告…" : "选择左边的一条记录查看报告"}</p>`;
  const { report, fixesState } = detail;
  void fixesState;
  const marks = report.hp.marks.map((m) => {
    const nearest = report.hp.points.reduce((best, p) => (Math.abs(p.tMs - m.tMs) < Math.abs(best.tMs - m.tMs) ? p : best), report.hp.points[0] ?? { tMs: 0, pct: 0 });
    return `<circle cx="${xOf(m.tMs).toFixed(1)}" cy="${yOf(nearest.pct).toFixed(1)}" r="2.2" class="kdr-mark is-${esc(m.kind)}"><title>${esc(m.label)}</title></circle>`;
  }).join("");
  const line = report.hp.teleportHpLine ? `<line x1="0" x2="100" y1="${yOf(report.hp.teleportHpLine)}" y2="${yOf(report.hp.teleportHpLine)}" class="kdr-line"></line>` : "";
  return `
    <header class="kdr-verdict">
      <span>${esc(timeText(report.atMs))} · ${esc(report.map.name)} (${num(report.map.x)}, ${num(report.map.y)}) · ${esc(AI_MODE[report.aiMode] ?? report.aiMode)}</span>
      <h3>${esc(report.summary.title)}${report.killer.damage > 0 ? `<small>致命一击 ${fmt(report.killer.damage)}</small>` : ""}</h3>
      <p>${esc(report.summary.reason)}</p>
    </header>
    ${report.fixes.length > 0 ? `<section aria-labelledby="kdr-fix-title">
      <div class="kdr-fix-head"><h4 id="kdr-fix-title">怎么避免</h4>${state.list?.profileName ? `<span>应用后保存到配置「${esc(state.list.profileName)}」并自动重载。</span>` : ""}</div>
      ${state.fixError ? `<p class="kdr-error" role="alert">${esc(state.fixError)}</p>` : ""}
      <div class="kdr-fixes">${report.fixes.map((fix, i) => fixMarkup(fix, i, state)).join("")}</div>
    </section>` : ""}
    <div class="kdr-two">
      <section class="kdr-card"><div class="kdr-card-head"><b>死前 15 秒的 HP</b><small>共受到 ${fmt(report.totalDamage)} 伤害</small></div>
        <svg class="kdr-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="死前 15 秒 HP 曲线">${line}<path d="${hpPath(report.hp.points)}" class="kdr-hp"></path>${marks}</svg>
        <div class="kdr-legend"><span>-15s</span><span class="is-warn">虚线：瞬移血线</span><span>死亡</span></div>
        <div class="kdr-legend2"><span><i class="is-potion"></i>吃药</span><span><i class="is-teleportFailed"></i>想瞬移，失败</span></div>
      </section>
      <section class="kdr-card"><b>伤害来自</b>${report.sources.map((s) => `<div class="kdr-source"><div><span>${esc(s.name)}${s.count > 1 ? ` ×${num(s.count)}` : ""}<small>${esc(s.skills.map((k) => `${k.name} ${k.hits}`).join(" · "))}</small></span><b>${fmt(s.damage)}</b></div><i class="kdr-meter is-hp"><u style="width:${num(Math.min(100, Number(s.sharePct) || 0))}%"></u></i></div>`).join("")}
        <div class="kdr-chips">${(report.state.statuses.length ? report.state.statuses.map((s) => `<span class="is-warn">${esc(s)}</span>`) : ["<span>无异常状态</span>"]).join("")}${report.state.weightPct != null ? `<span>负重 ${num(report.state.weightPct)}%</span>` : ""}${report.state.consumables.map((c) => `<span class="${c.warn ? "is-warn" : ""}">${esc(c.name)} ×${num(c.amount)}</span>`).join("")}</div>
      </section>
    </div>
    <section class="kdr-card"><b>KE 当时做了什么</b><ol class="kdr-timeline">${report.timeline.map((t) => `<li class="is-${esc(t.severity)}"><code>${esc(seconds(t.tMs))}</code><span>${esc(t.text)}</span></li>`).join("")}</ol></section>
    <details class="kdr-log"><summary>展开原始日志（${report.log.length} 行，排查用）</summary><pre>${esc(report.log.map((l) => `${seconds(l.tMs)} ${l.text}`).join("\n"))}</pre></details>`;
}

export function deathDialogMarkup(state: DeathDialogState): string {
  const list = state.list;
  const body = state.loading && !list
    ? '<p class="kdr-empty">正在读取死亡记录…</p>'
    : state.error
      ? `<p class="kdr-error" role="alert">${esc(state.error)}</p>`
      : list
        ? `${statCards(list)}
          <div class="kdr-body">
            <ul class="kdr-list" aria-label="死亡记录">${list.items.map((item) => `<li><button type="button" class="${item.reportKey === state.selectedKey ? "is-selected" : ""}" data-kc-death-pick="${esc(item.reportKey)}"><span><em>${esc(timeText(item.diedAt))}</em><em>${esc(item.map)}</em></span><b>被 ${esc(item.killerName)} 的「${esc(item.skillName)}」打死</b><u>${esc(item.causeLabel)}</u></button></li>`).join("")}</ul>
            <article class="kdr-detail" aria-label="死亡报告详情">${detailMarkup(state)}</article>
          </div>`
        : "";
  return `<div class="account-modal-overlay kdr-overlay" data-kc-death-overlay>
    <div class="kdr" role="dialog" aria-modal="true" aria-labelledby="kdr-title">
      <header class="kdr-head"><h2 id="kdr-title">${esc(state.charName)} · 死亡报告</h2><button type="button" class="kdr-close" aria-label="关闭" data-kc-death-close>✕</button></header>
      ${body}
    </div>
  </div>`;
}
