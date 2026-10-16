const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_AVATAR_BYTES = 32 * 1024;
const MAX_AVATAR_BASE64_LENGTH = 43_692;
const OUTPUT_QUALITIES = [0.8, 0.7, 0.6, 0.5, 0.4] as const;

export interface AvatarEditorOptions {
  initialAvatarUrl?: string | null;
  compact?: boolean;
  onChange?: (state: { selected: boolean; processing: boolean }) => void;
}

export interface AvatarEditor {
  getValue(): Promise<string | null>;
  setDisabled(disabled: boolean): void;
  reset(): void;
  destroy(): void;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

interface CropState {
  centerX: number;
  centerY: number;
  zoom: number;
}

export function mountAvatarEditor(container: HTMLElement, options: AvatarEditorOptions = {}): AvatarEditor {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  container.innerHTML = options.compact ? `
    <div class="auth-avatar-editor compact" data-avatar-editor>
      <div class="auth-avatar-editor-preview" data-avatar-preview-wrap>
        <img class="auth-avatar-editor-current" data-avatar-current alt="当前头像" hidden>
        <canvas class="auth-avatar-editor-crop" data-avatar-crop width="256" height="256" role="img" aria-label="头像裁剪预览。使用方向键移动裁剪区域。" tabindex="0" hidden></canvas>
        <span class="auth-avatar-editor-empty" data-avatar-empty aria-hidden="true"><i class="ph ph-user-circle"></i></span>
      </div>
      <span class="auth-avatar-editor-text"><strong>头像（可选）</strong><span>会用于站内公开展示，保存时自动裁剪为 256×256。</span></span>
      <label class="auth-avatar-editor-file">选择图片
        <input data-avatar-file type="file" accept="image/jpeg,image/png,image/webp">
      </label>
      <p class="auth-help">支持 JPEG、PNG 或 WebP，最大 10 MiB。</p>
      <label class="auth-avatar-editor-zoom" for="avatar-editor-zoom">缩放
        <input id="avatar-editor-zoom" data-avatar-zoom type="range" min="1" max="4" step="0.05" value="1" disabled>
      </label>
      <button class="secondary-button auth-avatar-editor-cancel" data-avatar-cancel type="button" hidden>取消本次裁剪</button>
      <p class="auth-status" data-avatar-status role="status" aria-live="polite"></p>
    </div>` : `
    <div class="auth-avatar-editor" data-avatar-editor>
      <div class="auth-avatar-editor-preview" data-avatar-preview-wrap>
        <img class="auth-avatar-editor-current" data-avatar-current alt="当前头像" hidden>
        <canvas class="auth-avatar-editor-crop" data-avatar-crop width="256" height="256" role="img" aria-label="头像裁剪预览。使用方向键移动裁剪区域。" tabindex="0" hidden></canvas>
        <span class="auth-avatar-editor-empty" data-avatar-empty aria-hidden="true">头像预览</span>
      </div>
      <label class="auth-avatar-editor-file">选择图片
        <input data-avatar-file type="file" accept="image/jpeg,image/png,image/webp">
      </label>
      <p class="auth-help">支持 JPEG、PNG 或 WebP，最大 10 MiB。图片只在本机裁剪，保存时仅发送 256×256 WebP。</p>
      <label class="auth-avatar-editor-zoom" for="avatar-editor-zoom">缩放
        <input id="avatar-editor-zoom" data-avatar-zoom type="range" min="1" max="4" step="0.05" value="1" disabled>
      </label>
      <button class="secondary-button auth-avatar-editor-cancel" data-avatar-cancel type="button" hidden>取消本次裁剪</button>
      <p class="auth-status" data-avatar-status role="status" aria-live="polite"></p>
    </div>`;

  const editor = container.querySelector<HTMLElement>('[data-avatar-editor]')!;
  const fileInput = editor.querySelector<HTMLInputElement>('[data-avatar-file]')!;
  const cropCanvas = editor.querySelector<HTMLCanvasElement>('[data-avatar-crop]')!;
  const zoomInput = editor.querySelector<HTMLInputElement>('[data-avatar-zoom]')!;
  const cancelButton = editor.querySelector<HTMLButtonElement>('[data-avatar-cancel]')!;
  const currentImage = editor.querySelector<HTMLImageElement>('[data-avatar-current]')!;
  const emptyPreview = editor.querySelector<HTMLElement>('[data-avatar-empty]')!;
  const status = editor.querySelector<HTMLElement>('[data-avatar-status]')!;
  const listeners: Array<() => void> = [];

  let alive = true;
  let imageGeneration = 0;
  let editRevision = 0;
  let decoded: DecodedImage | null = null;
  let selected = false;
  let disabled = false;
  let drag: { x: number; y: number; pointerId: number | undefined } | null = null;
  let objectUrl: string | null = null;
  let crop: CropState = { centerX: 0, centerY: 0, zoom: 1 };

  if (options.initialAvatarUrl) {
    currentImage.src = options.initialAvatarUrl;
    currentImage.hidden = false;
    emptyPreview.hidden = true;
  }

  const addListener = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ): void => {
    const listener = handler as EventListener;
    target.addEventListener(type, listener);
    listeners.push(() => target.removeEventListener(type, listener));
  };

