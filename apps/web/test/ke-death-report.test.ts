import { describe, expect, it } from "vitest";
import { deathDialogMarkup, hpPath, type DeathDialogState, type DeathReport } from "../src/ke-death-report";

const REPORT: DeathReport = {
  reportVersion: 1, id: "22-1", atMs: Date.UTC(2026, 10, 12, 6, 3, 27), aiMode: "auto", activity: "走路去找怪",
  character: { name: "下水道肝王" }, map: { name: "pay_dun03", x: 112, y: 86 },
  killer: { kind: "monster", mobId: 1016, name: "骷髅弓箭手", skillName: "二连矢", damage: 1284 },
  summary: { title: "被 骷髅弓箭手 的「二连矢」打死", reason: "HP 从 62% 掉到 0 只用了 3.1 秒。" },
  cause: "teleport_no_item", causeLabel: "瞬移失败", totalDamage: 4820,
  hp: {
    points: [{ tMs: -15000, pct: 100 }, { tMs: -3100, pct: 62 }, { tMs: 0, pct: 0 }],
    marks: [{ tMs: -1200, kind: "teleportFailed", label: "想瞬移，失败" }], teleportHpLine: 30,
  },
  sources: [{ name: "骷髅弓箭手", count: 2, hits: 7, skills: [{ name: "二连矢", hits: 3 }], damage: 3640, sharePct: 76 }],
  timeline: [{ tMs: -1200, text: "想瞬移 → 失败", severity: "warn" }, { tMs: 0, text: "死亡", severity: "fatal" }],
  state: { statuses: [], weightPct: 42, consumables: [{ name: "苍蝇翅膀", amount: 0, warn: true }] },
  fixes: [
    { id: "f1", title: "让 KE 自动补苍蝇翅膀", why: "没有翅膀。", from: "（未配置）", to: "buyAuto 苍蝇翅膀 {…}", patch: { op: "setKey" } },
    { id: "f2", title: "只是说明", why: "解释。", from: "", to: "", patch: null },
  ],
  log: [{ tMs: -500, level: "message", domain: "attacked", text: "x" }],
};

function state(overrides: Partial<DeathDialogState> = {}): DeathDialogState {
  return {
    instanceId: "i-1", charName: "下水道肝王", loading: false, error: "",
    list: {
      items: [{ reportKey: "22-1", diedAt: REPORT.atMs, map: "pay_dun03", killerName: "骷髅弓箭手", skillName: "二连矢", causeLabel: "瞬移失败", fixesTotal: 2, fixesApplied: 0 }],
      stats: { last7Days: 1, perDay7: [0, 0, 0, 0, 0, 0, 1], topKiller: { name: "骷髅弓箭手", count: 1 }, topCause: { label: "瞬移失败", count: 1 }, fixesApplied: 0, fixesTotal: 2 },
      profileName: "挂机-下水道",
    },
    selectedKey: "22-1", detail: { report: REPORT, fixesState: {} }, fixBusy: null, fixError: "",
    ...overrides,
  };
}

describe("deathDialogMarkup", () => {
  it("renders the title, the fixes with apply buttons, and the HP chart", () => {
    const html = deathDialogMarkup(state());
    expect(html).toContain("被 骷髅弓箭手 的「二连矢」打死");
    expect(html).toContain('data-kc-fix="f1"');
    expect(html).toContain("一键应用");
    expect(html).toContain("<svg");
    expect(html).toContain("挂机-下水道");
    expect(html).toContain("11-12 14:03");
  });

  it("shows undo for an applied fix and no apply button for an info fix", () => {
    const html = deathDialogMarkup(state({ detail: { report: REPORT, fixesState: { f1: { status: "applied", at: Date.UTC(2026, 10, 12, 6, 10), revert: { op: "setKey" } } } } }));
    expect(html).toContain('data-kc-fix-undo="f1"');
    expect(html).toContain("已应用并重载");
    expect(html).not.toContain('data-kc-fix="f1"');
    expect(html).not.toContain('data-kc-fix="f2"');
  });

  it("escapes untrusted text", () => {
    const evil = { ...REPORT, killer: { ...REPORT.killer, name: "<script>alert(1)</script>" }, summary: { title: "<img src=x onerror=alert(1)>", reason: "r" } };
    const html = deathDialogMarkup(state({ detail: { report: evil, fixesState: {} } }));
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("shows the conflict message in the fix area", () => {
    const html = deathDialogMarkup(state({ fixError: "配置已变化，请重新查看建议" }));
    expect(html).toContain("配置已变化，请重新查看建议");
  });

  it("disables apply buttons while one is running", () => {
    expect(deathDialogMarkup(state({ fixBusy: "f1" }))).toMatch(/data-kc-fix="f1"[^>]*disabled/);
  });

  it("builds the HP path in a 0..100 box", () => {
    expect(hpPath(REPORT.hp.points)).toBe("M0.0 0.0 L79.3 38.0 L100.0 100.0");
  });
});
