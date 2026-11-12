// 管理后台：托管死亡统计（按 地图 × 怪物 × 致命技能 汇总，只含托管版上传的记录，不显示角色名）。

export interface DeathStatsRow {
  map: string;
  mobId: number | null;
  mobName: string;
  skillName: string;
  deaths: number;
  characters: number;
  topCause: string;
}
export interface DeathStats {
  total: number;
  characters: number;
  topCause: string | null;
  rows: DeathStatsRow[];
}

export interface DeathStatsDeps {
  get(path: string): Promise<DeathStats>;
}

const esc = (value: unknown): string =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export function deathStatsSectionMarkup(): string {
  return `<div id="adm-death"><section class="adm-card" aria-labelledby="adm-death-title">
    <div class="adm-head">
      <h2 id="adm-death-title">托管死亡统计</h2>
      <span class="adm-row" role="group" aria-label="统计范围">
        <button type="button" class="adm-btn adm-btn-primary" data-days="7" aria-pressed="true">近 7 天</button>
        <button type="button" class="adm-btn adm-btn-ghost" data-days="30" aria-pressed="false">近 30 天</button>
      </span>
    </div>
    <div id="adm-death-body"><p class="adm-hint">正在读取…</p></div>
    <p class="adm-hint">只统计托管版上传的记录，不含脱机版；不显示角色名，只按地图、怪物、技能汇总。</p>
  </section></div>`;
}

/** 绑定交互；返回 start：确认是管理员、后台显示出来之后再调用，才会发请求。 */
export function mountDeathStats(root: HTMLElement, deps: DeathStatsDeps): () => void {
  const body = root.querySelector<HTMLElement>("#adm-death-body")!;
  let sequence = 0;

  const render = (data: DeathStats): void => {
    body.innerHTML = `<p class="adm-hint">死亡 <b>${data.total}</b> 次 · 涉及角色 <b>${data.characters}</b> 个 · 最常见原因 <b>${esc(data.topCause ?? "—")}</b></p>
      <div style="overflow-x:auto"><table class="adm-death-table" style="width:100%;min-width:640px;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left"><th scope="col">地图</th><th scope="col">怪物</th><th scope="col">致命技能</th><th scope="col">死亡</th><th scope="col">角色</th><th scope="col">最常见原因</th></tr></thead>
        <tbody>${data.rows.map((row) => `<tr><td><code>${esc(row.map)}</code></td><td>${esc(row.mobName)}</td><td>${esc(row.skillName)}</td><td>${row.deaths}</td><td>${row.characters}</td><td>${esc(row.topCause)}</td></tr>`).join("") || '<tr><td colspan="6">这段时间没有记录</td></tr>'}</tbody>
      </table></div>`;
  };

  const load = async (days: 7 | 30): Promise<void> => {
    const mine = ++sequence;
    for (const button of root.querySelectorAll<HTMLElement>("[data-days]")) {
      const active = button.getAttribute("data-days") === String(days);
      button.setAttribute("aria-pressed", String(active));
      button.className = `adm-btn ${active ? "adm-btn-primary" : "adm-btn-ghost"}`;
    }
    try {
      const data = await deps.get(`/api/v1/admin/ke/death-stats?days=${days}`);
      if (mine === sequence) render(data);
    } catch (error) {
      if (mine === sequence) body.innerHTML = `<p class="adm-hint" role="alert">${esc(error instanceof Error ? error.message : "读取失败")}</p>`;
    }
  };

  root.addEventListener("click", (event) => {
    const days = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-days]")?.getAttribute("data-days");
    if (days === "7" || days === "30") void load(Number(days) as 7 | 30);
  });
  return () => void load(7);
}
