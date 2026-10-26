// 管理员后台「角色转移」区块：先分析两个账号的关联度，再由管理员填写备注确认转移。
// 所有来自接口的文本（角色名、证据、城市、ASN 等）一律用 textContent 渲染，禁止拼进 innerHTML；
// transferSectionMarkup() 只返回不含任何接口数据的静态骨架。

import type { AuthApiClient } from "./auth/api";

export interface AdminTransferDeps {
  get<T>(path: string): Promise<T>;
  auth: Pick<AuthApiClient, "sessionRequest">;
}

// 以下接口与 apps/worker/src/admin/transfer-service.ts、transfer-analysis.ts 的响应保持一致。
interface TransferCharacter {
  aid: number;
  cid: number;
  nid: number;
  char_name: string;
  base_level: number | null;
  job_level: number | null;
  job_id: number | null;
  bound_at: number | null;
}

interface TransferUser {
  id: number;
  email: string;
  display_name: string;
}

type EvidenceKind = "strong" | "weak" | "counter";
type Verdict = "HIGH" | "POSSIBLE" | "NONE" | "INSUFFICIENT";

interface Evidence {
  rule: string;
  kind: EvidenceKind;
  points: number;
  text: string;
  redacted_text: string;
  event_ids: number[];
}

interface TransferAnalysis {
  score: number;
  verdict: Verdict;
  evidence: Evidence[];
  notes: string[];
}

interface TimelineRow {
  id: number;
  side: "source" | "target";
  event: string;
  result: "SUCCESS" | "FAILURE";
  created_at: number;
  source: "live" | "backfill";
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  as_org: string | null;
  is_hosting: boolean;
  fingerprint_short: string | null;
  device_short: string | null;
  aid: number | null;
}

interface TransferPreview {
  source: TransferUser;
  target: TransferUser;
  character: TransferCharacter;
  analysis: TransferAnalysis;
  timeline: TimelineRow[];
}

const TIMELINE_PAGE_SIZE = 200;

const EVENT_LABELS: Record<string, string> = {
  REGISTER: "注册",
  EMAIL_VERIFIED: "验证邮箱",
  LOGIN: "登录",
  PASSWORD_RESET_REQUEST: "申请找回密码",
  PASSWORD_RESET: "重置密码",
  PASSWORD_CHANGE: "修改密码",
  KE_DEVICE_APPROVE: "批准 KE 设备",
  KE_DEVICE_TOKEN: "KE 设备授权",
  KE_BIND: "KE 绑定角色",
  KE_START: "KE 启动",
  KE_HEARTBEAT: "KE 运行（IP 变化）",
  GUESTBOOK_POST: "留言板发帖",
  GUESTBOOK_REPLY: "留言板回复",
  ADMIN_CHARACTER_TRANSFER: "后台角色转移",
};

