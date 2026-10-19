import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountKePage } from "../src/ke-page";

const MALICIOUS_NAME = '<img src=x onerror="window.__ke_xss = 1">';
const MALICIOUS_MAP = '</option><svg onload="window.__ke_xss = 1">';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ke page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("角色下拉把 KE 自报的 char_name / map_name 当作纯文本，不解析为 HTML", async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/ke" });
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/ke/options.json") {
        return jsonResponse({ jobs: {}, skills: [], statuses: [], monsters: [], items: [], maps: [], timeouts: [] });
      }
      if (path === "/api/v1/ke/characters") {
        return jsonResponse({
          characters: [{ aid: 1, cid: 2, nid: 3, char_name: MALICIOUS_NAME, job_id: null, map_name: MALICIOUS_MAP, last_seen_at: Date.now() }],
        });
      }
      return jsonResponse({ profiles: [] });
    }));

    const root = dom.window.document.querySelector<HTMLElement>("#app")!;
    mountKePage(root);
    await wait(20);

    const select = root.querySelector<HTMLSelectElement>("#ke-char-select")!;
    expect(select.options).toHaveLength(1);
    expect(select.options[0]!.value).toBe("1:2:3");
    expect(select.options[0]!.textContent).toBe(`${MALICIOUS_NAME}（${MALICIOUS_MAP}）`);
    expect(select.querySelector("img, svg")).toBeNull();
    expect(root.querySelector("img[onerror], svg[onload]")).toBeNull();
  });
});
