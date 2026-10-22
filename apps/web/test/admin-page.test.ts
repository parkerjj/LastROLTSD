import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAdminPage } from "../src/admin-page";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const EVIL = '<img src=x onerror="window.__adm_xss = 1">';

const profile = (level: number) => ({
  id: "1", email: "root@example.com", display_name: "root", status: "ACTIVE", permission_level: level,
  email_verified_at: 1, created_at: 1, has_avatar: false, avatar_version: 0, avatar_url: "/api/v1/users/1/avatar?v=0",
});
const storeFor = (user: object | null) => ({
  getState: () => (user === null ? { status: "anonymous" } : { status: "active", user, expiresAt: Number.MAX_SAFE_INTEGER, mailAvailability: null }),
  subscribe: () => () => {},
});

const wait = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call { method: string; path: string; body?: unknown }

const USER = { id: 2, email: "alice@example.com", display_name: EVIL, status: "ACTIVE", permission_level: 1, email_verified_at: 1, created_at: 1 };
const entitlement = (over: Record<string, unknown>) => ({
  id: 5, user_id: 2, resource: "slots", quantity: 3, starts_at: NOW - DAY_MS, expires_at: NOW + 29 * DAY_MS, source: "admin", source_ref: "r", actor_user_id: 1, note: EVIL, revoked_at: null, created_at: NOW - DAY_MS, ...over,
});
const DETAIL = {
  user: USER,
  effective: { slots: 4, modules: ["core"] },
  entitlements: [entitlement({}), entitlement({ id: 6, resource: "module:core", quantity: 1, source: "signup", note: null, expires_at: NOW + 3000 * DAY_MS }), entitlement({ id: 7, quantity: -1, revoked_at: NOW - 1000 })],
};

function mount(options: { user: object | null; get?: (path: string) => Response | undefined; write?: (call: Call) => unknown; prompt?: string | null; confirm?: boolean }) {
  const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/account/admin" });
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => options.confirm ?? true });
  Object.defineProperty(dom.window, "prompt", { configurable: true, value: () => options.prompt ?? null });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const gets: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    gets.push(path);
    return options.get?.(path) ?? json({ error: { code: "ADMIN_NOT_FOUND", message: "Not found" } }, 404);
  }));
  const writes: Call[] = [];
  const auth = {
    sessionRequest: vi.fn(async (path: string, method: string, body?: unknown) => {
      const call = { method, path, body };
      writes.push(call);
      return options.write?.(call) ?? { ok: true };
    }),
  };
  const root = dom.window.document.querySelector<HTMLElement>("#app")!;
  mountAdminPage(root, { store: storeFor(options.user) as never, auth: auth as never });
  return { dom, root, gets, writes };
}

const routes = (path: string): Response | undefined => {
  if (path.startsWith("/api/v1/admin/users?")) return json({ users: [USER] });
  if (path === "/api/v1/admin/users/2") return json(DETAIL);
  return undefined;
};

async function openUser(m: ReturnType<typeof mount>) {
  await wait();
  m.root.querySelector<HTMLButtonElement>("#adm-user-list [data-user-id]")!.click();
  await wait();
}

function fill(root: HTMLElement, selector: string, value: string): void {
  const element = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  element.value = value;
  element.dispatchEvent(new (root.ownerDocument.defaultView as unknown as typeof window).Event("input", { bubbles: true }));
  element.dispatchEvent(new (root.ownerDocument.defaultView as unknown as typeof window).Event("change", { bubbles: true }));
}

const submit = (root: HTMLElement, selector: string) => root.querySelector<HTMLFormElement>(selector)!
  .dispatchEvent(new (root.ownerDocument.defaultView as unknown as typeof window).Event("submit", { bubbles: true, cancelable: true }));

