import type { ElectronApplication } from '@playwright/test';

/** Simulate the native affirmative button in main, never renderer authority. */
export async function confirmNativeDisclosure(app: ElectronApplication, recipient: 'Export folder' | 'Apple Photos'): Promise<void> {
  await app.evaluate(({ dialog }, expectedRecipient) => {
    dialog.showMessageBox = (options: unknown) => {
      if (
        typeof options !== 'object' ||
        options === null ||
        !('detail' in options) ||
        typeof options.detail !== 'string' ||
        !options.detail.includes(`Destination: ${expectedRecipient} (shared)`) ||
        !options.detail.includes('Include for this export: location') ||
        !('defaultId' in options) ||
        options.defaultId !== 0 ||
        !('cancelId' in options) ||
        options.cancelId !== 0
      )
        return Promise.reject(new Error('Unexpected native disclosure confirmation'));
      return Promise.resolve({ response: 1, checkboxChecked: false });
    };
  }, recipient);
}
