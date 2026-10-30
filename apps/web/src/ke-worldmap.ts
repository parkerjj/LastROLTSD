// 世界地图选图浮层：层级切换 + 原图底图 + 格子热区（底图与格子布局 1:1 复刻游戏 WorldMap 组件），
// 数据来自 /ke/worldmap.json（由 scripts/build-ke-worldmap.mjs 从进阶客户端提取）。
// 配置工作台（ke-page）与萌新配置向导（ke-setup-guide-page）共用，避免两处各写一套选图逻辑。

import "./ke-worldmap.css";

// —— 世界地图选图（/ke/worldmap.json，由 scripts/build-ke-worldmap.mjs 从进阶客户端提取） ——

interface WorldmapPoint {
  code: string;
  codes?: string[];
  row: number;
  col: number;
  span: number;
  mvp?: boolean;
  name?: string;
  codeNames?: Record<string, string>;
}

interface WorldmapLayer {
  id: string;
  name: string;
  image: string;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  points: WorldmapPoint[];
}

interface WorldmapData {
  layers: WorldmapLayer[];
}

// —— 世界地图选图浮层 ——

// 缓存按页面根节点挂载：同一页面生命周期内只拉一次；失败后清除以允许重试。
const worldmapCache = new WeakMap<HTMLElement, Promise<WorldmapData>>();
function loadWorldmap(root: HTMLElement): Promise<WorldmapData> {
  const cached = worldmapCache.get(root);
  if (cached) return cached;
  const request = fetch("/ke/worldmap.json", { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<WorldmapData>;
    })
    .catch((err: unknown) => {
      worldmapCache.delete(root);
      throw err;
    });
  worldmapCache.set(root, request);
  return request;
}

interface WorldmapPickerOptions {
  title: string;
  value: string;
  onSelect: (code: string) => void;
  trigger: HTMLElement;
}

