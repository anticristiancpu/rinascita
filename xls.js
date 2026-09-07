/* ============================================================
   Lettore .xls (BIFF8 dentro contenitore OLE2/CFB) — JS puro.
   Serve a importare l'export della bilancia INSMART Health.
   readXls(ArrayBuffer) -> [ [cella,...], ... ]  (primo foglio)
   ============================================================ */
(function(global){
"use strict";

function readXls(buf){
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  const SIG = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];
  if(u8.length < 512) throw new Error("File troppo piccolo o vuoto.");
  for(let i=0;i<8;i++) if(u8[i]!==SIG[i]){
    if(u8[0]===0x50 && u8[1]===0x4B) throw new Error("Questo è un .xlsx. Dalla bilancia esporta in formato .xls (Excel 97-2003).");
    throw new Error("Non sembra un file Excel .xls.");
  }

  /* ---------- contenitore OLE2 ---------- */
  const ssz    = 1 << dv.getUint16(30,true);
  const mssz   = 1 << dv.getUint16(32,true);
  const nFat   = dv.getUint32(44,true);
  const dirSt  = dv.getUint32(48,true);
  const cutoff = dv.getUint32(56,true);
  const miniSt = dv.getUint32(60,true);
  let   difSt  = dv.getUint32(68,true);
  const nDif   = dv.getUint32(72,true);
  const FREE = 0xFFFFFFFC;
  const secOff = s => (s+1)*ssz;

  const fatSecs = [];
  for(let i=0;i<109;i++){
    const v = dv.getUint32(76+i*4,true);
    if(v >= FREE) break;
    fatSecs.push(v);
    if(fatSecs.length >= nFat) break;
  }
  let g = 0;
  while(difSt < FREE && fatSecs.length < nFat && g++ < 100000){
    const b = secOff(difSt), cnt = (ssz/4)-1;
    for(let i=0;i<cnt;i++){ const v = dv.getUint32(b+i*4,true); if(v < FREE) fatSecs.push(v); }
    difSt = dv.getUint32(b+cnt*4,true);
  }

  const per = ssz/4;
  const fat = new Uint32Array(fatSecs.length*per);
  fatSecs.forEach((s,i)=>{ const b = secOff(s); for(let j=0;j<per;j++) fat[i*per+j] = dv.getUint32(b+j*4,true); });

  function chain(start, table){
    const out = []; let s = start, k = 0;
    while(s < FREE && k++ < 1e6){ out.push(s); s = table[s]; if(s === undefined) break; }
    return out;
  }

  const miniSecs = chain(miniSt, fat);
  const miniFat = new Uint32Array(miniSecs.length*per);
  miniSecs.forEach((s,i)=>{ const b = secOff(s); for(let j=0;j<per;j++) miniFat[i*per+j] = dv.getUint32(b+j*4,true); });

  function joinSectors(secs, size){
    const out = new Uint8Array(secs.length*ssz);
    secs.forEach((s,i)=> out.set(u8.subarray(secOff(s), secOff(s)+ssz), i*ssz));
    return size ? out.subarray(0, Math.min(size, out.length)) : out;
  }

  /* ---------- directory ---------- */
  const dirBuf = joinSectors(chain(dirSt, fat));
  const ddv = new DataView(dirBuf.buffer, dirBuf.byteOffset, dirBuf.byteLength);
  const nEnt = Math.floor(dirBuf.length/128);
  let root = null, wbEnt = null;
  for(let i=0;i<nEnt;i++){
    const o = i*128, nl = ddv.getUint16(o+64,true), type = dirBuf[o+66];
    if(type !== 2 && type !== 5) continue;
    let nm = "";
    for(let j=0;j+1 < Math.max(0,nl-2); j+=2) nm += String.fromCharCode(ddv.getUint16(o+j,true));
    const e = {name:nm, type, start:ddv.getUint32(o+116,true), size:ddv.getUint32(o+120,true)};
    if(type === 5) root = e;
    else if(nm === "Workbook" || nm === "Book") wbEnt = e;
  }
  if(!wbEnt) throw new Error("Flusso 'Workbook' non trovato nel file.");

  const miniStream = root ? joinSectors(chain(root.start, fat), root.size) : new Uint8Array(0);

  let wbBytes;
  if(wbEnt.size < cutoff){
    const secs = chain(wbEnt.start, miniFat);
    wbBytes = new Uint8Array(secs.length*mssz);
    secs.forEach((s,i)=> wbBytes.set(miniStream.subarray(s*mssz, s*mssz+mssz), i*mssz));
    wbBytes = wbBytes.subarray(0, wbEnt.size);
  }else{
    wbBytes = joinSectors(chain(wbEnt.start, fat), wbEnt.size);
  }

  /* ---------- record BIFF ---------- */
  const wdv = new DataView(wbBytes.buffer, wbBytes.byteOffset, wbBytes.byteLength);
  const recs = [];
  for(let p=0; p+4 <= wbBytes.length; ){
    const t = wdv.getUint16(p,true), len = wdv.getUint16(p+2,true);
    if(p+4+len > wbBytes.length) break;
    recs.push({t, off:p+4, len});
    p += 4 + len;
  }

  const R = {BOF:0x0809, EOF:0x000A, SST:0x00FC, CONTINUE:0x003C, LABELSST:0x00FD,
             LABEL:0x0204, NUMBER:0x0203, RK:0x027E, MULRK:0x00BD, FORMULA:0x0006,
             STRING:0x0207, BOOLERR:0x0205, RSTRING:0x00D6};

  /* --- SST: stringhe condivise, possono continuare su più record --- */
  let sst = [];
  const iSst = recs.findIndex(r => r.t === R.SST);
  if(iSst >= 0){
    const blocks = [wbBytes.subarray(recs[iSst].off, recs[iSst].off+recs[iSst].len)];
    for(let i=iSst+1; i<recs.length && recs[i].t === R.CONTINUE; i++)
      blocks.push(wbBytes.subarray(recs[i].off, recs[i].off+recs[i].len));
    sst = parseSst(blocks);
  }

  function parseSst(blocks){
    let bi = 0, p = 0;
    const cur = () => blocks[bi];
    function need(n){                       // porta il cursore su un blocco che ha n byte
      while(bi < blocks.length && p + n > cur().length){ bi++; p = 0; }
      return bi < blocks.length;
    }
    const u8r  = () => { need(1); return cur()[p++]; };
    const u16r = () => { need(2); const v = cur()[p] | (cur()[p+1]<<8); p += 2; return v; };
    const u32r = () => { const a = u16r(), b = u16r(); return a + b*65536; };
    function skip(n){
      while(n > 0 && bi < blocks.length){
        const av = cur().length - p;
        if(n < av){ p += n; n = 0; } else { n -= av; bi++; p = 0; }
      }
    }
    u32r();                                  // totale occorrenze
    const nUniq = u32r();
    const out = [];
    for(let s=0; s<nUniq; s++){
      if(bi >= blocks.length) break;
      const cch = u16r();
      let flags = u8r();
      let high = flags & 1, ext = flags & 4, rich = flags & 8;
      const nRun = rich ? u16r() : 0;
      const cbExt = ext ? u32r() : 0;
      let str = "";
      for(let i=0;i<cch;i++){
        if(p >= cur().length){                 // il testo prosegue nel record CONTINUE
          bi++; p = 0;
          if(bi >= blocks.length) break;
          high = cur()[p++] & 1;               // nuovo byte di codifica
        }
        if(high){ str += String.fromCharCode(cur()[p] | (cur()[p+1]<<8)); p += 2; }
        else    { str += String.fromCharCode(cur()[p]); p += 1; }
      }
      skip(nRun*4); skip(cbExt);
      out.push(str);
    }
    return out;
  }

  function rkVal(rk){
    let v;
    if(rk & 2) v = (rk|0) >> 2;
    else {
      const b = new ArrayBuffer(8), d = new DataView(b);
      d.setUint32(0, 0, true); d.setUint32(4, rk & 0xFFFFFFFC, true);
      v = d.getFloat64(0, true);
    }
    return (rk & 1) ? v/100 : v;
  }
  function uniStr(off){                        // XLUnicodeString breve (LABEL)
    const cch = wdv.getUint16(off,true), flags = wbBytes[off+2];
    let s = "", o = off+3;
    for(let i=0;i<cch;i++){
      if(flags & 1){ s += String.fromCharCode(wdv.getUint16(o,true)); o += 2; }
      else { s += String.fromCharCode(wbBytes[o]); o += 1; }
    }
    return s;
  }

  /* --- celle: prendo il primo foglio con dati --- */
  const sheets = [];
  let cells = null;
  const put = (r,c,v) => {
    if(!cells) return;
    if(!cells[r]) cells[r] = [];
    cells[r][c] = v;
  };

  for(const rec of recs){
    if(rec.t === R.BOF){
      const dt = rec.len >= 4 ? wdv.getUint16(rec.off+2,true) : 0;
      if(dt === 0x0010){ cells = []; sheets.push(cells); }
      continue;
    }
    if(!cells) continue;
    const o = rec.off;
    switch(rec.t){
      case R.LABELSST: {
        const r = wdv.getUint16(o,true), c = wdv.getUint16(o+2,true), i = wdv.getUint32(o+6,true);
        put(r, c, sst[i] !== undefined ? sst[i] : ""); break;
      }
      case R.LABEL: case R.RSTRING: {
        const r = wdv.getUint16(o,true), c = wdv.getUint16(o+2,true);
        put(r, c, uniStr(o+6)); break;
      }
      case R.NUMBER: case R.FORMULA: {
        const r = wdv.getUint16(o,true), c = wdv.getUint16(o+2,true);
        const v = wdv.getFloat64(o+6,true);
        if(rec.t === R.NUMBER || !isNaN(v)) put(r, c, v);
        break;
      }
      case R.RK: {
        const r = wdv.getUint16(o,true), c = wdv.getUint16(o+2,true);
        put(r, c, rkVal(wdv.getUint32(o+6,true))); break;
      }
      case R.MULRK: {
        const r = wdv.getUint16(o,true), c1 = wdv.getUint16(o+2,true);
        const n = Math.floor((rec.len - 6)/6);
        for(let i=0;i<n;i++) put(r, c1+i, rkVal(wdv.getUint32(o+4+i*6+2,true)));
        break;
      }
    }
  }

  const sheet = sheets.find(s => s && s.length > 1) || sheets[0];
  if(!sheet || !sheet.length) throw new Error("Nessun dato leggibile nel foglio.");

  const w = sheet.reduce((m,r)=> Math.max(m, r ? r.length : 0), 0);
  return sheet.map(r => { const row = r || []; const out = new Array(w);
    for(let i=0;i<w;i++) out[i] = row[i] === undefined ? "" : row[i];
    return out; });
}

global.readXls = readXls;
})(window);