  const setStatus = (message: string): void => {
    if (alive) status.textContent = message;
  };

  const updateDisabledControls = (): void => {
    fileInput.disabled = disabled;
    zoomInput.disabled = disabled || !decoded;
    cancelButton.disabled = disabled;
    cropCanvas.tabIndex = disabled ? -1 : 0;
    if (disabled) cropCanvas.setAttribute('aria-disabled', 'true');
    else cropCanvas.removeAttribute('aria-disabled');
  };

  const reportSelection = (hasSelection: boolean, processing = false): void => {
    selected = hasSelection;
    cancelButton.hidden = !hasSelection && !processing;
    updateDisabledControls();
    options.onChange?.({ selected: hasSelection, processing });
  };

  const revokeObjectUrl = (): void => {
    if (!objectUrl) return;
    (view?.URL ?? URL).revokeObjectURL(objectUrl);
    objectUrl = null;
  };

  const clearDecoded = (): void => {
    decoded?.close?.();
    decoded = null;
    cropCanvas.hidden = true;
    updateDisabledControls();
    currentImage.hidden = !options.initialAvatarUrl;
    emptyPreview.hidden = Boolean(options.initialAvatarUrl);
  };

  const cropSize = (image: DecodedImage): number => Math.min(image.width, image.height) / crop.zoom;

  const clampCrop = (image: DecodedImage): void => {
    const side = cropSize(image);
    crop.centerX = Math.max(side / 2, Math.min(image.width - side / 2, crop.centerX));
    crop.centerY = Math.max(side / 2, Math.min(image.height - side / 2, crop.centerY));
  };