const VERDICT_LABELS: Record<Verdict, string> = {
  HIGH: "HIGH 高度疑似同一人",
  POSSIBLE: "POSSIBLE 可能是同一人",
  NONE: "NONE 无明显关联",
  INSUFFICIENT: "INSUFFICIENT 数据不足，无法判断",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** 编号 ①…⑳，超过 20 用 (21) 形式。 */
function marker(index: number): string {
  return index <= 20 ? String.fromCodePoint(0x245f + index) : `(${index})`;
}

function formatPoints(points: number): string {
  return points > 0 ? `+${points}` : String(points);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function describeRow(row: TimelineRow): string {
  const place = [row.city, row.region, row.country].filter(Boolean).join(", ");
  return `${EVENT_LABELS[row.event] ?? row.event}${row.result === "FAILURE" ? "（失败）" : ""} · ${row.ip ?? "—"} · ${place} · ${row.as_org ?? ""}${row.is_hosting ? " · 机房/VPN" : ""}${row.fingerprint_short ? ` · 指纹 #${row.fingerprint_short}` : ""}${row.source === "backfill" ? " · 补数" : ""}`;
}

export function transferSectionMarkup(): string {
  return `
      <section class="adm-card" aria-labelledby="adm-tr-title">
        <h2 id="adm-tr-title">角色转移</h2>
        <p class="adm-hint">第 1 步：查询源账号名下的角色；第 2 步：填写目标账号并先做关联分析，确认无误后填写备注再转移。</p>
        <h3>第 1 步 · 选择角色</h3>
        <form id="adm-tr-source-form" class="adm-row">
          <input id="adm-tr-source" type="text" placeholder="源账号 ID 或邮箱" autocomplete="off">
          <button type="submit" id="adm-tr-query" class="adm-btn adm-btn-primary">查询角色</button>
        </form>
        <select id="adm-tr-character" class="adm-tr-select" hidden></select>
        <h3>第 2 步 · 目标账号</h3>
        <form id="adm-tr-target-form" class="adm-row">
          <input id="adm-tr-target" type="text" placeholder="目标账号 ID 或邮箱" autocomplete="off">
          <button type="submit" id="adm-tr-analyze" class="adm-btn adm-btn-primary">转移（先分析）</button>
        </form>
        <p id="adm-tr-status" class="adm-status" role="status" aria-live="polite"></p>
        <div id="adm-tr-report" class="adm-tr-report" hidden>
          <div id="adm-tr-verdict" class="adm-tr-verdict"></div>
          <div class="adm-tr-cols">
            <div><h3>强证据</h3><ul id="adm-tr-col-strong" class="adm-tr-evidence"></ul></div>
            <div id="adm-tr-col-right"><h3>弱证据</h3><ul id="adm-tr-col-weak" class="adm-tr-evidence"></ul><h3>反向 / 降权</h3><ul id="adm-tr-col-counter" class="adm-tr-evidence"></ul></div>
          </div>
          <ul id="adm-tr-notes" class="adm-tr-notes"></ul>
          <div class="adm-head">
            <h3>操作时间线</h3>
            <label class="adm-tr-toggle"><input type="checkbox" id="adm-tr-only-hl"> 只看高亮行</label>
          </div>
          <div class="adm-table-wrap">
            <table id="adm-tr-timeline" class="adm-table">
              <thead><tr><th>时间</th><th>账号 A</th><th>账号 B</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
          <button type="button" id="adm-tr-more" class="adm-btn adm-btn-ghost" hidden>显示更多</button>
          <div class="adm-form adm-tr-confirm">
            <label>审核备注<input id="adm-tr-note" maxlength="200" autocomplete="off" placeholder="例：玩家提供了截图，同一人，同意转移"></label>
            <button type="button" id="adm-tr-confirm" class="adm-btn adm-btn-danger">确认转移</button>
            <button type="button" id="adm-tr-cancel" class="adm-btn adm-btn-ghost">取消</button>
          </div>
        </div>
      </section>`;
}

export function mountAdminTransfer(root: HTMLElement, deps: AdminTransferDeps): void {
  const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const sourceForm = q<HTMLFormElement>("#adm-tr-source-form");
  const sourceInput = q<HTMLInputElement>("#adm-tr-source");
  const characterSelect = q<HTMLSelectElement>("#adm-tr-character");
  const targetForm = q<HTMLFormElement>("#adm-tr-target-form");
  const targetInput = q<HTMLInputElement>("#adm-tr-target");
  const analyzeButton = q<HTMLButtonElement>("#adm-tr-analyze");
  const status = q<HTMLElement>("#adm-tr-status");
  const report = q<HTMLElement>("#adm-tr-report");
  const verdictBar = q<HTMLElement>("#adm-tr-verdict");
  const columns: Record<EvidenceKind, HTMLElement> = {
    strong: q("#adm-tr-col-strong"),
    weak: q("#adm-tr-col-weak"),
    counter: q("#adm-tr-col-counter"),
  };
  const notesList = q<HTMLElement>("#adm-tr-notes");
  const onlyHighlighted = q<HTMLInputElement>("#adm-tr-only-hl");
  const timelineBody = q<HTMLElement>("#adm-tr-timeline tbody");
  const moreButton = q<HTMLButtonElement>("#adm-tr-more");
  const noteInput = q<HTMLInputElement>("#adm-tr-note");
  const confirmButton = q<HTMLButtonElement>("#adm-tr-confirm");
  const cancelButton = q<HTMLButtonElement>("#adm-tr-cancel");

  /** 查询角色时使用的源账号文本；之后改输入框不影响已选角色的归属。 */
  let sourceAccount = "";
  /** 当前报告对应的请求；确认时用的是预览时的值，而不是输入框里可能已被改动的值。 */
  let current: { source: string; target: string; aid: number; cid: number; nid: number; preview: TransferPreview } | null = null;
  let markers = new Map<number, string[]>();
  let visibleLimit = TIMELINE_PAGE_SIZE;

  function say(text: string, isError = false): void {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  }

  function clearReport(): void {
    current = null;
    report.hidden = true;
    timelineBody.replaceChildren();
    noteInput.value = "";
    onlyHighlighted.checked = false;
  }

  /* ---- 第 1 步：查询角色 ---- */

  async function queryCharacters(): Promise<void> {
    const account = sourceInput.value.trim();
    if (account === "") {
      say("请填写源账号 ID 或邮箱", true);
      return;
    }
    say("");
    clearReport();
    try {
      const body = await deps.get<{ characters: TransferCharacter[] }>(`/api/v1/admin/transfer/characters?account=${encodeURIComponent(account)}`);
      sourceAccount = account;
      characterSelect.replaceChildren();
      for (const character of body.characters) {
        const option = el("option", undefined, `${character.char_name}（aid ${character.aid} · Lv ${character.base_level ?? "?"}/${character.job_level ?? "?"}）`);
        option.value = `${character.aid}:${character.cid}:${character.nid}`;
        characterSelect.append(option);
      }
      characterSelect.hidden = body.characters.length === 0;
      if (body.characters.length === 0) say("该账号名下没有绑定角色");
    } catch (error) {
      characterSelect.replaceChildren();
      characterSelect.hidden = true;
      say(describeError(error, "查询角色失败，请重试。"), true);
    }
  }

  /* ---- 第 2 步：分析报告 ---- */

  function renderEvidence(analysis: TransferAnalysis): void {
    markers = new Map();
    for (const list of Object.values(columns)) list.replaceChildren();
    let counter = 0;
    for (const evidence of analysis.evidence) {
      const item = el("li");
      if (evidence.event_ids.length > 0) {
        counter += 1;
        const label = marker(counter);
        const jump = el("button", "adm-tr-mark", label);
        jump.type = "button";
        jump.addEventListener("click", () => {
          for (const id of evidence.event_ids) {
            const target = timelineBody.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
            if (target !== null) {
              target.scrollIntoView?.({ block: "center" });
              return;
            }
          }
        });
        item.append(jump);
        for (const id of evidence.event_ids) markers.set(id, [...(markers.get(id) ?? []), label]);
      }
      item.append(el("span", undefined, evidence.text), el("span", "adm-tr-points", formatPoints(evidence.points)));
      columns[evidence.kind].append(item);
    }
  }

  function renderTimeline(): void {
    if (current === null) return;
    const rows = current.preview.timeline.filter((row) => !onlyHighlighted.checked || markers.has(row.id));
    timelineBody.replaceChildren();
    for (const row of rows.slice(0, visibleLimit)) {
      const labels = markers.get(row.id);
      const tr = el("tr", labels === undefined ? undefined : "adm-tr-hl");
      tr.dataset.rowId = String(row.id);
      const time = el("td", undefined, formatTime(row.created_at));
      if (labels !== undefined) time.prepend(el("span", "adm-tr-mark", labels.join("")), " ");
      const description = describeRow(row);
      tr.append(time, el("td", undefined, row.side === "source" ? description : ""), el("td", undefined, row.side === "target" ? description : ""));
      timelineBody.append(tr);
    }
    moreButton.hidden = rows.length <= visibleLimit;
  }

  function renderReport(next: NonNullable<typeof current>): void {
    current = next;
    const { analysis } = next.preview;
    verdictBar.replaceChildren(
      document.createTextNode(`结论：${VERDICT_LABELS[analysis.verdict] ?? analysis.verdict}\u3000`),
      el("span", analysis.verdict === "INSUFFICIENT" ? "adm-tr-muted" : undefined, `关联分 ${analysis.score} / 100`),
    );
    renderEvidence(analysis);
    notesList.replaceChildren(...analysis.notes.map((note) => el("li", undefined, note)));
    visibleLimit = TIMELINE_PAGE_SIZE;
    onlyHighlighted.checked = false;
    noteInput.value = "";
    report.hidden = false;
    renderTimeline();
  }

  async function analyze(): Promise<void> {
    const target = targetInput.value.trim();
    if (characterSelect.value === "" || sourceAccount === "") {
      say("请先查询源账号并选择角色", true);
      return;
    }
    if (target === "") {
      say("请填写目标账号 ID 或邮箱", true);
      return;
    }
    const [aid, cid, nid] = characterSelect.value.split(":").map(Number) as [number, number, number];
    const params = `source=${encodeURIComponent(sourceAccount)}&target=${encodeURIComponent(target)}&aid=${aid}&cid=${cid}&nid=${nid}`;
    say("");
    clearReport();
    analyzeButton.disabled = true;
    try {
      const preview = await deps.get<TransferPreview>(`/api/v1/admin/transfer/preview?${params}`);
      renderReport({ source: sourceAccount, target, aid, cid, nid, preview });
    } catch (error) {
      say(describeError(error, "分析失败，请重试。"), true);
    } finally {
      analyzeButton.disabled = false;
    }
  }

  /* ---- 确认转移 ---- */

  async function confirm(): Promise<void> {
    if (current === null) return;
    const note = noteInput.value.trim();
    if (note === "") {
      say("请填写审核备注", true);
      return;
    }
    const { source, target, aid, cid, nid, preview } = current;
    confirmButton.disabled = true;
    try {
      await deps.auth.sessionRequest("/api/v1/admin/transfer", "POST", { source, target, aid, cid, nid, note });
      clearReport();
      sourceInput.value = "";
      targetInput.value = "";
      sourceAccount = "";
      characterSelect.replaceChildren();
      characterSelect.hidden = true;
      say(`已转移：${preview.character.char_name} → ${preview.target.email}`);
    } catch (error) {
      say(describeError(error, "转移失败，请重试。"), true);
    } finally {
      confirmButton.disabled = false;
    }
  }

  sourceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void queryCharacters();
  });
  targetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void analyze();
  });
  onlyHighlighted.addEventListener("change", () => {
    visibleLimit = TIMELINE_PAGE_SIZE;
    renderTimeline();
  });
  moreButton.addEventListener("click", () => {
    visibleLimit += TIMELINE_PAGE_SIZE;
    renderTimeline();
  });
  confirmButton.addEventListener("click", () => void confirm());
  cancelButton.addEventListener("click", () => {
    clearReport();
    say("");
  });
}
