import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDeviceIdentityForTests } from "../src/device-identity";
import { mountKeDevicePage } from "../src/ke-device-page";

const MALICIOUS_LABEL = '<img src=x onerror="window.__ke_xss = 1">';

const user = {
  id: "10002", email: "n@example.com", display_name: "小明", status: "ACTIVE", permission_level: 1,
  email_verified_at: 1, created_at: 1, has_avatar: false, avatar_version: 0, avatar_url: "/api/v1/users/10002/avatar?v=0",
};
const anonymousStore = { getState: () => ({ status: "anonymous" }), subscribe: () => () => {} };
const activeStore = {
  getState: () => ({ status: "active", user, expiresAt: Number.MAX_SAFE_INTEGER, mailAvailability: null }),
  subscribe: () => () => {},
};

const wait = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (code: string, message: string, status: number) => json({ error: { code, message, request_id: "r" } }, status);

interface Call { method: string; path: string; body: unknown; headers: Headers }

function mount(options: { url: string; store: object; routes?: (call: Call) => Response | undefined }) {
  const dom = new JSDOM('<main id="app"></main>', { url: options.url });
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => true });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", path, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, headers: new Headers(init.headers) };
    calls.push(call);
    return options.routes?.(call) ?? apiError("AUTH_UNAUTHENTICATED", "请先登录", 401);
  }));
  const root = dom.window.document.querySelector<HTMLElement>("#app")!;
  mountKeDevicePage(root, { store: options.store as never });
  return { dom, root, calls };
}

const keCalls = (calls: Call[]) => calls.filter((call) => call.path.startsWith("/api/v1/ke/"));

