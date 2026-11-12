import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { deathStatsSectionMarkup, mountDeathStats } from "../src/admin-death-stats";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const DATA = {
  total: 14, characters: 5, topCause: "瞬移失败",
  rows: [
    { map: "pay_dun03", mobId: 1016, mobName: "骷髅弓箭手", skillName: "二连矢", deaths: 8, characters: 3, topCause: "瞬移失败" },
    { map: "evil", mobId: null, mobName: "<img src=x onerror=alert(1)>", skillName: "普通攻击", deaths: 2, characters: 1, topCause: "被围攻" },
  ],
};

describe("后台：托管死亡统计", () => {
  it("renders the table and switches between 7 and 30 days", async () => {
    const dom = new JSDOM(`<main id="app">${deathStatsSectionMarkup()}</main>`, { url: "http://localhost/account/admin" });
    vi.stubGlobal("document", dom.window.document);
    const get = vi.fn(async () => DATA);
    const start = mountDeathStats(dom.window.document.querySelector<HTMLElement>("#adm-death")!, { get });
    expect(get).not.toHaveBeenCalled();
    start();
    await flush();
    expect(get).toHaveBeenCalledWith("/api/v1/admin/ke/death-stats?days=7");
    const text = dom.window.document.body.textContent ?? "";
    expect(text).toContain("pay_dun03");
    expect(text).toContain("骷髅弓箭手");
    expect(text).toContain("14");
    expect(dom.window.document.querySelector("img")).toBeNull();
    dom.window.document.querySelector<HTMLElement>('[data-days="30"]')!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(get).toHaveBeenLastCalledWith("/api/v1/admin/ke/death-stats?days=30");
    vi.unstubAllGlobals();
  });
});
