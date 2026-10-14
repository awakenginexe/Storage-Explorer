import { test, expect, chromium, type Browser, type Page, type Request } from '@playwright/test';
import { mkdir, writeFile, link, symlink, realpath, stat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

let browser: Browser;
let page: Page;
const fixture = path.resolve('.superpowers/native-fixture');
const colorFixture = path.resolve(`.superpowers/size-fixture-${Date.now()}`);
const cancelFixture = path.resolve('.superpowers/cancel-fixture');
const errors: string[] = [];

test.beforeAll(async () => {
  console.log('Preparing real filesystem fixture');
  await mkdir(path.join(fixture, '資料 ไทย'), { recursive: true });
  await mkdir(path.join(fixture, 'many'), { recursive: true });
  await writeFile(path.join(fixture, 'video.mp4'), Buffer.alloc(65536));
  await writeFile(path.join(fixture, '資料 ไทย', 'notes.txt'), Buffer.alloc(100));
  await writeFile(path.join(fixture, 'archive.zip'), Buffer.alloc(8192));
  await writeFile(path.join(fixture, 'zero.txt'), Buffer.alloc(0));
  if (!(await stat(path.join(fixture, 'many', '1049.bin')).catch(() => null))) {
    for (let start = 0; start < 1050; start += 50) await Promise.all(Array.from({ length: Math.min(50, 1050 - start) }, (_, j) => {
      const i = start + j; return writeFile(path.join(fixture, 'many', `${String(i).padStart(4, '0')}.bin`), Buffer.alloc(i % 31));
    }));
  }
  try { await link(path.join(fixture, 'video.mp4'), path.join(fixture, 'video-link.mp4')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  try { await symlink(await realpath(fixture), path.join(fixture, 'loop'), 'junction'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  await mkdir(path.join(colorFixture, 'large-folder'), { recursive: true });
  for (const [name, size] of [['large-folder/large.bin', 2 * 1024 ** 3], ['huge.bin', 12 * 1024 ** 3]] as const) {
    const file = path.join(colorFixture, name);
    await writeFile(file, []);
    await promisify(execFile)('fsutil.exe', ['sparse', 'setflag', file]);
    const handle = await open(file, 'r+');
    try { await handle.truncate(size); } finally { await handle.close(); }
  }
  await writeFile(path.join(colorFixture, 'small.txt'), 'small');
  await mkdir(cancelFixture, { recursive: true });
  if (!(await stat(path.join(cancelFixture, '4999.bin')).catch(() => null))) {
    for (let start = 0; start < 5000; start += 50) await Promise.all(Array.from({ length: 50 }, (_, j) => writeFile(path.join(cancelFixture, `${start + j}.bin`), [])));
  }
  console.log('Connecting to native WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  await expect.poll(() => browser.contexts()[0].pages().some(p => /localhost:1420|tauri.localhost/.test(p.url())), { timeout: 15_000 }).toBeTruthy();
  page = browser.contexts()[0].pages().find(p => /localhost:1420|tauri.localhost/.test(p.url()))!;
  if (!page) throw new Error('Start npm run tauri dev with WebView2 debugging on port 9223.');
  page.on('pageerror', e => errors.push(e.message));
  console.log('Reloading native interface');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Storage overview', exact: true })).toBeVisible();
});

test.afterAll(async () => {
  await browser?.close();
});

test('page-load failures are visible and scans recover without restarting the app', async () => {
  await page.getByRole('button', { name: 'Scan a folder', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Folder path' }).fill(fixture);
  await page.getByRole('button', { name: 'Analyze folder', exact: true }).click();
  await expect(page.locator('.scan-coverage')).toContainText('Partial coverage');
  await page.locator('.entry-name').filter({ hasText: /^many$/ }).dblclick();
  await expect(page.locator('.table-footer')).toContainText('1,050 entries');
  await page.evaluate(folder => (window as any).__TAURI_INTERNALS__.invoke('start_scan', { path: folder }), fixture);
  await page.locator('.entry-row[role=row]').first().focus();
  await page.keyboard.press('End');
  await expect(page.locator('.table-error')).toContainText('replaced');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.table-error')).toBeVisible();
  await page.getByRole('button', { name: 'Scan a folder', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Folder path' }).fill(fixture);
  await page.getByRole('button', { name: 'Analyze folder', exact: true }).click();
  await expect(page.locator('.table-footer')).toContainText('7 entries');
  await expect(page.locator('.table-error')).toHaveCount(0);
});

test('native drives, recursive scan, hierarchy, sorting, filters, map, coverage and cancellation', async () => {
  console.log('Checking drive dashboard');
  await page.getByRole('button', { name: 'Storage overview', exact: true }).click();
  await expect(page.locator('.drive-card').first()).toBeVisible();
  const nativeDrives = await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('list_drives'));
  expect(nativeDrives.some((d: { total: number }) => d.total > 0)).toBeTruthy();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.drive-card').first()).toBeVisible();
  await page.getByRole('button', { name: 'About & scan notes' }).click();
  await expect(page.getByRole('dialog')).toContainText('not implemented');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Scan a folder', exact: true }).last().click();
  console.log('Submitting real folder scan');
  await page.getByRole('textbox', { name: 'Folder path' }).fill(fixture);
  await page.getByRole('button', { name: 'Analyze folder', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Folder explorer', exact: true })).toBeVisible();
  await expect(page.locator('.scan-coverage')).toContainText('Partial coverage');
  await expect(page.locator('.table-footer')).toContainText('7 entries');
  await page.locator('.scan-coverage').click();
  await expect(page.getByRole('dialog')).toContainText('Hard-linked files');
  await expect(page.locator('.coverage-stats > div').first()).toContainText('1');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.screenshot({ path: '.superpowers/overview-scan.png' });

  for (const name of ['Name', 'Logical size', 'On disk', 'Files', 'Modified', '% of parent']) {
    const header = page.getByRole('columnheader').filter({ has: page.getByRole('button', { name, exact: true }) });
    await header.getByRole('button', { name, exact: true }).click();
    await expect(header).toHaveAttribute('aria-sort', /ascending|descending/);
    const previous = await header.getAttribute('aria-sort');
    await header.getByRole('button', { name, exact: true }).click();
    await expect(header).toHaveAttribute('aria-sort', previous === 'ascending' ? 'descending' : 'ascending');
  }
  const separator = page.getByRole('separator', { name: 'Resize Name' });
  const width = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus(); await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(width + 16));
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Folders', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('columnheader').filter({ hasText: 'Folders' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand 資料 ไทย' }).click();
  await expect(page.locator('.entry-name').filter({ hasText: 'notes.txt' })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse 資料 ไทย' }).click();
  await expect(page.locator('.entry-name').filter({ hasText: 'notes.txt' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search within this folder' }).fill('notes.txt');
  await expect(page.locator('.table-footer')).toContainText('1 entries');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('.table-footer')).toContainText('7 entries');
  await page.locator('.entry-name').filter({ hasText: /^many$/ }).dblclick();
  await expect(page.locator('.table-footer')).toContainText('1,050 entries');
  expect(await page.locator('.entry-row').count()).toBeLessThan(70);
  const firstRow = page.locator('.entry-row[role=row]').first();
  await firstRow.focus(); await page.keyboard.press('End');
  await expect(page.locator('.entry-row[data-index="1049"]')).toContainText('.bin');
  await page.keyboard.press('Home');
  await expect(page.locator('.entry-row[data-index="0"]')).toContainText('.bin');
  await page.getByRole('button', { name: 'Parent folder', exact: true }).click();
  await expect(page.locator('.table-footer')).toContainText('7 entries');
  await page.locator('.entry-name').filter({ hasText: 'archive.zip' }).click();
  await expect(page.locator('.details-panel')).toContainText('8.00 KiB');
  await page.getByRole('button', { name: 'Open location', exact: true }).click();
  await page.getByRole('button', { name: 'Close entry details' }).click();
  await page.locator('.entry-name').filter({ hasText: 'archive.zip' }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Open location in Explorer' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Largest files', exact: true }).click();
  await expect(page.locator('.table-footer')).toContainText('1,054 files');
  await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('videos');
  await expect(page.locator('.table-footer')).toContainText('1 files');
  await page.getByRole('spinbutton', { name: 'Minimum size' }).fill('0.1');
  await expect(page.getByText('No matching entries', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('textbox', { name: 'Location', exact: true }).fill('資料');
  await expect(page.locator('.table-footer')).toContainText('1 files');
  await page.getByRole('textbox', { name: 'Location', exact: true }).fill('');
  await page.getByRole('button', { name: 'Storage map', exact: true }).click();
  await expect(page.locator('.map-canvas canvas')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Preparing storage map…', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.superpowers/treemap.png' });
  const mapBounds = await page.locator('.map-canvas').boundingBox();
  if (!mapBounds) throw new Error('Missing treemap bounds');
  await page.mouse.click(mapBounds.x + mapBounds.width * .9, mapBounds.y + mapBounds.height * .2);
  await expect(page.locator('.current-crumb')).toContainText('many');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.locator('.table-footer')).toContainText('1,050 entries');
  await page.getByRole('button', { name: 'Rescan', exact: true }).click();
  await expect(page.locator('.scan-coverage')).toContainText('Partial coverage');
  await page.getByRole('button', { name: 'Storage overview', exact: true }).click();
  await expect(page.getByText('From your current scan', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.superpowers/dashboard.png' });
  await page.getByRole('button', { name: 'Scan a folder', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Folder path' }).fill(cancelFixture);
  await page.getByRole('button', { name: 'Analyze folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop scan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop scan', exact: true }).click();
  await expect(page.locator('.scan-coverage')).toContainText('Cancelled');
  await page.getByRole('button', { name: 'Scan a folder', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Folder path' }).fill(fixture);
  await page.getByRole('button', { name: 'Analyze folder', exact: true }).click();
  await expect(page.locator('.scan-coverage')).toContainText('Partial coverage');
  await page.setViewportSize({ width: 900, height: 640 });
  const geometry = await page.evaluate(() => ({ width: window.innerWidth, docWidth: document.documentElement.scrollWidth, tableHeight: document.querySelector('.table-scroll')?.getBoundingClientRect().height || 0 }));
  expect(geometry.docWidth).toBeLessThanOrEqual(geometry.width);
  expect(geometry.tableHeight).toBeGreaterThan(100);
  await page.screenshot({ path: '.superpowers/minimum-window.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Largest files', exact: true }).click();
  await expect(page.locator('.table-footer')).toContainText('1,054 files');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole('button', { name: 'Storage overview', exact: true }).click();
  expect(errors).toEqual([]);
});

test('size colors cover files and folders, and rapid search issues one real query', async () => {
  await page.getByRole('button', { name: 'Scan a folder', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Folder path' }).fill(colorFixture);
  await page.getByRole('button', { name: 'Analyze folder', exact: true }).click();
  await expect(page.locator('.scan-coverage')).toContainText('Scan complete');
  await expect(page.locator('.entry-row[data-size-tier=huge]')).toContainText('huge.bin');
  await expect(page.locator('.entry-row[data-size-tier=large]')).toContainText('large-folder');
  await expect(page.locator('.size-legend')).toContainText('≥ 10 GiB');
  await page.getByRole('button', { name: 'Expand large-folder' }).click();
  await expect(page.locator('.entry-row[data-size-tier=large]')).toHaveCount(2);
  await expect(page.locator('.scan-coverage')).toContainText('Scan complete');
  await expect(page.locator('.entry-row').filter({ hasText: 'small.txt' })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: '.superpowers/size-highlights.png' });
  const calls: Request[] = [];
  const count = (request: Request) => { if (request.url().includes('/query_entries')) calls.push(request); };
  page.on('request', count);
  try {
    const search = page.getByRole('textbox', { name: 'Search within this folder' });
    await search.pressSequentially('large.bin', { delay: 15 });
    await expect(page.locator('.table-footer')).toContainText('1 entries');
    expect(calls).toHaveLength(1);
    await expect(page.locator('.entry-row')).toContainText('large.bin');
  } finally {
    page.off('request', count);
  }
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'Storage map', exact: true }).click();
  await expect(page.locator('.map-legend')).toContainText('≥ 10 GiB');
  await expect(page.getByText('Preparing storage map…', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.superpowers/size-map.png' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(errors).toEqual([]);
});

test('a delayed initial status cannot overwrite scan completion', async () => {
  await page.evaluate(() => {
    (window as any).__originalFetch = window.fetch;
    (window as any).__delayedStatus = false;
    let delayed = false;
    window.fetch = async (...args) => {
      const response = await (window as any).__originalFetch(...args);
      if (!delayed && String(args[0]).includes('/scan_status')) {
        const status = await response.clone().json();
        if (status.status === 'scanning') {
          delayed = true;
          await new Promise(resolve => setTimeout(resolve, 2000));
          (window as any).__delayedStatus = true;
        }
      }
      return response;
    };
  });
  try {
    await page.getByRole('button', { name: 'Scan a folder', exact: true }).last().click();
    await page.getByRole('textbox', { name: 'Folder path' }).fill(cancelFixture);
    await page.getByRole('button', { name: 'Analyze folder', exact: true }).click();
    await expect(page.locator('.scan-coverage')).toContainText('Scan complete');
    await expect.poll(() => page.evaluate(() => (window as any).__delayedStatus)).toBe(true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.scan-coverage')).toContainText('Scan complete');
    await expect(page.getByRole('button', { name: 'Stop scan', exact: true })).toHaveCount(0);
  } finally { await page.evaluate(() => { window.fetch = (window as any).__originalFetch; }); }
});

test('paging retains its index while a real fixture scan publishes new entries', async () => {
  const result = await page.evaluate(async folder => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    const initial = await invoke('start_scan', { path: folder });
    const scanId = initial.scanId;
    const pause = () => new Promise(resolve => setTimeout(resolve, 20));
    try {
      let status = initial;
      while (status.files < 512 && status.status === 'scanning') { await pause(); status = await invoke('scan_status', { scanId }); }
      const query = { root: 0, largest: true, descending: true, limit: 256 };
      const first = await invoke('query_entries', { scanId, query });
      do { await pause(); status = await invoke('scan_status', { scanId }); } while (status.revision <= first.revision && status.status === 'scanning');
      const next = await invoke('query_entries', { scanId, query: { ...query, offset: 256, revision: first.revision } });
      const refreshed = await invoke('query_entries', { scanId, query });
      return { first: { total: first.total, revision: first.revision }, next: { total: next.total, revision: next.revision, count: next.rows.length }, refreshed: refreshed.revision, advanced: status.revision > first.revision };
    } finally { await invoke('cancel_scan', { scanId }); }
  }, cancelFixture);
  expect(result.advanced).toBe(true);
  expect(result.next.total).toBe(result.first.total);
  expect(result.next.revision).toBe(result.first.revision);
  expect(result.next.count).toBe(256);
  expect(result.refreshed).toBeGreaterThan(result.first.revision);
});
