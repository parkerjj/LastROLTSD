import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { mountAccountsPage } from "../src/accounts-page";

const ONLINE_PAYLOAD = {
  state: "online" as const,
  data: {
    updatetime: "202609251937",
    inminute: "295 min",
    name: "暴力男团",
    class: 4016,
    base_level: 99,
    job_level: 70,
    hp: "6850",
    max_hp: "6999",
    sp: "581",
    max_sp: "700",
    base_exp: "63721856",
    nextbaseexp: "99999999",
    job_exp: "58923440",
    nextjobexp: "999999999",
    last_map: "cmd_fild04",
    autoattack: 0,
    autoloot: 49,
    weight: 11490,
    maxweight: 53300,
    changebexp: 50783,
    changejexp: 44414,
  },
};

// 2026-09-25 19:40 +08:00, three minutes after the payload's updatetime
const FIXED_NOW = Date.UTC(2026, 8, 25, 11, 40);

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(
  api: unknown,
  seed?: Array<{ id: string; password: string; addedAt: number }>,
) {
  const dom = new JSDOM('<main id="app"></main>', {
    url: "http://localhost/accounts",
  });
  const previousDocument = globalThis.document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  if (seed)
    dom.window.localStorage.setItem("lastro.accounts.v1", JSON.stringify(seed));
  const root = dom.window.document.querySelector<HTMLElement>("#app")!;
  mountAccountsPage(root, api as never, {
    storage: dom.window.localStorage,
    now: () => FIXED_NOW,
  });
  const restore = () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  };
  return { dom, root, storage: dom.window.localStorage, restore };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("accounts page", () => {
  it("renders V1 launcher, disabled V2, and the privacy notice with GitHub link", () => {
    const { root, restore } = mount({ getAccountStatus: vi.fn() });
    try {
      const v1 = root.querySelector<HTMLButtonElement>(
        ".accounts-launch--primary",
      )!;
      expect(v1.id).toBe("accounts-launch-v1");
      expect(v1.textContent).toContain("启动稳定版 V1");
      const v2 = root.querySelector<HTMLButtonElement>(
        ".accounts-launch--disabled",
      )!;
      expect(v2.disabled).toBe(true);
      expect(v2.textContent).toContain("尚未开放");
      expect(root.querySelector(".accounts-privacy")?.textContent).toContain(
        "转发",
      );
      expect(root.querySelector(".accounts-privacy")?.textContent).toContain(
        "油猴",
      );
      expect(
        root
          .querySelector<HTMLAnchorElement>(".accounts-script-link")
          ?.getAttribute("href"),
      ).toBe("/lastro-direct.user.js");
      expect(
        root.querySelector<HTMLAnchorElement>(".accounts-github")?.href,
      ).toBe("https://github.com/parkerjj/LastROLTSD");
      expect(
        root
          .querySelector('.site-nav a[aria-current="page"]')
          ?.getAttribute("href"),
      ).toBe("/accounts");
    } finally {
      restore();
    }
  });

  it("defaults to opening the same-origin /play launcher in a foreground tab, one per click", () => {
    const { dom, root, restore } = mount({ getAccountStatus: vi.fn() });
    const playTab = { postMessage: vi.fn(), closed: false };
    dom.window.open = vi.fn(() => playTab as unknown as Window);
    const button = root.querySelector<HTMLButtonElement>(
      "#accounts-launch-v1",
    )!;
    try {
      expect(
        root.querySelector<HTMLInputElement>("#accounts-launch-popup")!.checked,
      ).toBe(false);
      button.click();
      button.click();
      expect(dom.window.open).toHaveBeenCalledTimes(2);
      for (const call of (dom.window.open as ReturnType<typeof vi.fn>).mock
        .calls) {
        expect(call[0]).toBe("/play");
        expect(call[1]).toBe("_blank");
        // No window features: a normal foreground tab, not an independent popup window.
        expect(call).toHaveLength(2);
      }
      // In iframe mode the same-origin /play page owns the handshake; we never post to it here.
      expect(playTab.postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("remembers the fullscreen-popup preference across mounts", () => {
    // Both mounts must share one localStorage, so drive a single JSDOM manually.
    const dom = new JSDOM("<main></main>", {
      url: "http://localhost/accounts",
    });
    const previousDocument = globalThis.document;
    const previousWindow = (globalThis as { window?: unknown }).window;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: dom.window.document,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: dom.window,
    });
    try {
      const first = dom.window.document.createElement("div");
      dom.window.document.body.appendChild(first);
      mountAccountsPage(first, { getAccountStatus: vi.fn() } as never);
      const toggle = first.querySelector<HTMLInputElement>(
        "#accounts-launch-popup",
      )!;
      toggle.checked = true;
      toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      expect(dom.window.localStorage.getItem("lastro.launch.popup.v1")).toBe(
        "1",
      );

      const second = dom.window.document.createElement("div");
      dom.window.document.body.appendChild(second);
      mountAccountsPage(second, { getAccountStatus: vi.fn() } as never);
      expect(
        second.querySelector<HTMLInputElement>("#accounts-launch-popup")!
          .checked,
      ).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  });

  it("when the popup option is on, opens a fullscreen game window and handshakes until ready", async () => {
    const { dom, root, restore } = mount({ getAccountStatus: vi.fn() });
    const postMessage = vi.fn();
    const popup = { postMessage, closed: false };
    dom.window.open = vi.fn(() => popup as unknown as Window);
    root.querySelector<HTMLInputElement>("#accounts-launch-popup")!.checked =
      true;
    try {
      root.querySelector<HTMLButtonElement>("#accounts-launch-v1")!.click();
      expect(dom.window.open).toHaveBeenCalledTimes(1);
      const call = (dom.window.open as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toBe("https://game.lastro.cn/ro/api.html?70.84");
      expect(call[1]).toBe("_blank");
      expect(String(call[2])).toContain("width=");
      expect(String(call[2])).toContain("height=");

      await wait(250);
      expect(postMessage).toHaveBeenCalled();
      const [config, targetOrigin] = postMessage.mock.calls[0]!;
      expect(targetOrigin).toBe("*");
      expect(config).toMatchObject({
        application: "Online",
        servers: "data/clientinfo.xml",
        remoteClient: "/ro/client_re/",
        version: 70.84,
        ClientVer: 5,
        development: false,
        saveFiles: true,
        skipServerList: true,
        skipIntro: true,
        plugins: { IntroMessagePc: {}, LoadingDonate: {} },
      });

      const callsBeforeReady = postMessage.mock.calls.length;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          origin: "https://game.lastro.cn",
          source: popup as unknown as Window,
          data: "ready",
        }),
      );
      await wait(250);
      expect(postMessage.mock.calls.length).toBe(callsBeforeReady);
    } finally {
      restore();
    }
  });

  it("stops the popup handshake when the window closes and warns when opening is blocked", async () => {
    const { dom, root, restore } = mount({ getAccountStatus: vi.fn() });
    const postMessage = vi.fn();
    const popup = { postMessage, closed: false };
    dom.window.open = vi.fn(() => popup as unknown as Window);
    root.querySelector<HTMLInputElement>("#accounts-launch-popup")!.checked =
      true;
    try {
      root.querySelector<HTMLButtonElement>("#accounts-launch-v1")!.click();
      await wait(250);
      const callsBeforeClose = postMessage.mock.calls.length;
      expect(callsBeforeClose).toBeGreaterThan(0);
      popup.closed = true;
      await wait(250);
      expect(postMessage.mock.calls.length).toBe(callsBeforeClose);
    } finally {
      restore();
    }

    const blocked = mount({ getAccountStatus: vi.fn() });
    blocked.dom.window.open = vi.fn(() => null);
    try {
      blocked.root
        .querySelector<HTMLButtonElement>("#accounts-launch-v1")!
        .click();
      expect(
        blocked.root.querySelector("#accounts-status")?.textContent,
      ).toContain("弹出窗口");
    } finally {
      blocked.restore();
    }
  });

  it("shows the empty state for new visitors without calling the API", () => {
    const api = { getAccountStatus: vi.fn() };
    const { root, restore } = mount(api);
    try {
      expect(root.querySelector<HTMLElement>("#accounts-empty")!.hidden).toBe(
        false,
      );
      expect(root.querySelector<HTMLElement>("#accounts-grid")!.hidden).toBe(
        true,
      );
      expect(root.querySelector("#accounts-summary")?.textContent).toContain(
        "共 0 个账号",
      );
      expect(
        root.querySelector<HTMLButtonElement>("#accounts-refresh-all")!
          .disabled,
      ).toBe(true);
      expect(api.getAccountStatus).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("saves a new account to localStorage, renders a card, and fetches its status", async () => {
    const api = { getAccountStatus: vi.fn().mockResolvedValue(ONLINE_PAYLOAD) };
    const { dom, root, storage, restore } = mount(api);
    try {
      root.querySelector<HTMLButtonElement>("#accounts-add")!.click();
      expect(root.querySelector<HTMLElement>("#account-modal")!.hidden).toBe(
        false,
      );
      root.querySelector<HTMLInputElement>("#account-label")!.value =
        "我的商人号";
      root.querySelector<HTMLInputElement>("#account-userid")!.value =
        "testbot";
      root.querySelector<HTMLInputElement>("#account-password")!.value =
        "pw123";
      root
        .querySelector("#account-form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );
      await flush();
      await flush();
      const stored = JSON.parse(
        storage.getItem("lastro.accounts.v1")!,
      ) as Array<{ id: string; password: string; label: string }>;
      expect(stored).toEqual([
        {
          id: "testbot",
          password: "pw123",
          label: "我的商人号",
          addedAt: FIXED_NOW,
        },
      ]);
      expect(api.getAccountStatus).toHaveBeenCalledWith("testbot", "pw123");
      const card = root.querySelector('[data-account-card="testbot"]')!;
      expect(card.querySelector(".acc-stamp")?.textContent).toBe("运行中");
      expect(card.querySelector(".acc-label")?.textContent).toContain(
        "我的商人号",
      );
      expect(card.querySelector(".acc-id small")?.textContent).toBe("testbot");
      expect(card.querySelector(".acc-char")?.textContent).toBe("暴力男团");
      expect(card.querySelector(".acc-levels")?.textContent).toContain("99");
      expect(card.querySelector(".acc-levels")?.textContent).toContain("70");
      expect(card.querySelector(".chip--map")?.textContent).toContain(
        "cmd_fild04",
      );
      expect(
        card.querySelector(".chip:not(.chip--gain):not(.chip--map)")
          ?.textContent,
      ).toContain("在线 295 min");
      expect(card.querySelectorAll(".gauge-track")).toHaveLength(5);
      expect(
        card
          .querySelector(".gauge-fill--weight")
          ?.closest(".gauge")
          ?.querySelector(".gauge-value")?.textContent,
      ).toBe("21.6%");
      expect(card.querySelector(".account-updated")?.textContent).toContain(
        "3 分钟前",
      );
      expect(root.querySelector<HTMLElement>("#account-modal")!.hidden).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  it("loads stored accounts on mount, escapes upstream content, and maps offline/auth_failed states", async () => {
    const api = {
      getAccountStatus: vi
        .fn()
        .mockResolvedValueOnce({
          ...ONLINE_PAYLOAD,
          data: { ...ONLINE_PAYLOAD.data, name: "<img src=x onerror=bad()>" },
        })
        .mockResolvedValueOnce({ state: "offline" })
        .mockResolvedValueOnce({ state: "auth_failed" }),
    };
    const seed = [
      { id: "acc1", password: "p1", addedAt: 1 },
      { id: "acc2", password: "p2", addedAt: 2 },
      { id: "acc3", password: "p3", addedAt: 3 },
    ];
    const { root, restore } = mount(api, seed);
    try {
      expect(api.getAccountStatus).toHaveBeenCalledTimes(3);
      await flush();
      await flush();
      const card1 = root.querySelector('[data-account-card="acc1"]')!;
      expect(card1.querySelector(".acc-char")?.textContent).toBe(
        "<img src=x onerror=bad()>",
      );
      expect(card1.querySelector("img")).toBeNull();
      expect(
        root.querySelector('[data-account-card="acc2"] .acc-stamp')
          ?.textContent,
      ).toBe("已离线");
      expect(
        root.querySelector('[data-account-card="acc3"] .acc-stamp')
          ?.textContent,
      ).toBe("密码错误");
    } finally {
      restore();
    }
  });

  it("tests credentials from the modal without saving them", async () => {
    const api = {
      getAccountStatus: vi.fn().mockResolvedValue({ state: "auth_failed" }),
    };
    const { root, storage, restore } = mount(api);
    try {
      root.querySelector<HTMLButtonElement>("#accounts-add")!.click();
      root.querySelector<HTMLInputElement>("#account-userid")!.value = "ghost";
      root.querySelector<HTMLInputElement>("#account-password")!.value =
        "wrong";
      root.querySelector<HTMLButtonElement>("#account-test")!.click();
      await flush();
      await flush();
      const status = root.querySelector("#account-modal-status")!;
      expect(status.textContent).toContain("账号或密码不正确");
      expect(status.className).toContain("is-error");
      expect(storage.getItem("lastro.accounts.v1")).toBeNull();
      expect(root.querySelectorAll("[data-account-card]")).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("rejects duplicate account ids and missing fields", async () => {
    const api = { getAccountStatus: vi.fn().mockResolvedValue(ONLINE_PAYLOAD) };
    const { dom, root, storage, restore } = mount(api, [
      { id: "testbot", password: "p", addedAt: 1 },
    ]);
    try {
      await flush();
      root.querySelector<HTMLButtonElement>("#accounts-add")!.click();
      root.querySelector<HTMLInputElement>("#account-userid")!.value =
        "testbot";
      root.querySelector<HTMLInputElement>("#account-password")!.value = "p";
      root
        .querySelector("#account-form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );
      expect(
        root.querySelector("#account-modal-status")?.textContent,
      ).toContain("已经添加过了");
      expect(JSON.parse(storage.getItem("lastro.accounts.v1")!)).toHaveLength(
        1,
      );
      root.querySelector<HTMLInputElement>("#account-userid")!.value = "";
      root
        .querySelector("#account-form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );
      expect(
        root.querySelector("#account-modal-status")?.textContent,
      ).toContain("请先填写账号和密码");
    } finally {
      restore();
    }
  });

  it("deletes an account only after the two-step confirm", async () => {
    const api = {
      getAccountStatus: vi.fn().mockResolvedValue({ state: "offline" }),
    };
    const { root, storage, restore } = mount(api, [
      { id: "acc1", password: "p1", addedAt: 1 },
    ]);
    try {
      await flush();
      await flush();
      const deleteButton = root.querySelector<HTMLButtonElement>(
        '[data-delete="acc1"]',
      )!;
      deleteButton.click();
      expect(root.querySelector('[data-delete="acc1"]')?.textContent).toContain(
        "确认删除",
      );
      expect(JSON.parse(storage.getItem("lastro.accounts.v1")!)).toHaveLength(
        1,
      );
      root.querySelector<HTMLButtonElement>('[data-delete="acc1"]')!.click();
      expect(root.querySelector('[data-account-card="acc1"]')).toBeNull();
      expect(storage.getItem("lastro.accounts.v1")).toBe("[]");
      expect(root.querySelector<HTMLElement>("#accounts-empty")!.hidden).toBe(
        false,
      );
    } finally {
      restore();
    }
  });

  it("shows an error card when the query fails", async () => {
    const api = {
      getAccountStatus: vi
        .fn()
        .mockRejectedValue(new Error("无法连接 LastRO 官方服务器，请稍后再试")),
    };
    const { root, restore } = mount(api, [
      { id: "acc1", password: "p1", addedAt: 1 },
    ]);
    try {
      await flush();
      await flush();
      const card = root.querySelector('[data-account-card="acc1"]')!;
      expect(card.querySelector(".acc-stamp")?.textContent).toBe("查询失败");
      expect(card.querySelector(".acc-note--warn")?.textContent).toContain(
        "无法连接 LastRO 官方服务器",
      );
    } finally {
      restore();
    }
  });
});
