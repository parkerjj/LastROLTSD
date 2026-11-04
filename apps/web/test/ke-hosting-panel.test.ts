import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  mountHostingPanel,
  type HostableCharacter,
  type HostedEligibility,
  type HostedItem,
  type HostingApi,
  type HostingStore,
} from "../src/ke-hosting-panel";

const NOW = Date.UTC(2026, 10, 6, 4, 0);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ELIGIBLE: HostedEligibility = { eligible: true, slots: 3, has_hosting: true, hosting_expires_at: NOW + 20 * 86_400_000, cap: 3, hosted_count: 1 };

function item(overrides: Partial<HostedItem> = {}): HostedItem {
  return {
    id: "i-1", char_name: "暴力男团", nid: 5, aid: 1000001, cid: 2000002, desired: "running", phase: "running",
    stop_reason: null, retry_at: null, agent: "vps-1", status_at: NOW - 3 * 60_000,
    status: {
      v: 1, ai: "auto", world_ready: true,
      character: { name: "暴力男团", base_level: 99, job_level: 70, job_id: 4016 },
      vitals: { hp: 6850, hp_max: 6999, sp: 581, sp_max: 700, weight: 11490, weight_max: 53300, zeny: 1234567 },
      map: { name: "cmd_fild04", x: 112, y: 87 },
    },
    ...overrides,
  };
}

