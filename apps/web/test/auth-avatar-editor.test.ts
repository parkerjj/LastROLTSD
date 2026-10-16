import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { authApi, AuthApiError } from '../src/auth/api';
import { AuthStore, authStore, type AuthStoreApi } from '../src/auth/store';
import type { AuthAcceptedResponse } from '../src/auth/types';
import { mountAuthDialogs } from '../src/auth/dialogs';

let restoreDom: (() => void) | undefined;

function mountRegister() {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/' });
  const previousDocument = globalThis.document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  restoreDom = () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    dom.window.close();
    restoreDom = undefined;
  };
  const storeApi: AuthStoreApi = {
    me: vi.fn(async () => { throw new AuthApiError(401, 'AUTH_UNAUTHENTICATED', '请先登录'); }),
    refreshSession: vi.fn(async () => ({ expires_at: 30_000, csrf_token: 'session-csrf' })),
    logout: vi.fn(async () => undefined),
    setSessionCsrf: vi.fn(),
    clearSessionCsrf: vi.fn(),
    onSessionFailure: vi.fn(() => () => undefined),
    sessionRevision: 0,
  };
  const store = new AuthStore(storeApi, { broadcastChannel: null });
  const dispose = mountAuthDialogs(dom.window.document, store, authApi);
  const trigger = dom.window.document.createElement('button');
  trigger.type = 'button';
  trigger.dataset.openRegister = '';
  dom.window.document.body.append(trigger);
  trigger.click();
  trigger.remove();
  return { dom, root: dom.window.document.body as HTMLElement, store, dispose };
}

function installCanvasHarness(
  dom: JSDOM,
  sizeForQuality: (quality: number) => number = () => 100,
  outputType = 'image/webp',
) {
  const drawImage = vi.fn();
  const qualities: number[] = [];
  const context = {
    clearRect: vi.fn(),
    drawImage,
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value(callback: BlobCallback, type?: string, quality?: number) {
      qualities.push(quality ?? 0);
      const bytes = new Uint8Array(sizeForQuality(quality ?? 0));
      callback(new Blob([bytes], { type: outputType || type || 'image/png' }));
    },
  });
  return { drawImage, qualities };
}

function selectFile(dom: JSDOM, input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function fillRegistration(dom: JSDOM, root: HTMLElement): void {
  root.querySelector<HTMLInputElement>('#dialogRegisterEmail')!.value = 'player@example.test';
  root.querySelector<HTMLInputElement>('#dialogRegisterName')!.value = '主号';
  root.querySelector<HTMLInputElement>('#dialogRegisterPassword')!.value = 'password';
  root.querySelector<HTMLInputElement>('#dialogRegisterPasswordConfirmation')!.value = 'password';
  root.querySelector<HTMLFormElement>('#dialog-register-form')!.dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  restoreDom?.();
  authStore.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('mounts a keyboard-accessible square crop editor for optional registration avatars', () => {
  const { root, dispose } = mountRegister();
  try {
    const editor = root.querySelector<HTMLElement>('#register-avatar-editor');
    expect(editor).not.toBeNull();
    expect(editor?.querySelector('canvas[role="img"][tabindex="0"]')).not.toBeNull();
    expect(editor?.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe('image/jpeg,image/png,image/webp');
    expect(editor?.querySelector<HTMLInputElement>('input[type="range"]')).not.toBeNull();
  } finally {
    dispose();
  }
});

it('moves and zooms the square crop and submits only bounded WebP Base64', async () => {
  const accepted: AuthAcceptedResponse = { accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null } };
  let finishRegister!: (response: AuthAcceptedResponse) => void;
  const register = vi.spyOn(authApi, 'register').mockImplementation(() => new Promise((resolve) => {
    finishRegister = resolve;
  }));
  vi.spyOn(authApi, 'login').mockRejectedValue(new Error('自动登录不可用'));
  const { dom, root, dispose } = mountRegister();
  const canvas = installCanvasHarness(dom, (quality) => quality >= 0.7 ? 40_000 : 100);
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 512, height: 256, close }));
  Object.defineProperty(dom.window, 'createImageBitmap', { configurable: true, value: decode });
  try {
    const fileInput = root.querySelector<HTMLInputElement>('#register-avatar-editor input[type="file"]')!;
    selectFile(dom, fileInput, new dom.window.File(['synthetic pixels'], 'source.png', { type: 'image/png' }));
    await vi.waitFor(() => expect(canvas.drawImage).toHaveBeenCalled());

    const crop = root.querySelector<HTMLCanvasElement>('#register-avatar-editor canvas')!;
    const zoom = root.querySelector<HTMLInputElement>('#register-avatar-editor input[type="range"]')!;
    zoom.value = '2';
    zoom.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    crop.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    crop.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 50, clientY: 50, bubbles: true }));
    crop.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 70, clientY: 50, bubbles: true }));
    crop.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 70, clientY: 50, bubbles: true }));
    const cropDraw = canvas.drawImage.mock.calls.filter((args) => args.length === 9).at(-1);
    expect(cropDraw).toBeDefined();
    expect(cropDraw?.[3]).toBe(cropDraw?.[4]);

    fillRegistration(dom, root);

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(fileInput.disabled).toBe(true);
    const submitted = register.mock.calls[0]![0];
    expect(submitted.avatar_base64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(submitted.avatar_base64).not.toContain('data:image/');
    expect(submitted.avatar_base64!.length).toBeLessThanOrEqual(43_692);
    expect(canvas.qualities).toEqual([0.8, 0.7, 0.6]);
    expect(decode).toHaveBeenCalledTimes(1);
    finishRegister(accepted);
    await vi.waitFor(() => expect(fileInput.disabled).toBe(false));
  } finally {
    dispose();
    expect(close).toHaveBeenCalledTimes(1);
  }
});