describe("admin page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("未登录只显示登录入口；普通用户只看到「不存在」，二者都不请求后台接口", async () => {
    const anonymous = mount({ user: null });
    await wait();
    expect(anonymous.root.querySelector("#adm-gate [data-open-login]")).not.toBeNull();
    expect(anonymous.root.querySelector<HTMLElement>("#adm-main")!.hidden).toBe(true);
    expect(anonymous.gets).toHaveLength(0);

    const normal = mount({ user: profile(99) });
    await wait();
    expect(normal.root.querySelector("#adm-gate")!.textContent).toContain("不存在");
    expect(normal.root.querySelector<HTMLElement>("#adm-main")!.hidden).toBe(true);
    expect(normal.gets).toHaveLength(0);
  });

  it("管理员：列出账号，选中后展示生效额度 / 模块与全部权益行（接口文本一律按纯文本渲染）", async () => {
    const m = mount({ user: profile(100), get: routes });
    await openUser(m);
    expect(m.gets[0]).toBe("/api/v1/admin/users?q=");
    expect(m.root.querySelector<HTMLElement>("#adm-main")!.hidden).toBe(false);
    expect(m.root.querySelector("#adm-user-list img")).toBeNull();
    expect(m.root.querySelector("#adm-user-list")!.textContent).toContain(EVIL);
    expect(m.root.querySelector("#adm-effective")!.textContent).toContain("4");
    expect(m.root.querySelector("#adm-effective")!.textContent).toContain("core");
    const rows = [...m.root.querySelectorAll("#adm-ent-body tr")];
    expect(rows).toHaveLength(3);
    expect(m.root.querySelector("#adm-detail img")).toBeNull();
    expect(rows[0]!.textContent).toContain("+3");
    expect(rows[0]!.textContent).toContain("生效中");
    expect(rows[1]!.textContent).toContain("模块");
    expect(rows[2]!.textContent).toContain("-1");
    expect(rows[2]!.textContent).toContain("已撤销");
  });

  it("搜索框把关键词交给接口", async () => {
    const m = mount({ user: profile(100), get: routes });
    await wait();
    fill(m.root, "#adm-search-q", "alice");
    submit(m.root, "#adm-search-form");
    await wait();
    expect(m.gets).toContain("/api/v1/admin/users?q=alice");
  });

  it("赠送 / 扣减：按选择的有效期组装请求体，成功后重新加载详情", async () => {
    const m = mount({ user: profile(100), get: routes, write: () => ({ id: 9 }) });
    await openUser(m);
    fill(m.root, "#adm-adjust-resource", "slots");
    fill(m.root, "#adm-adjust-delta", "-2");
    fill(m.root, "#adm-adjust-validity", "days");
    fill(m.root, "#adm-adjust-days", "7");
    fill(m.root, "#adm-adjust-note", "处罚");
    submit(m.root, "#adm-adjust-form");
    await wait();
    expect(m.writes[0]).toEqual({ method: "POST", path: "/api/v1/admin/users/2/entitlements", body: { resource: "slots", delta: -2, duration_days: 7, note: "处罚" } });
    expect(m.gets.filter((path) => path === "/api/v1/admin/users/2")).toHaveLength(2);

    fill(m.root, "#adm-adjust-delta", "5");
    fill(m.root, "#adm-adjust-validity", "permanent");
    fill(m.root, "#adm-adjust-note", "");
    submit(m.root, "#adm-adjust-form");
    await wait();
    expect(m.writes[1]!.body).toEqual({ resource: "slots", delta: 5, permanent: true });

    fill(m.root, "#adm-adjust-delta", "5");
    fill(m.root, "#adm-adjust-validity", "until");
    fill(m.root, "#adm-adjust-until", "2030-01-01T00:00");
    submit(m.root, "#adm-adjust-form");
    await wait();
    expect(m.writes[2]!.body).toEqual({ resource: "slots", delta: 5, expires_at: new Date("2030-01-01T00:00").getTime() });
  });

  it("赠送表单的明显错误在本地拦下：数量为 0 / 非整数 / 天数缺失 / 到期时间缺失", async () => {
    const m = mount({ user: profile(100), get: routes });
    await openUser(m);
    for (const [delta, validity, days] of [["0", "permanent", ""], ["1.5", "permanent", ""], ["", "permanent", ""], ["2", "days", ""]]) {
      fill(m.root, "#adm-adjust-delta", delta!);
      fill(m.root, "#adm-adjust-validity", validity!);
      fill(m.root, "#adm-adjust-days", days!);
      submit(m.root, "#adm-adjust-form");
      await wait(5);
    }
    fill(m.root, "#adm-adjust-delta", "2");
    fill(m.root, "#adm-adjust-validity", "until");
    fill(m.root, "#adm-adjust-until", "");
    submit(m.root, "#adm-adjust-form");
    await wait(5);
    expect(m.writes).toHaveLength(0);
    expect(m.root.querySelector("#adm-status")!.textContent).not.toBe("");
  });

  it("撤销与恢复权益行；修改到期时间", async () => {
    const m = mount({ user: profile(100), get: routes, prompt: "2030-01-01 00:00" });
    await openUser(m);
    const rows = [...m.root.querySelectorAll<HTMLElement>("#adm-ent-body tr")];
    rows[0]!.querySelector<HTMLButtonElement>("[data-ent-revoke]")!.click();
    await wait();
    expect(m.writes[0]).toEqual({ method: "PATCH", path: "/api/v1/admin/entitlements/5", body: { revoked: true } });
    rows[2]!.querySelector<HTMLButtonElement>("[data-ent-restore]")!.click();
    await wait();
    expect(m.writes[1]).toEqual({ method: "PATCH", path: "/api/v1/admin/entitlements/7", body: { revoked: false } });
    rows[0]!.querySelector<HTMLButtonElement>("[data-ent-expiry]")!.click();
    await wait();
    expect(m.writes[2]).toEqual({ method: "PATCH", path: "/api/v1/admin/entitlements/5", body: { expires_at: new Date("2030-01-01T00:00").getTime() } });
  });

  it("修改到期时间：取消或输入无法解析的时间不发请求", async () => {
    const cancelled = mount({ user: profile(100), get: routes, prompt: null });
    await openUser(cancelled);
    cancelled.root.querySelector<HTMLButtonElement>("[data-ent-expiry]")!.click();
    await wait();
    expect(cancelled.writes).toHaveLength(0);
    const garbage = mount({ user: profile(100), get: routes, prompt: "明天" });
    await openUser(garbage);
    garbage.root.querySelector<HTMLButtonElement>("[data-ent-expiry]")!.click();
    await wait();
    expect(garbage.writes).toHaveLength(0);
  });

  it("强制改密：二次确认后提交，成功后清空输入；取消确认或留空都不发请求", async () => {
    const m = mount({ user: profile(100), get: routes });
    await openUser(m);
    submit(m.root, "#adm-password-form");
    await wait(5);
    expect(m.writes).toHaveLength(0);
    fill(m.root, "#adm-password", "a-new-password");
    submit(m.root, "#adm-password-form");
    await wait();
    expect(m.writes[0]).toEqual({ method: "POST", path: "/api/v1/admin/users/2/password", body: { new_password: "a-new-password" } });
    expect(m.root.querySelector<HTMLInputElement>("#adm-password")!.value).toBe("");

    const declined = mount({ user: profile(100), get: routes, confirm: false });
    await openUser(declined);
    fill(declined.root, "#adm-password", "a-new-password");
    submit(declined.root, "#adm-password-form");
    await wait();
    expect(declined.writes).toHaveLength(0);
  });

  it("接口报错时把服务端的中文提示显示在状态栏", async () => {
    const failing = mount({
      user: profile(100), get: routes,
      write: () => { throw Object.assign(new Error("数量须为非零整数，绝对值不超过 1000"), { code: "ADMIN_BAD_REQUEST" }); },
    });
    await openUser(failing);
    fill(failing.root, "#adm-adjust-delta", "1");
    fill(failing.root, "#adm-adjust-validity", "permanent");
    submit(failing.root, "#adm-adjust-form");
    await wait();
    expect(failing.root.querySelector("#adm-status")!.textContent).toContain("数量须为非零整数");
  });

  it("审计日志：加载最近记录，「加载更多」带上最后一条的 id", async () => {
    const page1 = Array.from({ length: 50 }, (_, index) => ({ id: 100 - index, actor_user_id: 1, action: "ENTITLEMENT_ADJUST", target_user_id: 2, detail: { delta: 1 }, request_id: "r", created_at: NOW }));
    const m = mount({
      user: profile(100),
      get: (path) => {
        if (path === "/api/v1/admin/audit") return json({ entries: page1 });
        if (path === "/api/v1/admin/audit?before=51") return json({ entries: [{ id: 50, actor_user_id: 1, action: "PASSWORD_SET", target_user_id: 2, detail: null, request_id: "r", created_at: NOW }] });
        return routes(path);
      },
    });
    await wait();
    m.root.querySelector<HTMLButtonElement>("#adm-audit-load")!.click();
    await wait();
    expect(m.root.querySelectorAll("#adm-audit-list li")).toHaveLength(50);
    m.root.querySelector<HTMLButtonElement>("#adm-audit-more")!.click();
    await wait();
    expect(m.gets).toContain("/api/v1/admin/audit?before=51");
    expect(m.root.querySelectorAll("#adm-audit-list li")).toHaveLength(51);
    expect(m.root.querySelector("#adm-audit-list")!.textContent).toContain("PASSWORD_SET");
  });
});