  const drawPreview = (): void => {
    if (!alive || !decoded) return;
    const context = cropCanvas.getContext('2d');
    if (!context) {
      setStatus('此浏览器无法预览裁剪图片。');
      return;
    }
    clampCrop(decoded);
    const side = cropSize(decoded);
    cropCanvas.width = 256;
    cropCanvas.height = 256;
    context.clearRect(0, 0, 256, 256);
    context.drawImage(
      decoded.source,
      crop.centerX - side / 2,
      crop.centerY - side / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
    cropCanvas.hidden = false;
    currentImage.hidden = true;
    emptyPreview.hidden = true;
  };

  const decodeImage = async (file: File): Promise<DecodedImage> => {
    const createBitmap = view?.createImageBitmap?.bind(view) ?? globalThis.createImageBitmap;
    if (typeof createBitmap === 'function') {
      const bitmap = await createBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    }

    const createUrl = (view?.URL ?? URL).createObjectURL.bind(view?.URL ?? URL);
    const url = createUrl(file);
    objectUrl = url;
    const image = doc.createElement('img');
    image.decoding = 'async';
    try {
      if (typeof image.decode === 'function') {
        image.src = url;
        await image.decode();
      } else {
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error('image decode failed'));
          image.src = url;
        });
      }
    } finally {
      if (objectUrl === url) revokeObjectUrl();
    }
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  };

  const selectImage = async (file: File): Promise<void> => {
    const generation = ++imageGeneration;
    editRevision += 1;
    clearDecoded();
    revokeObjectUrl();
    reportSelection(false, true);
    zoomInput.value = '1';
    drag = null;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type.toLowerCase())) {
      reportSelection(false);
      setStatus('请选择 JPEG、PNG 或 WebP 图片。');
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      reportSelection(false);
      setStatus('图片不能超过 10 MiB，请换一张图片。');
      return;
    }

    setStatus('正在读取图片…');
    try {
      const image = await decodeImage(file);
      if (!alive || generation !== imageGeneration) {
        image.close?.();
        return;
      }
      if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width < 1 || image.height < 1) {
        image.close?.();
        throw new Error('invalid image dimensions');
      }
      decoded = image;
      crop = { centerX: image.width / 2, centerY: image.height / 2, zoom: 1 };
      updateDisabledControls();
      drawPreview();
      reportSelection(true);
      setStatus(options.compact ? '已选择图片，可拖动圆形预览微调位置。' : '拖动图片调整位置，也可用方向键微调；缩放后确认裁剪。');
    } catch {
      if (alive && generation === imageGeneration) {
        reportSelection(false);
        setStatus('图片无法读取，请换一张图片。');
      }
    }
  };

  const adjustCrop = (mutate: () => void): void => {
    if (!decoded) return;
    mutate();
    editRevision += 1;
    drawPreview();
  };

  addListener(fileInput, 'change', () => {
    if (disabled) return;
    const file = fileInput.files?.[0];
    if (file) void selectImage(file);
  });

  addListener(zoomInput, 'input', () => {
    if (disabled) return;
    const zoom = Number(zoomInput.value);
    if (!Number.isFinite(zoom)) return;
    adjustCrop(() => { crop.zoom = Math.max(1, Math.min(4, zoom)); });
  });

  addListener(cropCanvas, 'pointerdown', (event) => {
    if (disabled || !decoded) return;
    const pointer = event as PointerEvent;
    event.preventDefault();
    cropCanvas.focus();
    drag = { x: pointer.clientX, y: pointer.clientY, pointerId: pointer.pointerId };
    try { cropCanvas.setPointerCapture(pointer.pointerId); } catch { /* JSDOM and older browsers may not support capture. */ }
  });

  addListener(cropCanvas, 'pointermove', (event) => {
    if (disabled || !decoded || !drag) return;
    const pointer = event as PointerEvent;
    if (drag.pointerId !== undefined && pointer.pointerId !== undefined && drag.pointerId !== pointer.pointerId) return;
    const dx = pointer.clientX - drag.x;
    const dy = pointer.clientY - drag.y;
    drag = { ...drag, x: pointer.clientX, y: pointer.clientY };
    const bounds = cropCanvas.getBoundingClientRect();
    adjustCrop(() => {
      const side = cropSize(decoded!);
      crop.centerX -= dx * side / (bounds.width || 256);
      crop.centerY -= dy * side / (bounds.height || 256);
    });
  });

  const endDrag = (): void => { drag = null; };
  addListener(cropCanvas, 'pointerup', endDrag);
  addListener(cropCanvas, 'pointercancel', endDrag);

  addListener(cropCanvas, 'keydown', (event) => {
    if (disabled || !decoded) return;
    const key = (event as KeyboardEvent).key;
    const step = cropSize(decoded) * 0.025;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => { crop.centerX -= step; },
      ArrowRight: () => { crop.centerX += step; },
      ArrowUp: () => { crop.centerY -= step; },
      ArrowDown: () => { crop.centerY += step; },
    };
    const move = moves[key];
    if (!move) return;
    event.preventDefault();
    adjustCrop(move);
  });

  addListener(cancelButton, 'click', () => { if (!disabled) reset(); });

  const getValue = async (): Promise<string | null> => {
    if (!alive) throw abortError();
    if (!selected || !decoded) return null;
    const imageGenerationAtStart = imageGeneration;
    const revisionAtStart = editRevision;
    const image = decoded;
    const cropSnapshot = { ...crop };
    const side = Math.min(image.width, image.height) / cropSnapshot.zoom;
    const canvas = doc.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('此浏览器无法导出头像，请换一款浏览器。');
    context.drawImage(
      image.source,
      cropSnapshot.centerX - side / 2,
      cropSnapshot.centerY - side / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );

    for (const quality of OUTPUT_QUALITIES) {
      ensureCurrentExport(imageGenerationAtStart, revisionAtStart);
      const blob = await canvasToBlob(canvas, 'image/webp', quality);
      ensureCurrentExport(imageGenerationAtStart, revisionAtStart);
      if (blob.type.toLowerCase() !== 'image/webp') {
        throw new Error('此浏览器无法导出 WebP 头像，请换一款浏览器。');
      }
      if (blob.size === 0) throw new Error('头像导出失败，请重试。');
      if (blob.size > MAX_AVATAR_BYTES) continue;
      const base64 = await blobToBase64(blob, view);
      ensureCurrentExport(imageGenerationAtStart, revisionAtStart);
      if (base64.length > MAX_AVATAR_BASE64_LENGTH) {
        throw new Error('头像压缩后仍超过 32 KiB，请换一张图片。');
      }
      return base64;
    }
    throw new Error('头像压缩后仍超过 32 KiB，请换一张图片。');
  };

  function ensureCurrentExport(generation: number, revision: number): void {
    if (!alive || generation !== imageGeneration || revision !== editRevision) throw abortError();
  }

  function reset(): void {
    if (!alive) return;
    imageGeneration += 1;
    editRevision += 1;
    drag = null;
    fileInput.value = '';
    clearDecoded();
    revokeObjectUrl();
    zoomInput.value = '1';
    reportSelection(false);
    setStatus('');
  }

  function setDisabled(value: boolean): void {
    if (!alive) return;
    disabled = value;
    if (disabled) drag = null;
    updateDisabledControls();
  }

  function destroy(): void {
    if (!alive) return;
    alive = false;
    imageGeneration += 1;
    editRevision += 1;
    drag = null;
    for (const remove of listeners.splice(0)) remove();
    decoded?.close?.();
    decoded = null;
    revokeObjectUrl();
    options.onChange?.({ selected: false, processing: false });
    container.replaceChildren();
  }

  updateDisabledControls();
  options.onChange?.({ selected: false, processing: false });
  return { getValue, setDisabled, reset, destroy };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('头像导出失败，请重试。'));
      }, type, quality);
    } catch (error) {
      reject(error);
    }
  });
}

async function blobToBase64(blob: Blob, view: Window | null): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encode = view?.btoa?.bind(view) ?? globalThis.btoa;
  if (typeof encode !== 'function') throw new Error('此浏览器无法编码头像，请换一款浏览器。');
  return encode(binary);
}

function abortError(): DOMException {
  return new DOMException('Avatar operation was superseded.', 'AbortError');
}