/** 打开与游戏一致的世界地图选图浮层；选中后回调 onSelect 并关闭，焦点归还原按钮。 */
export function openWorldmapPicker(root: HTMLElement, opts: WorldmapPickerOptions): void {
  root.querySelector(".ke-wmap-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "ke-wmap-overlay";
  overlay.innerHTML = `
    <section class="ke-wmap-dialog" role="dialog" aria-modal="true" aria-labelledby="ke-wmap-title">
      <div class="ke-wmap-head">
        <h2 class="ke-wmap-title" id="ke-wmap-title"></h2>
        <button type="button" class="ke-wmap-close" aria-label="关闭">×</button>
      </div>
      <div class="ke-wmap-tabs" role="tablist"></div>
      <div class="ke-wmap-stage-wrap">
        <p class="ke-wmap-message">地图加载中…</p>
      </div>
      <div class="ke-wmap-foot">
        <p class="ke-wmap-status">将鼠标移到地图格子上查看地图名称。</p>
        <p class="ke-wmap-hint" id="ke-wmap-hint">点击格子选图；带关联地图的格子（如红点 MVP 格）会弹出二级列表。也可直接在输入框填写地图代码。</p>
      </div>
    </section>`;
  overlay.querySelector<HTMLElement>(".ke-wmap-title")!.textContent = opts.title;
  root.appendChild(overlay);

  const dialog = overlay.querySelector<HTMLElement>(".ke-wmap-dialog")!;
  dialog.setAttribute("aria-describedby", "ke-wmap-hint");
  const tabsEl = overlay.querySelector<HTMLElement>(".ke-wmap-tabs")!;
  const stageWrap = overlay.querySelector<HTMLElement>(".ke-wmap-stage-wrap")!;
  const statusEl = overlay.querySelector<HTMLElement>(".ke-wmap-status")!;
  const closeBtn = overlay.querySelector<HTMLButtonElement>(".ke-wmap-close")!;
  // 悬停悬浮提示（中文名+代码，跟随光标，与游戏一致）
  const tipEl = document.createElement("div");
  tipEl.className = "ke-wmap-tip";
  tipEl.hidden = true;
  overlay.appendChild(tipEl);

  const close = () => {
    disposeMenu?.();
    disposeMenu = null;
    overlay.remove();
    opts.trigger.focus();
  };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  // 焦点圈在弹层内：Tab/Shift+Tab 在首尾可聚焦元素间循环，避免键盘用户穿出到背景页面。
  const focusables = (): HTMLElement[] =>
    Array.from(
      overlay.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const list = focusables();
    if (list.length === 0) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !overlay.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });
  // 地图数据加载是异步的，先把焦点移进弹层，键盘用户无需等待加载即可关闭。
  closeBtn.focus();

  const pointLabel = (point: WorldmapPoint): string => {
    const name = point.name ?? point.code;
    if (point.codes && point.codes.length > 1) {
      return `${name}（${point.code}，一格 ${point.codes.length} 张图）`;
    }
    return `${name}（${point.code}）`;
  };

  let disposeMenu: (() => void) | null = null; // 二级列表的监听清理器

  const renderLayer = (data: WorldmapData, layerId: string) => {
    disposeMenu?.();
    disposeMenu = null;
    const layer = data.layers.find((l) => l.id === layerId) ?? data.layers[0]!;
    tabsEl.querySelectorAll<HTMLButtonElement>(".ke-wmap-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.layer === layer.id);
    });
    stageWrap.innerHTML = "";
    // 外框跨层取最大网格宽/高，切换层级时浮层尺寸不变；内层按自身宽高比缩放居中。
    const maxGridW = Math.max(...data.layers.map((l) => l.cols * l.cellW));
    const maxGridH = Math.max(...data.layers.map((l) => l.rows * l.cellH));
    const gridW = layer.cols * layer.cellW;
    const gridH = layer.rows * layer.cellH;
    const frame = document.createElement("div");
    frame.className = "ke-wmap-stage-frame";
    frame.style.aspectRatio = `${maxGridW} / ${maxGridH}`;
    const stage = document.createElement("div");
    stage.className = "ke-wmap-stage";
    stage.style.aspectRatio = `${gridW} / ${gridH}`;
    if (gridW / gridH >= maxGridW / maxGridH) {
      stage.style.width = "100%";
      stage.style.left = "0";
      stage.style.top = "50%";
      stage.style.transform = "translateY(-50%)";
    } else {
      stage.style.height = "100%";
      stage.style.left = "50%";
      stage.style.top = "0";
      stage.style.transform = "translateX(-50%)";
    }
    const img = document.createElement("img");
    img.src = layer.image;
    img.alt = "";
    stage.appendChild(img);
    for (const point of layer.points) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "ke-wmap-cell";
      cell.dataset.code = point.code;
      cell.style.left = `${(point.col / layer.cols) * 100}%`;
      cell.style.top = `${(point.row / layer.rows) * 100}%`;
      cell.style.width = `${(point.span / layer.cols) * 100}%`;
      cell.style.height = `${(1 / layer.rows) * 100}%`;
      cell.setAttribute("aria-label", pointLabel(point));
      // 与游戏一致的格子小地图贴图（60x60，拉伸铺满格子）
      const tile = document.createElement("img");
      tile.className = "ke-wmap-cell-img";
      tile.src = `/ke/worldmap/tiles/${encodeURIComponent(point.code)}.png`;
      tile.alt = "";
      tile.draggable = false;
      cell.appendChild(tile);
      const isCurrent =
        opts.value !== "" &&
        (point.code === opts.value || (point.codes ?? []).includes(opts.value));
      if (isCurrent) cell.classList.add("active");
      if (point.mvp) {
        const mvp = document.createElement("i");
        mvp.className = "ke-wmap-mvp";
        mvp.title = "有 MVP";
        cell.appendChild(mvp);
      }
      const label = () => (point.name ? `${point.name}（${point.code}）` : point.code);
      const showStatus = () => {
        statusEl.innerHTML = "";
        const strong = document.createElement("strong");
        strong.textContent = point.name ?? point.code;
        statusEl.append(strong, document.createTextNode(` ${point.code}`));
      };
      // 悬停：框住格子 + 光标旁悬浮中文名（与游戏一致）
      const showTip = (x: number, y: number) => {
        tipEl.textContent = label();
        tipEl.hidden = false;
        const maxX = window.innerWidth - tipEl.offsetWidth - 8;
        const maxY = window.innerHeight - tipEl.offsetHeight - 8;
        tipEl.style.left = `${Math.max(4, Math.min(x + 14, maxX))}px`;
        tipEl.style.top = `${Math.max(4, Math.min(y + 16, maxY))}px`;
      };
      const hideTip = () => {
        tipEl.hidden = true;
      };
      cell.addEventListener("mouseenter", (e) => {
        showStatus();
        showTip((e as MouseEvent).clientX, (e as MouseEvent).clientY);
      });
      cell.addEventListener("mousemove", (e) => {
        showTip((e as MouseEvent).clientX, (e as MouseEvent).clientY);
      });
      cell.addEventListener("mouseleave", hideTip);
      cell.addEventListener("focus", () => {
        showStatus();
        const rect = cell.getBoundingClientRect();
        showTip(rect.left + rect.width / 2, rect.bottom);
      });
      cell.addEventListener("blur", hideTip);
      cell.addEventListener("click", () => {
        if (point.codes && point.codes.length > 1) {
          openMultiMenu(point, cell);
          return;
        }
        opts.onSelect(point.code);
        close();
      });
      stage.appendChild(cell);
    }
    frame.appendChild(stage);
    stageWrap.appendChild(frame);
  };

  // 一格多图（如海龟洞 tur_dun01~04）：在格子附近弹出二级菜单选具体层。
  // 菜单挂在浮层根节点上（position: fixed），避免被地图容器的 overflow 裁切。
  const openMultiMenu = (point: WorldmapPoint, cell: HTMLElement) => {
    disposeMenu?.();
    disposeMenu = null;
    const menu = document.createElement("div");
    menu.className = "ke-wmap-menu";
    menu.setAttribute("role", "menu");
    for (const code of point.codes ?? []) {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      const thumb = document.createElement("img");
      thumb.className = "ke-wmap-menu-img";
      thumb.src = `/ke/worldmap/tiles/${encodeURIComponent(code)}.png`;
      thumb.alt = "";
      thumb.draggable = false;
      const text = document.createElement("span");
      const name = point.codeNames?.[code];
      text.textContent = name && name !== code ? `${name}（${code}）` : code;
      item.append(thumb, text);
      item.addEventListener("click", () => {
        opts.onSelect(code);
        close();
      });
      menu.appendChild(item);
    }
    // 先隐藏插入再测量尺寸，贴格子下方展开；空间不足时翻到上方，并夹在视口内。
    menu.style.visibility = "hidden";
    overlay.appendChild(menu);
    const rect = cell.getBoundingClientRect();
    const menuW = menu.offsetWidth;
    const menuH = menu.offsetHeight;
    const gap = 4;
    const edge = 8;
    let left = rect.left;
    let top = rect.bottom + gap;
    if (top + menuH > window.innerHeight - edge) {
      top = Math.max(edge, rect.top - gap - menuH);
    }
    if (left + menuW > window.innerWidth - edge) left = window.innerWidth - edge - menuW;
    if (left < edge) left = edge;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "";
    menu.querySelector<HTMLButtonElement>("button")?.focus();

    // 鼠标移开格子和菜单后自动收起（保留从格子移到菜单的过渡时间）
    let closeTimer: number | null = null;
    const cancelClose = () => {
      if (closeTimer !== null) {
        window.clearTimeout(closeTimer);
        closeTimer = null;
      }
    };
    const detach = () => {
      cancelClose();
      cell.removeEventListener("mouseleave", onCellLeave);
      cell.removeEventListener("mouseenter", cancelClose);
      menu.removeEventListener("mouseenter", cancelClose);
      menu.removeEventListener("mouseleave", scheduleClose);
      dialog.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
    const closeMenu = () => {
      detach();
      menu.remove();
    };
    const scheduleClose = () => {
      cancelClose();
      closeTimer = window.setTimeout(() => {
        const focusInside = menu.contains(document.activeElement);
        closeMenu();
        if (focusInside) cell.focus();
      }, 160);
    };
    const onCellLeave = () => scheduleClose();
    // 滚动或缩放后固定定位会与格子错位，直接收起
    const onViewportChange = () => closeMenu();
    cell.addEventListener("mouseleave", onCellLeave);
    cell.addEventListener("mouseenter", cancelClose);
    menu.addEventListener("mouseenter", cancelClose);
    menu.addEventListener("mouseleave", scheduleClose);
    dialog.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    disposeMenu = closeMenu;
  };

  void loadWorldmap(root)
    .then((data) => {
      if (!overlay.isConnected || data.layers.length === 0) return;
      tabsEl.innerHTML = "";
      for (const layer of data.layers) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "ke-wmap-tab";
        tab.dataset.layer = layer.id;
        tab.setAttribute("role", "tab");
        tab.textContent = layer.name;
        tab.addEventListener("click", () => renderLayer(data, layer.id));
        tabsEl.appendChild(tab);
      }
      // 默认打开当前值所在的层；无当前值时打开第一层。
      const current = data.layers.find((layer) =>
        layer.points.some(
          (p) => p.code === opts.value || (p.codes ?? []).includes(opts.value),
        ),
      );
      renderLayer(data, (current ?? data.layers[0]!).id);
      closeBtn.focus();
    })
    .catch(() => {
      if (!overlay.isConnected) return;
      stageWrap.innerHTML = "";
      const message = document.createElement("p");
      message.className = "ke-wmap-message";
      message.textContent = "地图数据加载失败，请检查网络后重试。仍可直接在输入框填写地图代码。";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ke-btn-ghost ke-wmap-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", () => {
        overlay.remove();
        openWorldmapPicker(root, opts);
      });
      stageWrap.append(message, retry);
    });
}
