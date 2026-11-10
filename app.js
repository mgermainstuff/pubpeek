// PubPeek app: open .pub files, show pages, print, export PDF / PNG, batch convert. Everything runs locally.
import { buildPages, TEXT_CSS } from './render.js';

const $ = (id) => document.getElementById(id);
const STORE_URL = ''; // set to the Microsoft Store listing URL at launch
$('textcss').textContent = TEXT_CSS;

// Full version = installed from the Microsoft Store (Edge sets this referrer on first launch). Otherwise: free preview.
if (document.referrer.startsWith('app-info://platform/microsoft-store')) { try { localStorage.setItem('pp_full', '1'); } catch (e) {} }
const FULL = (() => { try { return localStorage.getItem('pp_full') === '1'; } catch (e) { return false; } })();
if (!FULL) { $('upsell').style.display = 'block'; if (STORE_URL) $('storeMsg').innerHTML = `<a href="${STORE_URL}">Get the full version in the Microsoft Store</a> for clean PDFs and unlimited batch conversion.`; }

let enginePromise = null;
const engine = () => (enginePromise ||= createPubEngine());
let doc = null; // { name, pages:[{w,h,svg}], stats }

async function parsePub(bytes) {
  const M = await engine();
  const p = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, p);
  const r = M._pub_parse(p, bytes.length);
  M._free(p);
  if (!r) return null;
  const json = M.UTF8ToString(r);
  M._pub_free(r);
  return buildPages(JSON.parse(json));
}

const busy = (t) => { $('busy').style.display = t ? 'flex' : 'none'; if (t) $('busyText').textContent = t; return new Promise((r) => setTimeout(r, 30)); };
const notice = (t) => { $('notice').style.display = t ? 'block' : 'none'; $('notice').textContent = t || ''; };

async function openFile(file) {
  notice('');
  await busy('Opening ' + file.name + '…');
  try {
    const res = await parsePub(new Uint8Array(await file.arrayBuffer()));
    if (!res || !res.pages.length) { notice(`“${file.name}” could not be read. It may not be a Publisher file, or it may be damaged or password-protected.`); return; }
    doc = { name: file.name.replace(/\.pub$/i, ''), ...res };
    show();
  } catch (e) { console.error(e); notice('Sorry — something went wrong reading that file.'); } finally { busy(''); }
}

function show() {
  $('drop').style.display = 'none';
  const host = $('pages'); host.innerHTML = '';
  doc.pages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'page'; d.style.width = Math.round(p.w * 96 / 72) + 'px';
    d.innerHTML = p.svg.replace(/ width="[\d.]+pt" height="[\d.]+pt"/, '');
    host.appendChild(d);
    const n = document.createElement('div'); n.className = 'pnum'; n.textContent = `Page ${i + 1} of ${doc.pages.length}`; host.appendChild(n);
  });
  $('docname').textContent = doc.name + '.pub';
  for (const b of ['bPrint', 'bPdf', 'bPng']) $(b).disabled = false;
  const warn = [];
  if (doc.stats.unsupportedImages) warn.push(`${doc.stats.unsupportedImages} picture(s) use a format this version cannot draw yet and appear as grey boxes`);
  if (!doc.stats.text && doc.stats.shapes < 8) warn.push('this file seems to contain decorative text (WordArt) that cannot be shown yet');
  notice(warn.length ? 'Note: ' + warn.join('; ') + '.' : '');
  $('main').scrollTop = 0;
}

// ---------- print (vector, uses the system print dialog; choose "Save as PDF" for a searchable PDF) ----------
function printDoc() {
  const p0 = doc.pages[0];
  $('pagecss').textContent = `@page{size:${p0.w}pt ${p0.h}pt;margin:0}`;
  $('print').innerHTML = doc.pages.map((p) => `<div class="pp" style="width:${p.w}pt;height:${p.h}pt">${p.svg.replace(/ width="[\d.]+pt" height="[\d.]+pt"/, '')}</div>`).join('');
  window.print();
}

