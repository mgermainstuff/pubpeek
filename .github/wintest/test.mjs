// Drives the hosted PubPeek app in Microsoft Edge on Windows: opens real .pub files, exports PDF/PNG,
// exercises the Save, Print and batch buttons, and saves screenshots + a report for review.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const URL = process.env.PP_URL || 'https://mgermainstuff.github.io/pubpeek/';
const BZ = 'https://bugs.documentfoundation.org/attachment.cgi?id=';
const SAMPLES = [
  ['tika-test', 'https://raw.githubusercontent.com/apache/tika/main/tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/src/test/resources/test-documents/testPUBLISHER.pub'],
  ['flyer', BZ + '75659'], ['booklet', BZ + '83079'], ['certificate', BZ + '113069'],
  ['missal', BZ + '125942'], ['wordart', BZ + '79338'], ['shapes', BZ + '161173'],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('samples', { recursive: true });

async function dl(url, dest) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'curl/8' } });
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 512 && b.readUInt32BE(0) === 0xd0cf11e0) { fs.writeFileSync(dest, b); return true; } }
    } catch (e) {}
    await sleep(8000);
  }
  return false;
}
const toB64 = `async (blob) => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }`;

const report = { url: URL, results: [], errors: [] };
const have = [];
for (const [n, u] of SAMPLES) {
  const p = path.resolve('samples', n + '.pub');
  if (await dl(u, p)) have.push([n, p]); else report.results.push({ name: n, error: 'sample download failed (not an app failure)' });
  await sleep(2500);
}
fs.writeFileSync(path.resolve('samples', 'junk.pub'), Buffer.from('this is not a publisher file at all'));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => report.errors.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error') report.errors.push('console: ' + m.text()); });
const idle = () => page.waitForFunction(() => document.getElementById('busy').style.display === 'none' || document.getElementById('busy').style.display === '', null, { timeout: 120000 });

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  report.fonts = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d');
    const w = (f) => { c.font = '72px ' + f; return c.measureText('mmmmmmmmmmlliW').width; };
    const b1 = w('monospace'), b2 = w('serif');
    return Object.fromEntries(['Calibri', 'Tahoma', 'Times New Roman', 'Franklin Gothic Book', 'Gabriola', 'Segoe UI', 'Arial', 'Edwardian Script ITC', 'Maiandra GD', 'Blackadder ITC'].map((f) => [f, w(`"${f}", monospace`) !== b1 || w(`"${f}", serif`) !== b2]));
  });
  report.apis = await page.evaluate(() => ({ showDirectoryPicker: 'showDirectoryPicker' in window, launchQueue: 'launchQueue' in window, serviceWorker: 'serviceWorker' in navigator }));
  await page.screenshot({ path: 'out/00-start.png' });

  for (const [n, p] of have) {
    const r = { name: n };
    try {
      const t0 = Date.now();
      await page.setInputFiles('#file', p);
      await page.waitForFunction((nm) => (window.__pp.doc && window.__pp.doc.name === nm) || /could not be read|went wrong/.test(document.getElementById('notice').textContent), n, { timeout: 60000 });
      await idle();
      Object.assign(r, await page.evaluate(() => ({ pages: window.__pp.doc ? window.__pp.doc.pages.length : 0, stats: window.__pp.doc && window.__pp.doc.stats, notice: document.getElementById('notice').textContent })));
      r.openMs = Date.now() - t0;
      await page.screenshot({ path: `out/${n}-app.png` });
      const t1 = Date.now();
      const pdf = await page.evaluate(`(async () => (${toB64})(await window.__pp.makePdf(window.__pp.doc.pages)))()`);
      fs.writeFileSync(`out/${n}.pdf`, Buffer.from(pdf, 'base64')); r.pdfMs = Date.now() - t1; r.pdfBytes = Buffer.from(pdf, 'base64').length;
      const png = await page.evaluate(`(async () => (${toB64})((await window.__pp.rasterise(window.__pp.doc.pages[0], 72, 'image/png')).blob))()`);
      fs.writeFileSync(`out/${n}-page1.png`, Buffer.from(png, 'base64'));
    } catch (e) { r.error = String(e).slice(0, 300); }
    report.results.push(r);
  }

  // real button paths, using the last opened document
  try { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#bPdf')]); await d.saveAs('out/button-save.pdf'); report.saveButton = { ok: true, name: d.suggestedFilename() }; } catch (e) { report.saveButton = { ok: false, error: String(e).slice(0, 200) }; }
  await idle();
  try {
    await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
    await page.click('#bPrint');
    report.printButton = await page.evaluate(() => ({ called: window.__printed === true, pagesPrepared: document.getElementById('print').children.length, pageCss: document.getElementById('pagecss').textContent }));
    await page.pdf({ path: 'out/print-output.pdf', preferCSSPageSize: true, printBackground: true });
  } catch (e) { report.printButton = { error: String(e).slice(0, 200) }; }

  // junk file must fail politely
  await page.setInputFiles('#file', path.resolve('samples', 'junk.pub'));
  await page.waitForFunction(() => /could not be read/.test(document.getElementById('notice').textContent), null, { timeout: 30000 }).catch(() => {});
  report.junk = await page.evaluate(() => document.getElementById('notice').textContent);

  // batch (download fallback, since a folder picker cannot be automated)
  try {
    await page.evaluate(() => { window.showDirectoryPicker = undefined; });
    const dls = []; page.on('download', (d) => dls.push(d));
    await page.setInputFiles('#files', have.slice(0, 3).map((x) => x[1]));
    await page.waitForFunction(() => /Converted \d+ of/.test(document.getElementById('notice').textContent), null, { timeout: 120000 });
    await sleep(1500);
    report.batch = { notice: await page.evaluate(() => document.getElementById('notice').textContent), downloads: dls.map((d) => d.suggestedFilename()) };
    for (const d of dls) await d.saveAs('out/batch-' + d.suggestedFilename()).catch(() => {});
    await page.screenshot({ path: 'out/99-batch.png' });
  } catch (e) { report.batch = { error: String(e).slice(0, 200) }; }
} catch (e) { report.fatal = String(e).slice(0, 400); }
fs.writeFileSync('out/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.on('unhandledRejection', () => {}); process.on('uncaughtException', () => { process.exit(0); });
try { await browser.close(); } catch (e) {}
process.exit(0);
