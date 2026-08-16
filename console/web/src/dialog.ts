export function openModalDialog(dialog: HTMLDialogElement | null, trigger: HTMLElement): void {
  if (dialog === null || dialog.open) return;
  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dialog.close();
  };
  dialog.addEventListener('keydown', closeOnEscape);
  dialog.addEventListener('close', () => {
    dialog.removeEventListener('keydown', closeOnEscape);
    trigger.focus();
  }, { once: true });
  dialog.showModal();
  window.requestAnimationFrame(() => dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus());
}
