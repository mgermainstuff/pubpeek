// PubPeek renderer: turns the engine's recorded drawing events into one SVG string per page.
// Pure string building (no DOM) so it runs in the browser, in a worker, and under Node for tests.
import { wmfToSvg } from './wmf.js';

const U = (v) => { // any librevenge length -> points
  if (v == null) return 0;
  const s = String(v), n = parseFloat(s);
  if (!isFinite(n)) return 0;
  if (s.endsWith('in')) return n * 72;
  if (s.endsWith('%')) return n / 100;
  return n;
};
const pct = (v, d = 1) => (v == null ? d : parseFloat(v) / 100);
const r2 = (n) => Math.round(n * 100) / 100;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sane = (pt) => (Math.abs(pt) > 2000 ? 0 : pt); // libmspub sometimes emits garbage margins

function fontStack(name) {
  const n = String(name || 'Times New Roman').replace(/^@/, '');
  const l = n.toLowerCase();
  let generic = 'sans-serif';
  if (/times|georgia|garamond|book|cambria|palatino|roman|serif|century|bodoni|perpetua|rockwell|constantia/.test(l) && !/sans/.test(l)) generic = 'serif';
  else if (/courier|consolas|mono|lucida console/.test(l)) generic = 'monospace';
  else if (/script|brush|hand|edwardian|blackadder|gabriola|vivaldi|kunstler|mistral|french|chancery|freestyle|palace|rage|vladimir|magneto|harlow/.test(l)) generic = 'cursive';
  return `'${n.replace(/'/g, '')}', ${generic}`;
}