function setup(options: {
  state?: ReturnType<HostingStore["getState"]>;
  eligibility?: HostedEligibility;
  items?: HostedItem[];
  characters?: HostableCharacter[];
} = {}) {
  const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/accounts" });
  const previous = { document: globalThis.document, window: (globalThis as { window?: unknown }).window };
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  const items = { current: options.items ?? [item()] };
  const api: HostingApi = {
    load: vi.fn(async () => ({ eligibility: options.eligibility ?? ELIGIBLE, items: items.current })),
    characters: vi.fn(async () => options.characters ?? []),
    create: vi.fn(async () => ({ id: "i-2" })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  let listener: ((state: ReturnType<HostingStore["getState"]>) => void) | null = null;
  let state = options.state ?? ({ status: "active", user: { id: "42" }, expiresAt: 0, mailAvailability: null } as never);
  const store: HostingStore = {
    getState: () => state,
    subscribe: (next) => { listener = next; return () => { listener = null; }; },
  };
  const root = dom.window.document.querySelector<HTMLElement>("#app")!;
  const dispose = mountHostingPanel(root, api, store, { now: () => NOW });
  const restore = () => {
    dispose();
    Object.defineProperty(globalThis, "document", { configurable: true, value: previous.document });
    Object.defineProperty(globalThis, "window", { configurable: true, value: previous.window });
  };
  return { dom, root, api, items, restore, emit: (next: ReturnType<HostingStore["getState"]>) => { state = next; listener?.(next); } };
}

function click(dom: JSDOM, selector: string): void {
  dom.window.document.querySelector<HTMLElement>(selector)!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

describe("KE 监控台：离线挂机面板", () => {
  it("未登录时只提示登录，不请求托管接口", async () => {
    const { root, api, restore } = setup({ state: { status: "anonymous" } });
    await flush();
    expect(root.textContent).toContain("登录后管理离线挂机");
    expect(root.querySelector("[data-open-login]")).not.toBeNull();
    expect(api.load).not.toHaveBeenCalled();
    restore();
  });

  it("展示开通状态、额度与运行中角色的最近状态", async () => {
    const { root, restore } = setup();
    await flush();
    const text = root.textContent ?? "";
    expect(text).toContain("已开通");
    expect(text).toContain("2026-11-26 到期");
    expect(text).toContain("1 / 3");
    expect(text).toContain("暴力男团");
    expect(text).toContain("运行中");
    expect(text).toContain("cmd_fild04 (112, 87)");
    expect(text).toContain("1,234,567 z");
    expect(text).toContain("3 分钟前更新");
    expect(root.querySelector(".kc-upsell")).toBeNull();
    restore();
  });

  it("没有离线挂机功能时显示购买入口，且不能添加角色", async () => {
    const { root, restore } = setup({
      eligibility: { eligible: false, slots: 1, has_hosting: false, hosting_expires_at: null, cap: 0, hosted_count: 0 },
      items: [],
    });
    await flush();
    expect(root.querySelector<HTMLAnchorElement>(".kc-upsell a")?.getAttribute("href")).toBe("/ke/buy");
    expect(root.textContent).toContain("未开通");
    expect(root.querySelector<HTMLButtonElement>("button[data-kc-open-dialog]")!.disabled).toBe(true);
    restore();
  });

  it("停止、启动都会调用接口并重新读取；删除需要二次确认且只对已停止的实例出现", async () => {
    const { dom, root, api, items, restore } = setup({
      items: [item(), item({ id: "i-3", char_name: "法师小号", desired: "stopped", phase: "stopped", stop_reason: "no-hosting-entitlement", status: null, status_at: null })],
    });
    await flush();
    expect(root.querySelector('[data-kc-delete="i-1"]')).toBeNull();
    expect(root.textContent).toContain("离线挂机已到期或不可用");

    click(dom, '[data-kc-stop="i-1"]');
    await flush();
    expect(api.stop).toHaveBeenCalledWith("i-1");
    expect(api.load).toHaveBeenCalledTimes(2);

    click(dom, '[data-kc-start="i-3"]');
    await flush();
    expect(api.start).toHaveBeenCalledWith("i-3");

    items.current = [item({ id: "i-3", desired: "stopped", phase: "stopped", stop_reason: "user", status: null, status_at: null })];
    click(dom, '[data-kc-reload]');
    await flush();
    click(dom, '[data-kc-delete="i-3"]');
    expect(api.remove).not.toHaveBeenCalled();
    expect(root.textContent).toContain("确认删除？");
    click(dom, '[data-kc-delete="i-3"]');
    await flush();
    expect(api.remove).toHaveBeenCalledWith("i-3");
    restore();
  });

  it("操作失败时显示服务端给出的中文原因", async () => {
    const { dom, root, api, restore } = setup();
    vi.mocked(api.stop).mockRejectedValueOnce(new Error("请先停止托管实例"));
    await flush();
    click(dom, '[data-kc-stop="i-1"]');
    await flush();
    expect(root.querySelector(".kc-notice.is-error")?.textContent).toBe("请先停止托管实例");
    restore();
  });

  it("等待重连时说明重试时间；被顶下线的长等待也有解释", async () => {
    const { root, restore } = setup({ items: [item({ phase: "backoff", retry_at: NOW + 30 * 60_000, status: null })] });
    await flush();
    expect(root.textContent).toContain("等待重连");
    expect(root.textContent).toContain("30 分钟后自动重试");
    restore();
  });

  it("添加角色：只列出尚未登记的角色，必须填写三个密码字段，成功后刷新列表", async () => {
    const characters: HostableCharacter[] = [
      { aid: 1000001, cid: 2000002, nid: 5, char_name: "暴力男团", job_id: 4016, map_name: "cmd_fild04", last_seen_at: 1 },
      { aid: 1000001, cid: 2000003, nid: 5, char_name: "法师小号", job_id: 9, map_name: null, last_seen_at: 1 },
    ];
    const { dom, root, api, restore } = setup({ characters });
    await flush();
    click(dom, "button[data-kc-open-dialog]");
    await flush();
    const options = root.querySelectorAll<HTMLInputElement>('input[name="kc-character"]');
    expect(options).toHaveLength(1); // 暴力男团已登记
    expect(root.querySelector(".kc-char-option")?.textContent).toContain("法师小号");

    const form = root.querySelector<HTMLFormElement>("#kc-form")!;
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(api.create).not.toHaveBeenCalled();
    expect(root.textContent).toContain("请填写游戏账号和游戏密码");

    root.querySelector<HTMLInputElement>("#kc-game-account")!.value = "game123";
    root.querySelector<HTMLInputElement>("#kc-game-password")!.value = "g-secret";
    root.querySelector<HTMLInputElement>("#kc-current-password")!.value = "site-secret";
    root.querySelector<HTMLFormElement>("#kc-form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(api.create).toHaveBeenCalledWith({
      nid: 5, aid: 1000001, cid: 2000003, charName: "法师小号",
      gameAccount: "game123", gamePassword: "g-secret", currentPassword: "site-secret",
    });
    expect(root.querySelector("[data-kc-overlay]")).toBeNull();
    expect(root.textContent).toContain("已登记「法师小号」");
    restore();
  });

  it("登录状态变化（登出/换号）时清掉旧数据并重新读取", async () => {
    const { root, api, emit, restore } = setup();
    await flush();
    emit({ status: "anonymous" });
    await flush();
    expect(root.textContent).toContain("登录后管理离线挂机");
    expect(root.textContent).not.toContain("暴力男团");
    expect(api.load).toHaveBeenCalledTimes(1);
    restore();
  });
});
