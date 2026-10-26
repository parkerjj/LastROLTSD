import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAdminTransfer, transferSectionMarkup } from "../src/admin-transfer";

const EVIL = '<img src=x onerror="window.__adm_xss = 1">';
const wait = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const CHARACTERS = {
  user: { id: 2, email: "src@example.com" },
  characters: [
    { aid: 100, cid: 200, nid: 300, char_name: EVIL, base_level: 99, job_level: 50, job_id: 1, bound_at: 1 },
    { aid: 101, cid: 201, nid: 301, char_name: "Bob", base_level: null, job_level: null, job_id: null, bound_at: null },
  ],
};

const row = (id: number, side: "source" | "target", over: Record<string, unknown> = {}) => ({
  id, side, event: "LOGIN", result: "SUCCESS", created_at: 1_800_000_000_000 + id * 1000, source: "live",
  ip: "1.2.3.4", country: "CN", region: "Guangdong", city: "Shenzhen", as_org: "ISP", is_hosting: false,
  fingerprint_short: null, device_short: null, aid: null, ...over,
});

const evidence = (over: Record<string, unknown>) => ({ rule: "SAME_DEVICE", kind: "strong", points: 25, text: "同一设备", redacted_text: "同一设备", event_ids: [], ...over });

function preview(over: { timeline?: unknown[]; analysis?: Record<string, unknown> } = {}) {
  return {
    source: { id: 2, email: "src@example.com" },
    target: { id: 3, email: "dst@example.com" },
    character: CHARACTERS.characters[0],
    analysis: {
      score: 80, verdict: "HIGH", notes: ["注意事项一"],
      evidence: [
        evidence({ text: "共用设备", event_ids: [11, 12] }),
        evidence({ rule: "MAIN_CITY", kind: "weak", points: 5, text: "同城", event_ids: [13] }),
        evidence({ rule: "CONCURRENT_COUNTRY", kind: "counter", points: -10, text: "同时在不同国家", event_ids: [] }),
      ],
      ...over.analysis,
    },
    timeline: over.timeline ?? [
      row(10, "source"), row(11, "source", { event: "KE_BIND", result: "FAILURE", is_hosting: true, fingerprint_short: "ab12", source: "backfill" }),
      row(12, "target", { ip: null, city: null, region: null, country: null, as_org: null }), row(13, "target"),
    ],
  };
}

function mount(handler: (path: string) => unknown, writeResult: unknown = { moved_profile_ids: [1], detached_share_ids: [] }) {
  const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/account/admin" });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  const gets: string[] = [];
  const get = vi.fn(async (path: string) => {
    gets.push(path);
    const result = handler(path);
    if (result instanceof Error) throw result;
    return result;
  });
  const sessionRequest = vi.fn(async (_path: string, _method: string, _body?: unknown) => {
    if (writeResult instanceof Error) throw writeResult;
    return writeResult;
  });
  const root = dom.window.document.querySelector<HTMLElement>("#app")!;
  root.innerHTML = transferSectionMarkup();
  mountAdminTransfer(root, { get: get as never, auth: { sessionRequest } as never });
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  return { dom, root, gets, sessionRequest, q };
}

type Mounted = ReturnType<typeof mount>;

async function queryCharacters(m: Mounted, source = "src@example.com") {
  m.q<HTMLInputElement>("#adm-tr-source").value = source;
  m.q<HTMLButtonElement>("#adm-tr-query").click();
  await wait();
}

async function analyze(m: Mounted, target = "dst@example.com") {
  await queryCharacters(m);
  m.q<HTMLInputElement>("#adm-tr-target").value = target;
  m.q<HTMLButtonElement>("#adm-tr-analyze").click();
  await wait();
}