function b64bytes(b64) {
  if (typeof atob === 'function') { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function buildPages(events) {
  const pages = [];
  let cur = null, style = {}, uid = 0, inMaster = false;
  let html = null, tbox = null, table = null, listStack = [], pageNo = 0;
  const stats = { wmf: 0, emf: 0, unsupportedImages: 0, text: 0, shapes: 0 };
  const out = (s) => { if (cur && !inMaster) cur.parts.push(s); };

  function tint(props) { // Publisher recoloured pictures: map black..white onto colour..white
    if (!cur || props['draw:color-mode'] !== 'greyscale' || props['draw:red'] == null) return '';
    const c = [pct(props['draw:red'], 0), pct(props['draw:green'], 0), pct(props['draw:blue'], 0)];
    const key = c.map((v) => Math.round(v * 255)).join('_');
    if (!cur.tints[key]) {
      cur.tints[key] = 'f' + (++uid);
      const row = (v) => `${r2((1 - v) * 0.2126)} ${r2((1 - v) * 0.7152)} ${r2((1 - v) * 0.0722)} 0 ${r2(v)}`;
      out(`<filter id="${cur.tints[key]}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${row(c[0])} ${row(c[1])} ${row(c[2])} 0 0 0 1 0"/></filter>`);
    }
    return ` filter="url(#${cur.tints[key]})"`;
  }

  function imageMarkup(mime, b64, x, y, w, h, extra = '') {
    if (/wmf/i.test(mime)) {
      stats.wmf++;
      const inner = wmfToSvg(b64bytes(b64));
      if (inner) return `<svg x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 1000 1000" preserveAspectRatio="none" overflow="hidden"${extra}>${inner}</svg>`;
      stats.unsupportedImages++;
      return '';
    }
    if (/emf|pict|tiff/i.test(mime)) { stats.emf++; stats.unsupportedImages++; return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="#f2f2f2" stroke="#bbb" stroke-dasharray="3 3"${extra}/>`; }
    return `<image x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" preserveAspectRatio="none" href="data:${mime};base64,${b64}"${extra}/>`;
  }

  function strokeAttrs() {
    const st = style['draw:stroke'];
    if (st === 'none' || (!st && !style['svg:stroke-color'])) return ' stroke="none"';
    let w = U(style['svg:stroke-width']); if (w < 0.25) w = 0.25;
    let a = ` stroke="${style['svg:stroke-color'] || '#000000'}" stroke-width="${r2(w)}"`;
    if (style['svg:stroke-opacity']) a += ` stroke-opacity="${pct(style['svg:stroke-opacity'])}"`;
    if (st === 'dash') {
      const d1 = U(style['draw:dots1-length']) || w, gap = U(style['draw:distance']) || w * 2;
      a += ` stroke-dasharray="${r2(Math.max(d1, w))} ${r2(Math.max(gap, w))}"`;
    }
    return a;
  }

  function emitShape(d, pts) {
    stats.shapes++;
    const fill = style['draw:fill'] || 'none';
    let xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
    const rule = style['svg:fill-rule'] === 'evenodd' ? ' fill-rule="evenodd"' : '';
    if (style['draw:shadow'] === 'visible' && fill !== 'none') {
      out(`<path d="${d}" transform="translate(${r2(U(style['draw:shadow-offset-x']))} ${r2(U(style['draw:shadow-offset-y']))})" fill="${style['draw:shadow-color'] || '#808080'}" fill-opacity="${pct(style['draw:shadow-opacity'])}"/>`);
    }
    if (fill === 'bitmap' && style['draw:fill-image']) {
      const id = 'c' + (++uid);
      let img;
      // A rotated picture arrives as a rotated 4-point outline: recover its true box and angle.
      const quad = pts.length >= 4 && pts.length <= 5 ? pts.slice(0, 4) : null;
      let ang = 0;
      if (quad) ang = Math.atan2(quad[1][1] - quad[0][1], quad[1][0] - quad[0][0]) * 180 / Math.PI;
      if (quad && Math.abs(ang) > 0.5 && Math.abs(Math.abs(ang) - 180) > 0.5 && Math.abs(Math.abs(ang) - 90) > 0.5) {
        const w = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]), h = Math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1]);
        const cx = (quad[0][0] + quad[2][0]) / 2, cy = (quad[0][1] + quad[2][1]) / 2;
        img = imageMarkup(style['librevenge:mime-type'], style['draw:fill-image'], cx - w / 2, cy - h / 2, w, h, ` transform="rotate(${r2(ang)} ${r2(cx)} ${r2(cy)})"`);
      } else img = imageMarkup(style['librevenge:mime-type'], style['draw:fill-image'], bx, by, bw, bh);
      out(`<clipPath id="${id}"><path d="${d}"/></clipPath><g clip-path="url(#${id})"${tint(style)}>${img}</g><path d="${d}" fill="none"${strokeAttrs()}/>`);
      return;
    }
    let f = ' fill="none"';
    if (fill === 'solid') f = ` fill="${style['draw:fill-color'] || '#ffffff'}"` + (style['draw:opacity'] && pct(style['draw:opacity']) < 1 ? ` fill-opacity="${pct(style['draw:opacity'])}"` : '');
    else if (fill === 'gradient') {
      const id = 'g' + (++uid), stops = style['svg:linearGradient'] || [];
      const ang = parseFloat(style['draw:angle'] || 0);
      let s = stops.map((t) => `<stop offset="${pct(t['svg:offset'], 0)}" stop-color="${t['svg:stop-color'] || '#fff'}" stop-opacity="${pct(t['svg:stop-opacity'])}"/>`).join('');
      if (!s) s = `<stop offset="0" stop-color="${style['draw:start-color'] || '#fff'}"/><stop offset="1" stop-color="${style['draw:end-color'] || '#000'}"/>`;
      out(`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1" gradientTransform="rotate(${r2(-ang)} 0.5 0.5)">${s}</linearGradient>`);
      f = ` fill="url(#${id})"`;
    }
    out(`<path d="${d}"${f}${rule}${strokeAttrs()}/>`);
  }

  function pathFrom(list) {
    let d = '', pts = [];
    for (const s of list) {
      const a = s['librevenge:path-action'];
      const x = U(s['svg:x']), y = U(s['svg:y']);
      if (a === 'M' || a === 'L') { d += `${a}${r2(x)} ${r2(y)}`; pts.push([x, y]); }
      else if (a === 'C') { d += `C${r2(U(s['svg:x1']))} ${r2(U(s['svg:y1']))} ${r2(U(s['svg:x2']))} ${r2(U(s['svg:y2']))} ${r2(x)} ${r2(y)}`; pts.push([U(s['svg:x1']), U(s['svg:y1'])], [U(s['svg:x2']), U(s['svg:y2'])], [x, y]); }
      else if (a === 'Q') { d += `Q${r2(U(s['svg:x1']))} ${r2(U(s['svg:y1']))} ${r2(x)} ${r2(y)}`; pts.push([U(s['svg:x1']), U(s['svg:y1'])], [x, y]); }
      else if (a === 'A') { d += `A${r2(U(s['svg:rx']))} ${r2(U(s['svg:ry']))} ${parseFloat(s['librevenge:rotate'] || 0)} ${+(s['librevenge:large-arc'] || 0) ? 1 : 0} ${+(s['librevenge:sweep'] || 0) ? 1 : 0} ${r2(x)} ${r2(y)}`; pts.push([x, y]); }
      else if (a === 'Z') d += 'Z';
    }
    return [d, pts];
  }

  // ---- text ----
  const spanStyle = (p) => {
    let s = '';
    if (p['fo:font-size']) s += `font-size:${r2(U(p['fo:font-size']))}px;`;
    if (p['style:font-name']) s += `font-family:${fontStack(p['style:font-name'])};`;
    if (p['fo:color']) s += `color:${p['fo:color']};`;
    if (p['fo:font-weight']) s += `font-weight:${p['fo:font-weight']};`;
    if (p['fo:font-style']) s += `font-style:${p['fo:font-style']};`;
    if (p['style:text-underline-type'] && p['style:text-underline-type'] !== 'none') s += 'text-decoration:underline;';
    if (p['style:text-line-through-type'] && p['style:text-line-through-type'] !== 'none') s += 'text-decoration:line-through;';
    if (p['fo:font-variant']) s += `font-variant:${p['fo:font-variant']};`;
    if (p['fo:text-transform']) s += `text-transform:${p['fo:text-transform']};`;
    if (p['fo:letter-spacing']) s += `letter-spacing:${r2(U(p['fo:letter-spacing']))}px;`;
    const pos = p['style:text-position'];
    if (pos) s += /^super|^[1-9]/.test(pos) ? 'vertical-align:super;font-size:60%;' : /^sub|^-/.test(pos) ? 'vertical-align:sub;font-size:60%;' : '';
    return s;
  };
  const paraStyle = (p) => {
    let s = '';
    const al = p['fo:text-align'];
    if (al) s += `text-align:${al === 'end' ? 'right' : al === 'start' ? 'left' : al};`;
    const lh = p['fo:line-height'];
    if (lh) s += String(lh).endsWith('%') ? `line-height:${r2(pct(lh) * 1.2)};` : `line-height:${r2(U(lh))}px;`;
    s += `margin:${r2(sane(U(p['fo:margin-top'])))}px ${r2(sane(U(p['fo:margin-right'])))}px ${r2(sane(U(p['fo:margin-bottom'])))}px ${r2(sane(U(p['fo:margin-left'])))}px;`;
    if (p['fo:text-indent']) s += `text-indent:${r2(sane(U(p['fo:text-indent'])))}px;`;
    return s;
  };
  let paraEmpty = true;
  const textEsc = (t) => esc(t.replace(/\r/g, '')).replace(/[\n\u000b]/g, '<br/>');

  function closeTextBox() {
    if (!tbox) return;
    const p = tbox.p, x = U(p['svg:x']), y = U(p['svg:y']), w = U(p['svg:width']), h = U(p['svg:height']);
    const va = p['draw:textarea-vertical-align'];
    const jc = va === 'middle' ? 'center' : va === 'bottom' ? 'flex-end' : 'flex-start';
    const pad = ['top', 'right', 'bottom', 'left'].map((k) => r2(U(p['fo:padding-' + k])) + 'px').join(' ');
    const cols = parseInt(p['fo:column-count'] || 1, 10);
    const colCss = cols > 1 ? `column-count:${cols};column-gap:${r2(U(p['fo:column-gap']))}px;column-fill:auto;height:100%;` : '';
    const rot = parseFloat(p['librevenge:rotate'] || 0);
    const tr = rot ? ` transform="rotate(${r2(-rot)} ${r2(x + w / 2)} ${r2(y + h / 2)})"` : '';
    out(`<foreignObject x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}"${tr} overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" class="pp-t" style="padding:${pad};justify-content:${jc};"><div style="${colCss}">${html}</div></div></foreignObject>`);
    stats.text++;
    tbox = null; html = null;
  }

  for (const e of events) {
    const t = e[0], p = e[1] || {};
    switch (t) {
      case 'startPage': cur = { w: U(p['svg:width']), h: U(p['svg:height']), parts: [], tints: {} }; pageNo++; break;
      case 'endPage': if (cur) { pages.push({ w: cur.w, h: cur.h, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(cur.w)} ${r2(cur.h)}" width="${r2(cur.w)}pt" height="${r2(cur.h)}pt"><rect width="100%" height="100%" fill="#fff"/>${cur.parts.join('')}</svg>` }); cur = null; } break;
      case 'startMasterPage': inMaster = true; break;
      case 'endMasterPage': inMaster = false; break;
      case 'setStyle': style = p; break;
      case 'drawPath': { const [d, pts] = pathFrom(p['svg:d'] || []); if (pts.length) emitShape(d, pts); break; }
      case 'drawPolygon': case 'drawPolyline': {
        const pts = (p['svg:points'] || []).map((q) => [U(q['svg:x']), U(q['svg:y'])]);
        if (pts.length) emitShape('M' + pts.map((q) => `${r2(q[0])} ${r2(q[1])}`).join('L') + (t === 'drawPolygon' ? 'Z' : ''), pts);
        break;
      }
      case 'drawRectangle': { const x = U(p['svg:x']), y = U(p['svg:y']), w = U(p['svg:width']), h = U(p['svg:height']); emitShape(`M${r2(x)} ${r2(y)}h${r2(w)}v${r2(h)}h${r2(-w)}Z`, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); break; }
      case 'drawEllipse': { const cx = U(p['svg:cx']), cy = U(p['svg:cy']), rx = U(p['svg:rx']), ry = U(p['svg:ry']); emitShape(`M${r2(cx - rx)} ${r2(cy)}a${r2(rx)} ${r2(ry)} 0 1 0 ${r2(2 * rx)} 0a${r2(rx)} ${r2(ry)} 0 1 0 ${r2(-2 * rx)} 0Z`, [[cx - rx, cy - ry], [cx + rx, cy + ry]]); break; }
      case 'drawGraphicObject': if (p['office:binary-data']) out(imageMarkup(p['librevenge:mime-type'] || 'image/png', p['office:binary-data'], U(p['svg:x']), U(p['svg:y']), U(p['svg:width']), U(p['svg:height']), tint(p))); break;
      case 'startTextObject': tbox = { p }; html = ''; break;
      case 'endTextObject': closeTextBox(); break;
      case 'startTableObject': {
        const cols = (p['librevenge:table-columns'] || []).map((c) => `<col style="width:${r2(U(c['style:column-width']))}px"/>`).join('');
        table = { p }; html = `<table class="pp-tb"><colgroup>${cols}</colgroup>`; break;
      }
      case 'openTableRow': html += `<tr style="height:${r2(U(p['librevenge:row-height'] || p['style:row-height']))}px">`; break;
      case 'closeTableRow': html += '</tr>'; break;
      case 'openTableCell': {
        let s = '';
        for (const side of ['left', 'right', 'top', 'bottom']) if (p['fo:border-' + side]) s += `border-${side}:${esc(p['fo:border-' + side]).replace(/([\d.]+)in/g, (m, n) => r2(n * 72) + 'px')};`;
        if (p['fo:background-color']) s += `background:${p['fo:background-color']};`;
        html += `<td colspan="${parseInt(p['table:number-columns-spanned'] || 1, 10)}" rowspan="${parseInt(p['table:number-rows-spanned'] || 1, 10)}" style="${s}">`; break;
      }
      case 'closeTableCell': html += '</td>'; break;
      case 'endTableObject': if (table) {
        const q = table.p, x = U(q['svg:x']), y = U(q['svg:y']), w = U(q['svg:width']), h = U(q['svg:height']);
        out(`<foreignObject x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" class="pp-t">${html}</table></div></foreignObject>`);
        table = null; html = null; stats.text++;
      } break;
      case 'openUnorderedListLevel': listStack.push({ bullet: p['text:bullet-char'] || '•' }); break;
      case 'openOrderedListLevel': listStack.push({ n: parseInt(p['text:start-value'] || 1, 10) - 1, suffix: p['style:num-suffix'] || '.' }); break;
      case 'closeUnorderedListLevel': case 'closeOrderedListLevel': listStack.pop(); break;
      case 'openParagraph': case 'openListElement':
        if (html != null) {
          html += `<p style="${paraStyle(p)}">`; paraEmpty = true;
          if (t === 'openListElement' && listStack.length) { const L = listStack[listStack.length - 1]; html += `<span>${esc(L.bullet != null ? L.bullet : (++L.n) + L.suffix)}&#160;</span>`; }
        } break;
      case 'closeParagraph': case 'closeListElement': if (html != null) html += (paraEmpty ? '<br/>' : '') + '</p>'; break;
      case 'openSpan': if (html != null) html += `<span style="${spanStyle(p)}">`; break;
      case 'closeSpan': if (html != null) html += '</span>'; break;
      case 'openLink': if (html != null) html += '<span class="pp-a">'; break;
      case 'closeLink': if (html != null) html += '</span>'; break;
      case 'insertText': if (html != null) { const s = textEsc(typeof e[1] === 'string' ? e[1] : ''); if (s) { html += s; paraEmpty = false; } } break;
      case 'insertTab': if (html != null) { html += '\t'; paraEmpty = false; } break;
      case 'insertSpace': if (html != null) { html += ' '; paraEmpty = false; } break;
      case 'insertLineBreak': if (html != null) { html += '<br/>'; } break;
      case 'insertField': if (html != null && /page-number/.test(p['librevenge:field-type'] || '')) { html += String(pageNo); paraEmpty = false; } break;
    }
  }
  return { pages, stats };
}

// CSS the text boxes rely on; injected into the page and into exported SVG files.
export const TEXT_CSS = `.pp-t{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;overflow:visible;font:10px 'Times New Roman',serif;color:#000;line-height:1.2;white-space:pre-wrap;overflow-wrap:break-word;tab-size:4}.pp-t p{margin:0}.pp-t .pp-a{text-decoration:underline}.pp-tb{border-collapse:collapse;table-layout:fixed;width:100%;height:100%}.pp-tb td{vertical-align:top;padding:1.5px 3px;overflow:hidden}`;