// ---------- flatten: turn laid-out HTML text boxes into plain SVG text ----------
// Browsers refuse to export a canvas that drew an SVG containing HTML, so before rasterising we let the
// browser lay the text out, read back where every word landed, and re-emit it as positioned SVG text.
const SVGNS = 'http://www.w3.org/2000/svg';
const xe = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function flattenPage(page) {
  const host = $('measure');
  host.style.width = Math.round(page.w * 96 / 72) + 'px';
  host.innerHTML = page.svg.replace(/ width="[\d.]+pt" height="[\d.]+pt"/, '');
  const svg = host.firstElementChild;
  svg.style.width = '100%'; svg.style.display = 'block';
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const box = svg.getBoundingClientRect(), k = page.w / box.width;
  const range = document.createRange();
  const n2 = (v) => Math.round(v * 100) / 100;
  for (const fo of [...svg.querySelectorAll('foreignObject')]) {
    const tr = fo.getAttribute('transform');
    if (tr) fo.removeAttribute('transform');
    let out = '';
    for (const td of fo.querySelectorAll('td')) {
      const r = td.getBoundingClientRect(), cs = getComputedStyle(td);
      const x = (r.left - box.left) * k, y = (r.top - box.top) * k, w = r.width * k, h = r.height * k;
      if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) out += `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="${cs.backgroundColor}"/>`;
      const sides = { Top: [x, y, x + w, y], Bottom: [x, y + h, x + w, y + h], Left: [x, y, x, y + h], Right: [x + w, y, x + w, y + h] };
      for (const sd in sides) { const bw = parseFloat(cs['border' + sd + 'Width']); if (bw > 0 && cs['border' + sd + 'Style'] !== 'none') { const q = sides[sd]; out += `<line x1="${n2(q[0])}" y1="${n2(q[1])}" x2="${n2(q[2])}" y2="${n2(q[3])}" stroke="${cs['border' + sd + 'Color']}" stroke-width="${n2(bw)}"/>`; } }
    }
    const emit = (node, a, b, attrs, upper) => {
      range.setStart(node, a); range.setEnd(node, b);
      const rects = range.getClientRects();
      if (!rects.length) return;
      if (rects.length > 1 && b - a > 1) { const mid = (a + b) >> 1; emit(node, a, mid, attrs, upper); emit(node, mid, b, attrs, upper); return; }
      const r = rects[0]; if (!r.width) return;
      let t = node.data.slice(a, b); if (upper) t = t.toUpperCase();
      out += `<text x="${n2((r.left - box.left) * k)}" y="${n2((r.top - box.top) * k)}"${attrs}>${xe(t)}</text>`;
    };
    const walker = document.createTreeWalker(fo, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const el = node.parentElement, cs = getComputedStyle(el);
      let under = false; for (let a = el; a && a !== fo; a = a.parentElement) if (/underline/.test(getComputedStyle(a).textDecorationLine)) under = true;
      const attrs = ` dominant-baseline="text-before-edge" font-family="${cs.fontFamily.replace(/"/g, "'")}" font-size="${n2(parseFloat(cs.fontSize))}" fill="${cs.color}"` +
        (parseInt(cs.fontWeight, 10) >= 600 ? ' font-weight="bold"' : '') + (cs.fontStyle === 'italic' ? ' font-style="italic"' : '') +
        (under ? ' text-decoration="underline"' : '') + (/small-caps/.test(cs.fontVariantCaps || cs.fontVariant) ? ' font-variant="small-caps"' : '') +
        (parseFloat(cs.letterSpacing) ? ` letter-spacing="${n2(parseFloat(cs.letterSpacing))}"` : '');
      const re = /\S+/g; let m;
      while ((m = re.exec(node.data))) emit(node, m.index, m.index + m[0].length, attrs, cs.textTransform === 'uppercase');
    }
    const g = document.createElementNS(SVGNS, 'g');
    if (tr) g.setAttribute('transform', tr);
    g.innerHTML = out;
    fo.replaceWith(g);
  }
  if (!FULL) { const t = document.createElementNS(SVGNS, 'text'); t.setAttribute('x', page.w / 2); t.setAttribute('y', page.h - 10); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-family', 'Segoe UI, Arial, sans-serif'); t.setAttribute('font-size', '10'); t.setAttribute('fill', '#0f5c5c'); t.setAttribute('fill-opacity', '0.75'); t.textContent = 'PubPeek preview — full version in the Microsoft Store'; svg.appendChild(t); }
  svg.removeAttribute('style'); svg.setAttribute('width', page.w + 'pt'); svg.setAttribute('height', page.h + 'pt');
  const s = new XMLSerializer().serializeToString(svg);
  host.innerHTML = '';
  return s;
}

