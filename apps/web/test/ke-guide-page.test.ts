import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { GUIDE_RULES, matchRule, mountKeGuidePage } from "../src/ke-guide-page";

function renderPage(): { dom: JSDOM; root: HTMLElement; restore: () => void } {
  const dom = new JSDOM('<main id="app"></main>', {
    url: "https://ltsd.ro/ke/guide",
  });
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  const root = dom.window.document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Missing test app root");
  mountKeGuidePage(root);
  return {
    dom,
    root,
    restore: () => {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    },
  };
}

describe("KoreEngine guide page", () => {
  it("renders the guide structure, FAQ accordion and entry links", () => {
    const { root, restore } = renderPage();
    try {
      // 通用 FAQ 使用原生 details，且同一时间只展开一条。
      const faqs = [...root.querySelectorAll(".kg-faq-list details")];
      expect(faqs.length).toBeGreaterThan(0);
      expect(faqs.every((item) => item.getAttribute("name") === "ke-faq")).toBe(
        true,
      );

      // 三个入口 + 脱机版下载入口。
      expect(root.querySelector('a[href="/ke/my"]')).not.toBeNull();
      expect(root.querySelector('a[href="/ke/hall"]')).not.toBeNull();
      expect(root.querySelector('a[href="/client"]')).not.toBeNull();
      expect(root.querySelector('a[href="/ke/download"]')).not.toBeNull();

      // 脱机版区块与新增 FAQ。
      expect(root.querySelector(".kg-offline")).not.toBeNull();
      expect(
        faqs.some((item) =>
          item.querySelector("summary")?.textContent?.includes("macOS 和 iOS 现在能用吗？"),
        ),
      ).toBe(true);

      // 导航高亮本页。
      expect(
        root.querySelector('.site-nav a[aria-current="page"]'),
      ).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("does not expose the useSelf_item config block source", () => {
    const { root, restore } = renderPage();
    try {
      expect(root.querySelector("pre")).toBeNull();
      expect(root.textContent).not.toContain("useSelf_item");
      expect(root.textContent).not.toContain("EFST_ALL_RIDING");
    } finally {
      restore();
    }
  });

  it("updates the rule ledger when the input changes", () => {
    const { dom, root, restore } = renderPage();
    try {
      const input = root.querySelector<HTMLInputElement>("#kg-rule-input")!;
      input.value = "黄色药水";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

      expect(root.querySelector("[data-rule-result]")?.textContent).toContain(
        "?色药水",
      );
      expect(
        root.querySelector(".kg-ledger-row.is-hit")?.getAttribute("data-rule"),
      ).toBe("wild-color");

      input.value = "杰勒比结晶";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(
        root.querySelector(".kg-ledger-row.is-hit")?.getAttribute("data-rule"),
      ).toBe("all");
      expect(root.querySelector("[data-rule-result]")?.textContent).toContain(
        "all 兜底",
      );
    } finally {
      restore();
    }
  });

  it("toggles the hero panel between running and paused", () => {
    const { dom, root, restore } = renderPage();
    try {
      const toggle =
        root.querySelector<HTMLButtonElement>("[data-hero-toggle]")!;
      expect(toggle.textContent).toBe("关闭自动");

      toggle.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );

      expect(toggle.textContent).toBe("开启自动");
      expect(root.querySelector("[data-hero-task]")?.textContent).toBe("idle");
      expect(
        [...root.querySelectorAll("[data-hero-mode]")].some(
          (node) => node.textContent === "OFF",
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("matchRule", () => {
  it("prefers an exact name over wildcards", () => {
    expect(matchRule("红色药水")?.rule.id).toBe("exact-red");
    expect(matchRule("红色药水")?.reason).toBe("精确名优先");
  });

  it("matches a numeric item id", () => {
    expect(matchRule("12622")?.rule.id).toBe("item-12622");
    expect(matchRule("12622")?.reason).toBe("数字 ID 命中");
  });

  it("matches * and ? wildcards in file order", () => {
    expect(matchRule("红色药")?.rule.id).toBe("wild-red");
    expect(matchRule("黄色药水")?.rule.id).toBe("wild-color");
    expect(matchRule("波利卡片")?.rule.id).toBe("wild-card");
  });

  it("takes the first matching wildcard row", () => {
    const rules = [
      {
        id: "first",
        pattern: "红*",
        label: "红*",
        kind: "wildcard" as const,
        note: "",
      },
      {
        id: "second",
        pattern: "*药",
        label: "*药",
        kind: "wildcard" as const,
        note: "",
      },
    ];
    expect(matchRule("红色药水", rules)?.rule.id).toBe("first");
  });

  it("falls back to all when nothing matches", () => {
    expect(matchRule("杰勒比结晶")?.rule.id).toBe("all");
    expect(matchRule("杰勒比结晶")?.reason).toBe("没有具体规则，落到 all 兜底");
  });

  it("compares names case-insensitively", () => {
    const rules = [
      {
        id: "latin",
        pattern: "Poring",
        label: "Poring",
        kind: "name" as const,
        note: "",
      },
    ];
    expect(matchRule("poring", rules)?.rule.id).toBe("latin");
  });

  it("returns null for empty input and does not mutate the shipped rules", () => {
    expect(matchRule("   ")).toBeNull();
    expect(GUIDE_RULES.map((rule) => rule.id)).toEqual([
      "exact-red",
      "item-12622",
      "wild-red",
      "wild-color",
      "wild-card",
      "all",
    ]);
  });
});