describe("ke device page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetDeviceIdentityForTests();
  });

  it("未登录：只显示登录入口，不请求任何 KE 接口", async () => {
    const { root, calls } = mount({ url: "http://localhost/ke/device?code=BCDF-GHJK", store: anonymousStore });
    await wait();
    expect(root.querySelector("#kd-gate [data-open-login]")).not.toBeNull();
    expect(root.querySelector<HTMLElement>("#kd-approve")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("#kd-devices")!.hidden).toBe(true);
    expect(keCalls(calls)).toHaveLength(0);
  });

  it("已登录且链接带验证码：自动查找并展示设备名（纯文本）与验证码，地址栏移除 code，允许时提交决定", async () => {
    const { dom, root, calls } = mount({
      url: "http://localhost/ke/device?code=bcdf-ghjk",
      store: activeStore,
      routes: (call) => {
        if (call.path.startsWith("/api/v1/ke/device/lookup")) {
          return json({ user_code: "BCDF-GHJK", label: MALICIOUS_LABEL, created_at: 1_700_000_000_000, expires_at: 1_700_000_600_000 });
        }
        if (call.path === "/api/v1/ke/tokens") return json({ tokens: [] });
        if (call.path === "/api/v1/ke/device/decision") return new Response(null, { status: 204 });
        return undefined;
      },
    });
    await wait();

    expect(calls.find((call) => call.path.startsWith("/api/v1/ke/device/lookup"))?.path).toBe("/api/v1/ke/device/lookup?user_code=BCDF-GHJK");
    expect(dom.window.location.search).toBe("");
    expect(root.querySelector<HTMLInputElement>("#kd-code-input")!.value).toBe("BCDF-GHJK");
    expect(root.querySelector("#kd-request-device")!.textContent).toBe(MALICIOUS_LABEL);
    expect(root.querySelector("#kd-request-code")!.textContent).toBe("BCDF-GHJK");
    expect(root.querySelector("#kd-request img, #kd-request-device img")).toBeNull();
    expect(root.querySelector<HTMLElement>("#kd-request")!.hidden).toBe(false);

    root.querySelector<HTMLButtonElement>("#kd-allow")!.click();
    await wait();
    const decision = calls.find((call) => call.path === "/api/v1/ke/device/decision")!;
    expect(decision.method).toBe("POST");
    expect(decision.body).toEqual({ user_code: "BCDF-GHJK", approve: true });
    expect(root.querySelector<HTMLElement>("#kd-request")!.hidden).toBe(true);
    expect(root.querySelector("#kd-result-text")!.textContent).toContain("已授权");
    expect(root.querySelector<HTMLElement>("#kd-return")!.hidden).toBe(false);
    expect(root.querySelector<HTMLAnchorElement>("#kd-return")!.getAttribute("href")).toBe("web+lastro://launch");
  });

  it("批准设备：决定请求带 x-ltsd-device 头，且保留 content-type", async () => {
    const { root, calls } = mount({
      url: "http://localhost/ke/device?code=BCDFGHJK",
      store: activeStore,
      routes: (call) => {
        if (call.path.startsWith("/api/v1/ke/device/lookup")) return json({ user_code: "BCDF-GHJK", label: "RoBrowser KE", created_at: 1, expires_at: 2 });
        if (call.path === "/api/v1/ke/tokens") return json({ tokens: [] });
        if (call.path === "/api/v1/ke/device/decision") return new Response(null, { status: 204 });
        return undefined;
      },
    });
    await wait();
    root.querySelector<HTMLButtonElement>("#kd-allow")!.click();
    await wait(100);
    const decision = calls.find((call) => call.path === "/api/v1/ke/device/decision")!;
    expect(decision.headers.get("x-ltsd-device")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(decision.headers.get("content-type")).toBe("application/json");
  });

  it("拒绝：提交 approve=false，且不显示「返回 KoreEngine」", async () => {
    const { root, calls } = mount({
      url: "http://localhost/ke/device?code=BCDFGHJK",
      store: activeStore,
      routes: (call) => {
        if (call.path.startsWith("/api/v1/ke/device/lookup")) return json({ user_code: "BCDF-GHJK", label: "RoBrowser KE", created_at: 1, expires_at: 2 });
        if (call.path === "/api/v1/ke/tokens") return json({ tokens: [] });
        if (call.path === "/api/v1/ke/device/decision") return new Response(null, { status: 204 });
        return undefined;
      },
    });
    await wait();
    root.querySelector<HTMLButtonElement>("#kd-deny")!.click();
    await wait();
    expect(calls.find((call) => call.path === "/api/v1/ke/device/decision")!.body).toEqual({ user_code: "BCDF-GHJK", approve: false });
    expect(root.querySelector<HTMLElement>("#kd-return")!.hidden).toBe(true);
    expect(root.querySelector("#kd-result-text")!.textContent).toContain("已拒绝");
  });

  it("验证码无效或已过期：给出友好提示，不显示允许/拒绝", async () => {
    const { root } = mount({
      url: "http://localhost/ke/device?code=BCDF-GHJK",
      store: activeStore,
      routes: (call) => {
        if (call.path.startsWith("/api/v1/ke/device/lookup")) return apiError("KE_DEVICE_NOT_FOUND", "验证码无效或已过期", 404);
        if (call.path === "/api/v1/ke/tokens") return json({ tokens: [] });
        return undefined;
      },
    });
    await wait();
    expect(root.querySelector("#kd-status")!.textContent).toContain("重新发起登录");
    expect(root.querySelector<HTMLElement>("#kd-request")!.hidden).toBe(true);
  });

  it("已授权设备：名称按纯文本渲染；撤销后重新加载列表", async () => {
    let tokens = [{ id: 5, label: MALICIOUS_LABEL, created_at: 1_700_000_000_000, last_used_at: 1_700_000_100_000, expires_at: 1_707_000_000_000 }];
    const { root, calls } = mount({
      url: "http://localhost/ke/device",
      store: activeStore,
      routes: (call) => {
        if (call.path === "/api/v1/ke/tokens" && call.method === "GET") return json({ tokens });
        if (call.path === "/api/v1/ke/tokens/5" && call.method === "DELETE") {
          tokens = [];
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    });
    await wait();

    const names = root.querySelectorAll(".kd-device-name");
    expect(names).toHaveLength(1);
    expect(names[0]!.textContent).toBe(MALICIOUS_LABEL);
    expect(root.querySelector("#kd-device-list img")).toBeNull();
    expect(root.querySelector<HTMLElement>("#kd-device-empty")!.hidden).toBe(true);

    root.querySelector<HTMLButtonElement>(".kd-device .kd-btn-danger")!.click();
    await wait();
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/v1/ke/tokens/5")).toBe(true);
    expect(root.querySelectorAll(".kd-device")).toHaveLength(0);
    expect(root.querySelector<HTMLElement>("#kd-device-empty")!.hidden).toBe(false);
  });
});
