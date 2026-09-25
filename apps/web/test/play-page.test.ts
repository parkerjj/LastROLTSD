import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPlayPage } from "../src/play-page";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mount() {
  const dom = new JSDOM('<main id="app"></main>', {
    url: "http://localhost/play",
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
  const root = dom.window.document.querySelector<HTMLElement>("#app")!;
  mountPlayPage(root);
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
  return { dom, root, restore };
}

describe("play launcher page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a fullscreen iframe pointing at the official client with a back link", () => {
    const { root, restore } = mount();
    try {
      const frame = root.querySelector<HTMLIFrameElement>(".game-frame")!;
      expect(frame.getAttribute("src")).toBe(
        "https://game.lastro.cn/ro/api.html?70.84",
      );
      expect(frame.hasAttribute("allowfullscreen")).toBe(true);
      expect(
        root.querySelector<HTMLAnchorElement>(".play-back")?.getAttribute(
          "href",
        ),
      ).toBe("/accounts");
    } finally {
      restore();
    }
  });

  it("postMessages the official init config into the iframe until it replies ready", async () => {
    const { dom, root, restore } = mount();
    try {
      const frame = root.querySelector<HTMLIFrameElement>(".game-frame")!;
      const frameWindow = frame.contentWindow!;
      const postMessage = vi.fn();
      frameWindow.postMessage = postMessage;

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
          source: frameWindow,
          data: "ready",
        }),
      );
      await wait(250);
      expect(postMessage.mock.calls.length).toBe(callsBeforeReady);
    } finally {
      restore();
    }
  });

  it("ignores ready-looking messages that do not come from the game frame", async () => {
    const { dom, root, restore } = mount();
    try {
      const frame = root.querySelector<HTMLIFrameElement>(".game-frame")!;
      const postMessage = vi.fn();
      frame.contentWindow!.postMessage = postMessage;

      await wait(150);
      const callsBefore = postMessage.mock.calls.length;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          origin: "https://game.lastro.cn",
          source: {} as Window,
          data: "ready",
        }),
      );
      await wait(250);
      expect(postMessage.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      restore();
    }
  });
});
