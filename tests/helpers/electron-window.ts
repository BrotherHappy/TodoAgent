import { expect, type ElectronApplication, type Page } from 'playwright/test';

/** A BrowserWindow can be emitted at about:blank, before its route is loaded. */
export async function waitForElectronWindow(app: ElectronApplication, kind: string): Promise<Page> {
  let match: Page | undefined;
  await expect.poll(() => {
    match = app.windows().find(page => {
      if (page.isClosed()) return false;
      try { return new URL(page.url()).searchParams.get('window') === kind; }
      catch { return false; }
    });
    return !!match;
  }, { message: `Wait for the ${kind} window to finish its initial navigation`, timeout: 20_000, intervals: [20, 50, 100, 250] }).toBe(true);
  await match!.waitForLoadState('domcontentloaded');
  return match!;
}
