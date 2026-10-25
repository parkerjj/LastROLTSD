import type { ProfileSharingInput, ProfileSharingMetadata } from '../../worker/src/ke/shared-profile-types';
import './profile-sharing.css';

export interface ProfileSharingControls {
  root: HTMLElement;
  reset(metadata: ProfileSharingMetadata | null): void;
  markWithdrawn(): void;
  value(): ProfileSharingInput;
  setBusy(busy: boolean): void;
  message(text: string): void;
}

export function createProfileSharing(doc: Document, onChange: () => void, onWithdraw: () => void): ProfileSharingControls {
  const root = doc.createElement('section');
  root.className = 'ke-sharing';
  root.setAttribute('aria-label', '共享设置');
  root.innerHTML = `<label class="ke-share-toggle"><input id="ke-share-enabled" type="checkbox"><span data-share-label></span></label>
    <p>勾选后保存，其他已登录玩家可以在配置大厅读取并复制完整的五份配置文件。</p>
    <label class="ke-share-description" for="ke-share-description">配置说明 <span>选填</span><textarea id="ke-share-description" rows="2" placeholder="适合什么场景？需要哪些技能或补给？"></textarea></label>
    <p class="ke-share-hint" data-share-hint></p><div class="ke-share-existing" data-share-existing hidden><span>分享码 <strong data-share-code></strong></span><a data-share-link href="/ke/hall">查看大厅条目</a><button type="button" data-share-withdraw>撤回分享</button></div>`;
  const checkbox = root.querySelector<HTMLInputElement>('#ke-share-enabled')!;
  const description = root.querySelector<HTMLTextAreaElement>('#ke-share-description')!;
  const label = root.querySelector<HTMLElement>('[data-share-label]')!;
  const hint = root.querySelector<HTMLElement>('[data-share-hint]')!;
  const existing = root.querySelector<HTMLElement>('[data-share-existing]')!;
  const code = root.querySelector<HTMLElement>('[data-share-code]')!;
  const link = root.querySelector<HTMLAnchorElement>('[data-share-link]')!;
  const withdraw = root.querySelector<HTMLButtonElement>('[data-share-withdraw]')!;
  let metadata: ProfileSharingMetadata | null = null;

  function render(): void {
    label.textContent = metadata ? '同时更新共享的配置' : '同时将此配置共享给他人';
    description.parentElement!.hidden = !checkbox.checked;
    hint.textContent = !checkbox.checked
      ? '本次只保存个人配置；已分享的版本不会改变，也不会撤回。'
      : metadata?.status === 'WITHDRAWN'
        ? '已撤回；保存后会重新发布，沿用原分享码。'
        : metadata?.status === 'PUBLISHED'
          ? '本次保存会更新大厅中的配置，分享码不变。'
          : '保存后会生成分享码，标题沿用方案名称。';
    existing.hidden = !metadata;
    code.textContent = metadata?.share_code ?? '';
    link.href = metadata ? `/ke/hall?code=${encodeURIComponent(metadata.share_code)}` : '/ke/hall';
    withdraw.hidden = metadata?.status !== 'PUBLISHED';
  }
  checkbox.addEventListener('change', () => { render(); onChange(); });
  description.addEventListener('input', onChange);
  withdraw.addEventListener('click', onWithdraw);
  render();
  return {
    root,
    reset(next) { metadata = next; checkbox.checked = next?.status === 'PUBLISHED'; description.value = next?.description ?? ''; render(); },
    markWithdrawn() { if (metadata) { metadata = { ...metadata, status: 'WITHDRAWN' }; checkbox.checked = false; render(); } },
    value: () => ({ enabled: checkbox.checked, description: description.value }),
    setBusy(busy) { checkbox.disabled = busy; description.disabled = busy; withdraw.disabled = busy; },
    message(text) { hint.textContent = text; },
  };
}