const routes = (data: unknown) => (path: string) => (path.startsWith("/api/v1/admin/transfer/characters") ? CHARACTERS : path.startsWith("/api/v1/admin/transfer/preview") ? data : new Error("unexpected"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin transfer section", () => {
  it("markup is a static skeleton with no api data", () => {
    const html = transferSectionMarkup();
    expect(html).toContain('id="adm-tr-source"');
    expect(html).toContain('id="adm-tr-report"');
  });

  it("queries characters and fills the dropdown", async () => {
    const m = mount(routes(preview()));
    await queryCharacters(m, "a b@x.com");
    expect(m.gets).toEqual([`/api/v1/admin/transfer/characters?account=${encodeURIComponent("a b@x.com")}`]);
    const options = [...m.q<HTMLSelectElement>("#adm-tr-character").options];
    expect(options.map((o) => o.value)).toEqual(["100:200:300", "101:201:301"]);
    expect(options[0]!.textContent).toBe(`${EVIL}（aid 100 · Lv 99/50）`);
    expect(options[1]!.textContent).toBe("Bob（aid 101 · Lv ?/?）");
  });

  it("tells when the account has no bound characters", async () => {
    const m = mount(() => ({ user: CHARACTERS.user, characters: [] }));
    await queryCharacters(m);
    expect(m.root.textContent).toContain("该账号名下没有绑定角色");
    expect(m.q<HTMLSelectElement>("#adm-tr-character").options).toHaveLength(0);
  });

  it("requests the preview and renders verdict, evidence columns and timeline", async () => {
    const m = mount(routes(preview()));
    await analyze(m);
    expect(m.gets[1]).toBe("/api/v1/admin/transfer/preview?source=src%40example.com&target=dst%40example.com&aid=100&cid=200&nid=300");
    expect(m.q("#adm-tr-verdict").textContent).toBe("结论：HIGH 高度疑似同一人　关联分 80 / 100");
    const left = m.q("#adm-tr-col-strong").textContent!;
    const right = m.q("#adm-tr-col-right").textContent!;
    expect(left).toContain("共用设备");
    expect(left).toContain("+25");
    expect(left).not.toContain("同城");
    expect(right).toContain("同城");
    expect(right).toContain("同时在不同国家");
    expect(right).toContain("-10");
    expect(m.q("#adm-tr-notes").textContent).toContain("注意事项一");
    // 第一个带 event_ids 的证据编号为 ①，其行带高亮类
    expect(left).toContain("①");
    expect(right).toContain("②");
    const rows = [...m.root.querySelectorAll<HTMLTableRowElement>("#adm-tr-timeline tbody tr")];
    expect(rows).toHaveLength(4);
    expect(rows[0]!.classList.contains("adm-tr-hl")).toBe(false);
    expect(rows[1]!.classList.contains("adm-tr-hl")).toBe(true);
    expect(rows[1]!.textContent).toContain("①");
    expect(rows[3]!.textContent).toContain("②");
    expect(m.root.querySelectorAll("#adm-tr-timeline thead th")).toHaveLength(3);
    // 账号 A 在第二列、账号 B 在第三列
    expect(rows[1]!.cells[1]!.textContent).toBe("KE 绑定角色（失败） · 1.2.3.4 · Shenzhen, Guangdong, CN · ISP · 机房/VPN · 指纹 #ab12 · 补数");
    expect(rows[1]!.cells[2]!.textContent).toBe("");
    expect(rows[2]!.cells[2]!.textContent).toBe("登录 · — ·  · ");
  });

  it("shows the insufficient verdict with a muted score", async () => {
    const m = mount(routes(preview({ analysis: { verdict: "INSUFFICIENT", score: 0, evidence: [], notes: [] } })));
    await analyze(m);
    expect(m.q("#adm-tr-verdict").textContent).toBe("结论：INSUFFICIENT 数据不足，无法判断　关联分 0 / 100");
    expect(m.q("#adm-tr-verdict .adm-tr-muted")).not.toBeNull();
  });

  it("filters to highlighted rows only", async () => {
    const m = mount(routes(preview()));
    await analyze(m);
    const toggle = m.q<HTMLInputElement>("#adm-tr-only-hl");
    toggle.checked = true;
    toggle.dispatchEvent(new m.dom.window.Event("change", { bubbles: true }));
    const rows = [...m.root.querySelectorAll("#adm-tr-timeline tbody tr")];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.classList.contains("adm-tr-hl"))).toBe(true);
  });

  it("renders 200 rows first and 200 more on demand", async () => {
    const timeline = Array.from({ length: 250 }, (_, i) => row(1000 + i, i % 2 === 0 ? "source" : "target"));
    const m = mount(routes(preview({ timeline })));
    await analyze(m);
    expect(m.root.querySelectorAll("#adm-tr-timeline tbody tr")).toHaveLength(200);
    m.q<HTMLButtonElement>("#adm-tr-more").click();
    expect(m.root.querySelectorAll("#adm-tr-timeline tbody tr")).toHaveLength(250);
    expect(m.q<HTMLButtonElement>("#adm-tr-more").hidden).toBe(true);
  });

  it("requires a note before confirming, then posts the transfer", async () => {
    const m = mount(routes(preview()));
    await analyze(m);
    m.q<HTMLButtonElement>("#adm-tr-confirm").click();
    await wait();
    expect(m.sessionRequest).not.toHaveBeenCalled();
    expect(m.q("#adm-tr-status").textContent).toBe("请填写审核备注");

    m.q<HTMLInputElement>("#adm-tr-note").value = "  玩家提供了截图  ";
    m.q<HTMLButtonElement>("#adm-tr-confirm").click();
    await wait();
    expect(m.sessionRequest).toHaveBeenCalledWith("/api/v1/admin/transfer", "POST", {
      source: "src@example.com", target: "dst@example.com", aid: 100, cid: 200, nid: 300, note: "玩家提供了截图",
    });
    expect(m.q("#adm-tr-status").textContent).toBe(`已转移：${EVIL} → dst@example.com`);
    expect(m.q<HTMLElement>("#adm-tr-report").hidden).toBe(true);
    expect(m.q<HTMLInputElement>("#adm-tr-source").value).toBe("");
    expect(m.q<HTMLInputElement>("#adm-tr-target").value).toBe("");
    expect(m.q<HTMLInputElement>("#adm-tr-note").value).toBe("");
  });

  it("shows the api message when confirming fails", async () => {
    const m = mount(routes(preview()), new Error("角色不存在或已不属于源账号，请重新查询"));
    await analyze(m);
    m.q<HTMLInputElement>("#adm-tr-note").value = "ok";
    m.q<HTMLButtonElement>("#adm-tr-confirm").click();
    await wait();
    expect(m.q("#adm-tr-status").textContent).toBe("角色不存在或已不属于源账号，请重新查询");
    expect(m.q<HTMLElement>("#adm-tr-report").hidden).toBe(false);
  });

  it("cancel hides the report", async () => {
    const m = mount(routes(preview()));
    await analyze(m);
    m.q<HTMLButtonElement>("#adm-tr-cancel").click();
    expect(m.q<HTMLElement>("#adm-tr-report").hidden).toBe(true);
  });

  it("renders every api string as text", async () => {
    const timeline = [row(11, "source", { as_org: EVIL, city: EVIL })];
    const m = mount(routes(preview({
      timeline,
      analysis: { evidence: [evidence({ text: EVIL, event_ids: [11] })], notes: [EVIL] },
    })));
    await analyze(m);
    expect((m.dom.window as unknown as { __adm_xss?: number }).__adm_xss).toBeUndefined();
    expect(m.root.querySelector("img")).toBeNull();
    expect(m.q("#adm-tr-col-strong").textContent).toContain(EVIL);
    expect(m.q("#adm-tr-timeline").textContent).toContain(EVIL);
  });
});
