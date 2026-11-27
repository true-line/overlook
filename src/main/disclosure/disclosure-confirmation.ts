import electron, { type MessageBoxOptions } from 'electron';

/** This prompt is owned by main; no renderer boolean authorizes disclosure. */
export async function confirmDisclosureWidening(
  detail: string,
  show: (options: MessageBoxOptions) => Promise<{ response: number }> = (options) => electron.dialog.showMessageBox(options),
): Promise<boolean> {
  const result = await show({
    type: 'warning',
    title: 'Include private fields in this export?',
    message: 'Review exactly what will leave Overlook.',
    detail,
    buttons: ['Cancel', 'Include for this export'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}
