/*============================================================================
  Reading a binary FBX, and the PNG it carries.

  Only as much of either format as a voxel asset actually uses. The FBX side
  walks the node tree and decodes the property types Blender emits; the PNG
  side handles 8-bit non-interlaced images, which is what a palette atlas is.
============================================================================*/
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

/*---------------------------------- FBX ------------------------------------
  A node record is: end offset, property count, property-list length, a
  length-prefixed name, that many properties, then nested records until the
  end offset, closed by a null record. Files at 7500 and above widen the
  three leading offsets from 32 to 64 bits, which is the only version split
  that matters here.
============================================================================*/
export function parseFBX(buf){
  const version = buf.readUInt32LE(23);
  const wide = version >= 7500;
  let pos = 27;

  const readArray = (bytes, read) => {
    const len = buf.readUInt32LE(pos); pos += 4;
    const enc = buf.readUInt32LE(pos); pos += 4;
    const clen = buf.readUInt32LE(pos); pos += 4;
    let raw;
    if (enc === 1){ raw = zlib.inflateSync(buf.subarray(pos, pos + clen)); pos += clen; }
    else { raw = buf.subarray(pos, pos + len * bytes); pos += len * bytes; }
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = read(raw, i * bytes);
    return out;
  };
  const readProp = () => {
    const t = String.fromCharCode(buf.readUInt8(pos)); pos += 1;
    switch (t){
      case 'Y': { const v = buf.readInt16LE(pos);  pos += 2; return v; }
      case 'C': { const v = buf.readUInt8(pos);    pos += 1; return !!v; }
      case 'I': { const v = buf.readInt32LE(pos);  pos += 4; return v; }
      case 'F': { const v = buf.readFloatLE(pos);  pos += 4; return v; }
      case 'D': { const v = buf.readDoubleLE(pos); pos += 8; return v; }
      case 'L': { const v = Number(buf.readBigInt64LE(pos)); pos += 8; return v; }
      case 'f': return readArray(4, (b, o) => b.readFloatLE(o));
      case 'd': return readArray(8, (b, o) => b.readDoubleLE(o));
      case 'l': return readArray(8, (b, o) => Number(b.readBigInt64LE(o)));
      case 'i': return readArray(4, (b, o) => b.readInt32LE(o));
      case 'b': return readArray(1, (b, o) => b.readUInt8(o));
      case 'S': case 'R': {
        const len = buf.readUInt32LE(pos); pos += 4;
        const s = buf.subarray(pos, pos + len); pos += len;
        return t === 'S' ? s.toString('binary') : s;
      }
      default: throw new Error('FBX: unknown property type "' + t + '" at ' + pos);
    }
  };
  const readNode = () => {
    let end, nProps;
    if (wide){
      end = Number(buf.readBigUInt64LE(pos)); pos += 8;
      nProps = Number(buf.readBigUInt64LE(pos)); pos += 8;
      pos += 8;                                    // property-list length
    } else {
      end = buf.readUInt32LE(pos); pos += 4;
      nProps = buf.readUInt32LE(pos); pos += 4;
      pos += 4;
    }
    const nameLen = buf.readUInt8(pos); pos += 1;
    const name = buf.toString('utf8', pos, pos + nameLen); pos += nameLen;
    if (end === 0) return null;                     // the closing null record
    const props = [];
    for (let i = 0; i < nProps; i++) props.push(readProp());
    const children = [];
    while (pos < end){ const c = readNode(); if (!c) break; children.push(c); }
    pos = end;
    return { name, props, children };
  };

  const root = { name: '', props: [], children: [] };
  while (pos < buf.length - 16){
    const n = readNode(); if (!n) break;
    root.children.push(n);
  }
  return { version, root };
}
export const kids  = (n, name) => n.children.filter(c => c.name === name);
export const kid   = (n, name) => n.children.find(c => c.name === name);
export const readFBX = path => parseFBX(readFileSync(path));

/*---------------------------------- PNG ------------------------------------
  Palette atlases come out of the exporter as 8-bit indexed images, so this
  covers 8-bit greyscale, RGB, RGBA and palette, non-interlaced, and hands
  back straight RGBA.
============================================================================*/
export function decodePNG(buf){
  let p = 8, w = 0, h = 0, depth = 0, ct = 0, plte = null, trns = null;
  const idat = [];
  while (p < buf.length){
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR'){
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9];
      if (d[12]) throw new Error('PNG: interlaced images are not supported');
    }
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error('PNG: bit depth ' + depth + ' is not supported');
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const img = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++){
    const filter = raw[q++];
    const row = raw.subarray(q, q + stride); q += stride;
    const cur = img.subarray(y * stride, (y + 1) * stride);
    const prev = y ? img.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++){
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4){
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++){
    let r, g, b, a = 255;
    if (ct === 3){ const ix = img[i]; r = plte[ix*3]; g = plte[ix*3+1]; b = plte[ix*3+2];
                   if (trns && ix < trns.length) a = trns[ix]; }
    else if (ct === 0){ r = g = b = img[i]; }
    else if (ct === 4){ r = g = b = img[i*2]; a = img[i*2+1]; }
    else if (ct === 2){ r = img[i*3]; g = img[i*3+1]; b = img[i*3+2]; }
    else { r = img[i*4]; g = img[i*4+1]; b = img[i*4+2]; a = img[i*4+3]; }
    rgba[i*4] = r; rgba[i*4+1] = g; rgba[i*4+2] = b; rgba[i*4+3] = a;
  }
  return { w, h, data: rgba };
}