it('scales pointer movement to the rendered crop size on narrow screens', async () => {
  const { dom, root, dispose } = mountRegister();
  const { drawImage } = installCanvasHarness(dom);
  Object.defineProperty(dom.window, 'createImageBitmap', {
    configurable: true,
    value: vi.fn(async () => ({ width: 512, height: 256, close: vi.fn() })),
  });
  try {
    selectFile(dom, root.querySelector<HTMLInputElement>('#register-avatar-editor input[type="file"]')!,
      new dom.window.File(['pixels'], 'source.png', { type: 'image/png' }));
    await vi.waitFor(() => expect(drawImage).toHaveBeenCalled());

    const crop = root.querySelector<HTMLCanvasElement>('#register-avatar-editor canvas')!;
    vi.spyOn(crop, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 128, height: 128, top: 0, right: 128, bottom: 128, left: 0,
      toJSON: () => ({}),
    });
    crop.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true }));
    crop.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 32, clientY: 0, bubbles: true }));

    expect(drawImage.mock.calls.at(-1)?.[1]).toBe(64);
  } finally {
    dispose();
  }
});

it('rejects a PNG fallback instead of labeling it as WebP', async () => {
  const register = vi.spyOn(authApi, 'register');
  const { dom, root, dispose } = mountRegister();
  const canvas = installCanvasHarness(dom, () => 8, 'image/png');
  Object.defineProperty(dom.window, 'createImageBitmap', {
    configurable: true,
    value: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })),
  });
  try {
    selectFile(dom, root.querySelector<HTMLInputElement>('#register-avatar-editor input[type="file"]')!,
      new dom.window.File(['pixels'], 'source.webp', { type: 'image/webp' }));
    await vi.waitFor(() => expect(canvas.drawImage).toHaveBeenCalled());
    fillRegistration(dom, root);
    await vi.waitFor(() => expect(root.textContent).toContain('无法导出 WebP'));
    expect(canvas.qualities).toEqual([0.8]);
    expect(register).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it('stops after five quality attempts when the WebP remains over 32 KiB', async () => {
  const register = vi.spyOn(authApi, 'register');
  const { dom, root, dispose } = mountRegister();
  const canvas = installCanvasHarness(dom, () => 32_769);
  Object.defineProperty(dom.window, 'createImageBitmap', {
    configurable: true,
    value: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })),
  });
  try {
    selectFile(dom, root.querySelector<HTMLInputElement>('#register-avatar-editor input[type="file"]')!,
      new dom.window.File(['pixels'], 'source.png', { type: 'image/png' }));
    await vi.waitFor(() => expect(canvas.drawImage).toHaveBeenCalled());
    fillRegistration(dom, root);
    await vi.waitFor(() => expect(root.textContent).toContain('超过 32 KiB'));
    expect(canvas.qualities).toEqual([0.8, 0.7, 0.6, 0.5, 0.4]);
    expect(register).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it('ignores a superseded image decode and releases decoded images on page exit', async () => {
  const { dom, root, dispose } = mountRegister();
  const { drawImage } = installCanvasHarness(dom);
  let finishFirst!: (bitmap: ImageBitmap) => void;
  const firstClose = vi.fn();
  const secondClose = vi.fn();
  const firstBitmap = { width: 120, height: 120, close: firstClose } as unknown as ImageBitmap;
  const secondBitmap = { width: 200, height: 160, close: secondClose } as unknown as ImageBitmap;
  const decode = vi.fn((file: Blob) => file.type === 'image/jpeg'
    ? new Promise<ImageBitmap>((resolve) => { finishFirst = resolve; })
    : Promise.resolve(secondBitmap));
  Object.defineProperty(dom.window, 'createImageBitmap', { configurable: true, value: decode });
  try {
    const fileInput = root.querySelector<HTMLInputElement>('#register-avatar-editor input[type="file"]')!;
    selectFile(dom, fileInput, new dom.window.File(['first'], 'first.jpg', { type: 'image/jpeg' }));
    selectFile(dom, fileInput, new dom.window.File(['second'], 'second.webp', { type: 'image/webp' }));
    await vi.waitFor(() => expect(drawImage).toHaveBeenCalled());
    expect(drawImage.mock.calls.at(-1)?.[0]).toBe(secondBitmap);

    finishFirst(firstBitmap);
    await Promise.resolve();
    await Promise.resolve();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(drawImage.mock.calls.at(-1)?.[0]).toBe(secondBitmap);

    dispose();
    expect(secondClose).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
  }
});

it('revokes a temporary object URL when the image element fallback decodes a file', async () => {
  const { dom, root, dispose } = mountRegister();
  const { drawImage } = installCanvasHarness(dom);
  const createObjectURL = vi.fn(() => 'blob:http://localhost/synthetic-avatar');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(dom.window.URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(dom.window.URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: vi.fn(async () => undefined),
  });
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'naturalWidth', { configurable: true, value: 200 });
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'naturalHeight', { configurable: true, value: 180 });
  vi.stubGlobal('createImageBitmap', undefined);
  try {
    selectFile(dom, root.querySelector<HTMLInputElement>('#register-avatar-editor input[type="file"]')!,
      new dom.window.File(['pixels'], 'source.png', { type: 'image/png' }));
    await vi.waitFor(() => expect(drawImage).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/synthetic-avatar');
    dispose();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
  }
});