// ---------- rasterise a page ----------
async function rasterise(page, dpi, type, quality) {
  const scale = dpi / 72, W = Math.round(page.w * scale), H = Math.round(page.h * scale);
  const url = URL.createObjectURL(new Blob([await flattenPage(page)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('render failed')); img.src = url; });
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
    const blob = await new Promise((r) => c.toBlob(r, type, quality));
    return { blob, W, H };
  } finally { URL.revokeObjectURL(url); }
}

// ---------- minimal PDF writer: one JPEG per page at the publication's real page size ----------
async function makePdf(pages, dpi = 200) {
  const enc = new TextEncoder(), chunks = [], offsets = [];
  let len = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; put(`${n} 0 obj\n`); put(body); put('\nendobj\n'); };
  put('%PDF-1.4\n%âãÏÓ\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], { blob, W, H } = await rasterise(p, dpi, 'image/jpeg', 0.9);
    const jpg = new Uint8Array(await blob.arrayBuffer());
    const n = 3 + i * 3, w = p.w.toFixed(2), h = p.h.toFixed(2);
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(n + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[n + 2] = len;
    put(`${n + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    put(jpg); put('\nendstream\nendobj\n');
  }
  const total = 2 + pages.length * 3, xref = len;
  put(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= total; n++) put(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function savePdf() { await busy('Creating PDF…'); try { download(await makePdf(doc.pages), doc.name + '.pdf'); } catch (e) { console.error(e); notice('Could not create the PDF.'); } finally { busy(''); } }
async function savePng() {
  await busy('Creating images…');
  try { for (let i = 0; i < doc.pages.length; i++) { const { blob } = await rasterise(doc.pages[i], 200, 'image/png'); download(blob, `${doc.name}-page${String(i + 1).padStart(2, '0')}.png`); await new Promise((r) => setTimeout(r, 250)); } }
  catch (e) { console.error(e); notice('Could not create the images.'); } finally { busy(''); }
}

// ---------- batch: many .pub files -> PDFs in a folder the user picks ----------
async function batch(files) {
  if (!files.length) return;
  if (!FULL && files.length > 3) { notice('Preview mode converts up to 3 files at a time. The full version in the Microsoft Store has no limit.'); files = files.slice(0, 3); }
  let dir = null;
  if (window.showDirectoryPicker) { try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { return; } }
  let ok = 0; const failed = [];
  for (let i = 0; i < files.length; i++) {
    await busy(`Converting ${i + 1} of ${files.length}: ${files[i].name}`);
    try {
      const res = await parsePub(new Uint8Array(await files[i].arrayBuffer()));
      if (!res || !res.pages.length) { failed.push(files[i].name); continue; }
      const pdf = await makePdf(res.pages), name = files[i].name.replace(/\.pub$/i, '') + '.pdf';
      if (dir) { const h = await dir.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(pdf); await w.close(); }
      else { download(pdf, name); await new Promise((r) => setTimeout(r, 400)); }
      ok++;
    } catch (e) { console.error(e); failed.push(files[i].name); }
  }
  busy('');
  notice(`Converted ${ok} of ${files.length} file(s) to PDF.` + (failed.length ? ` Could not read: ${failed.join(', ')}.` : ''));
}

// ---------- wiring ----------
const pick = () => $('file').click();
$('bOpen').onclick = pick; $('bOpen2').onclick = pick;
$('file').onchange = (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; };
$('bPrint').onclick = printDoc; $('bPdf').onclick = savePdf; $('bPng').onclick = savePng;
$('bBatch').onclick = () => $('files').click();
$('files').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; batch(f); };
const drop = $('drop');
addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
addEventListener('dragleave', () => drop.classList.remove('over'));
addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = [...e.dataTransfer.files].filter((x) => /\.pub$/i.test(x.name)); if (f.length === 1) openFile(f[0]); else if (f.length > 1) batch(f); });
if ('launchQueue' in window) launchQueue.setConsumer(async (p) => { if (p.files && p.files.length) { const fs = await Promise.all(p.files.map((h) => h.getFile())); if (fs.length === 1) openFile(fs[0]); else batch(fs); } });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__pp = { openFile, makePdf, rasterise, flattenPage, get doc() { return doc; } }; // test hooks
