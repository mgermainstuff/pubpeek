// Minimal Windows Metafile (WMF) to SVG converter for clip art and border art inside Publisher files.
// Returns inner SVG markup drawn in a 1000x1000 box (caller stretches it), or null if nothing drawable.

const rgb = (dv, o) => '#' + [dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2)].map((v) => v.toString(16).padStart(2, '0')).join('');

function b64(bytes) {
  if (typeof btoa === 'function') { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  return Buffer.from(bytes).toString('base64');
}

function dibToDataUrl(bytes) { // device-independent bitmap -> BMP file data URL
  if (bytes.length < 40) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hdr = dv.getUint32(0, true);
  if (hdr < 12 || hdr > 124) return null;
  let bpp, clr = 0, comp = 0;
  if (hdr === 12) bpp = dv.getUint16(10, true); else { bpp = dv.getUint16(14, true); comp = dv.getUint32(16, true); clr = dv.getUint32(32, true); }
  let pal = bpp <= 8 ? (clr || (1 << bpp)) * (hdr === 12 ? 3 : 4) : 0;
  if (comp === 3 && hdr === 40) pal += 12;
  const off = 14 + hdr + pal;
  const out = new Uint8Array(14 + bytes.length), o = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; o.setUint32(2, out.length, true); o.setUint32(10, off, true);
  out.set(bytes, 14);
  return 'data:image/bmp;base64,' + b64(out);
}

export function wmfToSvg(bytes) {
  try { return convert(bytes); } catch (e) { return null; }
}

function convert(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0, placeable = null;
  if (dv.byteLength < 18) return null;
  if (dv.getUint32(0, true) === 0x9ac6cdd7) { placeable = [dv.getInt16(6, true), dv.getInt16(8, true), dv.getInt16(10, true), dv.getInt16(12, true)]; pos = 22; }
  const start = pos + dv.getUint16(pos + 2, true) * 2;

  // pass 1: find the logical window, or fall back to the bounding box of everything drawn
  let org = null, ext = null, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const seen = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (let p = start; p + 6 <= dv.byteLength;) {
    const size = dv.getUint32(p, true) * 2, fn = dv.getUint16(p + 4, true), a = p + 6;
    if (size < 6 || fn === 0) break;
    if (fn === 0x020b && !org) org = [dv.getInt16(a + 2, true), dv.getInt16(a, true)];
    else if (fn === 0x020c && !ext) ext = [dv.getInt16(a + 2, true), dv.getInt16(a, true)];
    else if (fn === 0x0324 || fn === 0x0325) { const n = dv.getInt16(a, true); for (let i = 0; i < n && a + 6 + i * 4 <= dv.byteLength; i++) seen(dv.getInt16(a + 2 + i * 4, true), dv.getInt16(a + 4 + i * 4, true)); }
    else if (fn === 0x041b || fn === 0x0418) { seen(dv.getInt16(a + 6, true), dv.getInt16(a + 4, true)); seen(dv.getInt16(a + 2, true), dv.getInt16(a, true)); }
    p += size;
  }
  if (!ext || !ext[0] || !ext[1]) {
    if (placeable && placeable[2] !== placeable[0] && placeable[3] !== placeable[1]) { org = [placeable[0], placeable[1]]; ext = [placeable[2] - placeable[0], placeable[3] - placeable[1]]; }
    else if (isFinite(minX) && maxX > minX && maxY > minY) { org = [minX, minY]; ext = [maxX - minX, maxY - minY]; }
    else return null;
  }
  if (!org) org = [0, 0];

  // pass 2: draw
  let st = { org: org.slice(), ext: ext.slice(), pen: { style: 0, w: 0, color: '#000000' }, brush: { style: 0, color: '#ffffff' }, font: { h: 12, face: 'Arial', bold: false, italic: false }, text: '#000000', fillRule: 'evenodd', cur: [0, 0] };
  const stack = [], objs = [], els = [];
  const X = (x) => Math.round((x - st.org[0]) * 10000 / st.ext[0]) / 10;
  const Y = (y) => Math.round((y - st.org[1]) * 10000 / st.ext[1]) / 10;
  const sx = () => Math.abs(1000 / st.ext[0]);
  const paint = (fill) => {
    let s = fill && st.brush.style !== 1 ? ` fill="${st.brush.color}" fill-rule="${st.fillRule}"` : ' fill="none"';
    if (st.pen.style === 5) s += ' stroke="none"';
    else { const w = st.pen.w * sx(); s += w > 2 ? ` stroke="${st.pen.color}" stroke-width="${Math.round(w * 10) / 10}"` : ` stroke="${st.pen.color}" stroke-width="0.6" vector-effect="non-scaling-stroke"`; }
    return s + ' stroke-linejoin="round"';
  };
  const addObj = (o) => { let i = 0; while (objs[i]) i++; objs[i] = o; };
  const poly = (a, n) => { let d = ''; for (let i = 0; i < n; i++) d += (i ? 'L' : 'M') + X(dv.getInt16(a + i * 4, true)) + ' ' + Y(dv.getInt16(a + 2 + i * 4, true)); return d; };
  const bitmap = (dibOff, end, dx, dy, dw, dh) => {
    if (dibOff >= end) return;
    const url = dibToDataUrl(bytes.subarray(dibOff, end));
    if (!url) return;
    const x0 = X(dx), y0 = Y(dy), x1 = X(dx + dw), y1 = Y(dy + dh);
    els.push(`<image x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" preserveAspectRatio="none" href="${url}"/>`);
  };

  for (let p = start; p + 6 <= dv.byteLength;) {
    const size = dv.getUint32(p, true) * 2, fn = dv.getUint16(p + 4, true), a = p + 6, end = Math.min(p + size, dv.byteLength);
    if (size < 6 || fn === 0) break;
    const i16 = (k) => dv.getInt16(a + k * 2, true);
    switch (fn) {
      case 0x020b: st.org = [i16(1), i16(0)]; break;
      case 0x020c: if (i16(1) && i16(0)) st.ext = [i16(1), i16(0)]; break;
      case 0x02fa: addObj({ t: 'pen', style: dv.getUint16(a, true) & 0xf, w: Math.abs(i16(1)), color: rgb(dv, a + 6) }); break;
      case 0x02fc: addObj({ t: 'brush', style: dv.getUint16(a, true), color: rgb(dv, a + 2) }); break;
      case 0x02fb: { let face = ''; for (let k = a + 18; k < end && dv.getUint8(k); k++) face += String.fromCharCode(dv.getUint8(k)); addObj({ t: 'font', h: Math.abs(i16(0)) || 12, bold: i16(4) >= 600, italic: !!dv.getUint8(a + 10), face: face || 'Arial' }); break; }
      case 0x00f7: case 0x0142: case 0x01f9: case 0x06ff: addObj({ t: fn === 0x0142 || fn === 0x01f9 ? 'brush' : 'other', style: 0, color: '#c0c0c0' }); break;
      case 0x012d: { const o = objs[dv.getUint16(a, true)]; if (o) { if (o.t === 'pen') st.pen = o; else if (o.t === 'brush') st.brush = o; else if (o.t === 'font') st.font = o; } break; }
      case 0x01f0: objs[dv.getUint16(a, true)] = null; break;
      case 0x0106: st.fillRule = dv.getUint16(a, true) === 2 ? 'nonzero' : 'evenodd'; break;
      case 0x0209: st.text = rgb(dv, a); break;
      case 0x001e: stack.push(JSON.parse(JSON.stringify(st))); break;
      case 0x0127: if (stack.length) st = stack.pop(); break;
      case 0x0214: st.cur = [i16(1), i16(0)]; break;
      case 0x0213: els.push(`<path d="M${X(st.cur[0])} ${Y(st.cur[1])}L${X(i16(1))} ${Y(i16(0))}"${paint(false)}/>`); st.cur = [i16(1), i16(0)]; break;
      case 0x0324: { const n = i16(0); if (n > 1 && a + 2 + n * 4 <= end) els.push(`<path d="${poly(a + 2, n)}Z"${paint(true)}/>`); break; }
      case 0x0325: { const n = i16(0); if (n > 1 && a + 2 + n * 4 <= end) els.push(`<path d="${poly(a + 2, n)}"${paint(false)}/>`); break; }
      case 0x0538: {
        const np = dv.getUint16(a, true); let q = a + 2 + np * 2, d = '';
        for (let k = 0; k < np; k++) { const n = dv.getUint16(a + 2 + k * 2, true); if (q + n * 4 > end) break; d += poly(q, n) + 'Z'; q += n * 4; }
        if (d) els.push(`<path d="${d}"${paint(true)}/>`); break;
      }
      case 0x041b: { const x0 = X(i16(3)), y0 = Y(i16(2)), x1 = X(i16(1)), y1 = Y(i16(0)); els.push(`<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}"${paint(true)}/>`); break; }
      case 0x061c: { const x0 = X(i16(5)), y0 = Y(i16(4)), x1 = X(i16(3)), y1 = Y(i16(2)); els.push(`<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" rx="${Math.abs(i16(1)) * sx() / 2}"${paint(true)}/>`); break; }
      case 0x0418: { const x0 = X(i16(3)), y0 = Y(i16(2)), x1 = X(i16(1)), y1 = Y(i16(0)); els.push(`<ellipse cx="${(x0 + x1) / 2}" cy="${(y0 + y1) / 2}" rx="${Math.abs(x1 - x0) / 2}" ry="${Math.abs(y1 - y0) / 2}"${paint(true)}/>`); break; }
      case 0x0817: case 0x081a: case 0x0830: { // arc, pie, chord: counter-clockwise from start to end on the ellipse in the box
        const x0 = X(i16(7)), y0 = Y(i16(6)), x1 = X(i16(5)), y1 = Y(i16(4));
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
        if (!rx || !ry) break;
        const a0 = Math.atan2((Y(i16(2)) - cy) / ry, (X(i16(3)) - cx) / rx), a1 = Math.atan2((Y(i16(0)) - cy) / ry, (X(i16(1)) - cx) / rx);
        let sweep = a0 - a1; if (sweep <= 0) sweep += Math.PI * 2;
        const p0 = [cx + rx * Math.cos(a0), cy + ry * Math.sin(a0)], p1 = [cx + rx * Math.cos(a1), cy + ry * Math.sin(a1)];
        let d = `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}A${rx} ${ry} 0 ${sweep > Math.PI ? 1 : 0} 0 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
        if (fn === 0x081a) d += `L${cx} ${cy}Z`; else if (fn === 0x0830) d += 'Z';
        els.push(`<path d="${d}"${paint(fn !== 0x0817)}/>`); break;
      }
      case 0x0a32: case 0x0521: {
        let x, y, n, so;
        if (fn === 0x0a32) { y = i16(0); x = i16(1); n = i16(2); so = a + 8 + ((dv.getUint16(a + 6, true) & 6) ? 8 : 0); }
        else { n = i16(0); so = a + 2; const q = so + n + (n & 1); y = dv.getInt16(q, true); x = dv.getInt16(q + 2, true); }
        if (n > 0 && so + n <= end) { let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(dv.getUint8(so + k)); els.push(`<text x="${X(x)}" y="${Y(y)}" dominant-baseline="hanging" font-family="${st.font.face.replace(/[^\w ]/g, '')}, sans-serif" font-size="${Math.round(st.font.h * Math.abs(1000 / st.ext[1]))}" fill="${st.text}"${st.font.bold ? ' font-weight="bold"' : ''}${st.font.italic ? ' font-style="italic"' : ''}>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`); }
        break;
      }
      case 0x0f43: bitmap(a + 22, end, i16(10), i16(9), i16(8), i16(7)); break; // STRETCHDIB
      case 0x0b41: bitmap(a + 20, end, i16(9), i16(8), i16(7), i16(6)); break; // DIBSTRETCHBLT
      case 0x0940: bitmap(a + 16, end, i16(7), i16(6), i16(5), i16(4)); break; // DIBBITBLT
    }
    p += size;
  }
  return els.length ? els.join('') : null;
}
