// Converts a fragmented MP4 (init + moof/mdat...) into a regular "faststart" MP4
// with full duration and a sample table, so players show the right length and can seek.
(function (root) {
  const u32 = (d, o) => d.getUint32(o);
  const tag = (d, o) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));

  function boxes(buf, start, end) {
    const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(d, o), hdr = 8;
      const type = tag(d, o + 4);
      if (size === 1) { size = Number(d.getBigUint64(o + 8)); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type, start: o, hdr, end: o + size, body: o + hdr });
      o += size;
    }
    return out;
  }
  const find = (buf, b, type) => boxes(buf, b.body, b.end).find((x) => x.type === type);
  const findAll = (buf, b, type) => boxes(buf, b.body, b.end).filter((x) => x.type === type);

  // ---- writers ----
  function concat(arrs) {
    let n = 0; arrs.forEach((a) => (n += a.length));
    const r = new Uint8Array(n); let o = 0;
    arrs.forEach((a) => { r.set(a, o); o += a.length; });
    return r;
  }
  function box(type, ...children) {
    const body = concat(children);
    const r = new Uint8Array(8 + body.length);
    const d = new DataView(r.buffer);
    d.setUint32(0, r.length);
    for (let i = 0; i < 4; i++) r[4 + i] = type.charCodeAt(i);
    r.set(body, 8);
    return r;
  }
  function fullbox(type, version, flags, ...children) {
    const h = new Uint8Array(4); h[0] = version; h[1] = (flags >> 16) & 255; h[2] = (flags >> 8) & 255; h[3] = flags & 255;
    return box(type, h, ...children);
  }
  function words(arr) {
    const r = new Uint8Array(arr.length * 4); const d = new DataView(r.buffer);
    arr.forEach((v, i) => d.setUint32(i * 4, v >>> 0));
    return r;
  }
  const i32words = (arr) => { const r = new Uint8Array(arr.length * 4); const d = new DataView(r.buffer); arr.forEach((v, i) => d.setInt32(i * 4, v)); return r; };

  function parseInit(buf) {
    const moov = boxes(buf, 0, buf.length).find((b) => b.type === 'moov');
    if (!moov) throw new Error('no moov');
    const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const mvhd = find(buf, moov, 'mvhd');
    const mvVer = buf[mvhd.body];
    const movieTimescale = u32(d, mvhd.body + (mvVer ? 20 : 12));
    const tracks = {};
    findAll(buf, moov, 'trak').forEach((trak) => {
      const tkhd = find(buf, trak, 'tkhd');
      const tv = buf[tkhd.body];
      const id = u32(d, tkhd.body + (tv ? 20 : 12));
      const mdia = find(buf, trak, 'mdia');
      const mdhd = find(buf, mdia, 'mdhd');
      const mv = buf[mdhd.body];
      const timescale = u32(d, mdhd.body + (mv ? 20 : 12));
      const hdlr = find(buf, mdia, 'hdlr');
      const handler = tag(d, hdlr.body + 8);
      const minf = find(buf, mdia, 'minf');
      const stbl = find(buf, minf, 'stbl');
      const stsd = find(buf, stbl, 'stsd');
      tracks[id] = { id, trak, tkhd, tv, mdia, mdhd, mv, hdlr, minf, stbl, stsd, timescale, handler, samples: [], chunks: [], firstDts: null };
    });
    return { moov, mvhd, mvVer, movieTimescale, tracks };
  }

  function parseFragments(buf, tracks) {
    const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const top = boxes(buf, 0, buf.length);
    // trex defaults
    const trexDefaults = {};
    const moov = top.find((b) => b.type === 'moov');
    const mvex = moov && find(buf, moov, 'mvex');
    if (mvex) findAll(buf, mvex, 'trex').forEach((t) => {
      trexDefaults[u32(d, t.body + 4)] = { dur: u32(d, t.body + 12), size: u32(d, t.body + 16), flags: u32(d, t.body + 20) };
    });
    top.filter((b) => b.type === 'moof').forEach((moof) => {
      findAll(buf, moof, 'traf').forEach((traf) => {
        const tfhd = find(buf, traf, 'tfhd');
        const tfFlags = u32(d, tfhd.body) & 0xffffff;
        const id = u32(d, tfhd.body + 4);
        const tr = tracks[id]; if (!tr) return;
        let p = tfhd.body + 8;
        let baseOff = moof.start;
        if (tfFlags & 1) { baseOff = Number(d.getBigUint64(p)); p += 8; }
        if (tfFlags & 2) p += 4;
        const def = Object.assign({ dur: 0, size: 0, flags: 0 }, trexDefaults[id]);
        if (tfFlags & 8) { def.dur = u32(d, p); p += 4; }
        if (tfFlags & 0x10) { def.size = u32(d, p); p += 4; }
        if (tfFlags & 0x20) { def.flags = u32(d, p); p += 4; }
        const tfdt = find(buf, traf, 'tfdt');
        let dts = 0;
        if (tfdt) dts = buf[tfdt.body] ? Number(d.getBigUint64(tfdt.body + 4)) : u32(d, tfdt.body + 4);
        else if (tr.samples.length) { const l = tr.samples[tr.samples.length - 1]; dts = l.dts + l.dur; }
        if (tr.firstDts === null) tr.firstDts = dts;
        findAll(buf, traf, 'trun').forEach((trun) => {
          const ver = buf[trun.body];
          const fl = u32(d, trun.body) & 0xffffff;
          const n = u32(d, trun.body + 4);
          let q = trun.body + 8;
          let dataOff = 0;
          if (fl & 1) { dataOff = d.getInt32(q); q += 4; }
          let firstFlags = null;
          if (fl & 4) { firstFlags = u32(d, q); q += 4; }
          let pos = baseOff + dataOff;
          const chunk = { first: tr.samples.length, count: n, data: [] };
          for (let i = 0; i < n; i++) {
            const s = { dur: def.dur, size: def.size, flags: def.flags, cto: 0, dts, pos };
            if (fl & 0x100) { s.dur = u32(d, q); q += 4; }
            if (fl & 0x200) { s.size = u32(d, q); q += 4; }
            if (fl & 0x400) { s.flags = u32(d, q); q += 4; } else if (i === 0 && firstFlags !== null) s.flags = firstFlags;
            if (fl & 0x800) { s.cto = ver ? d.getInt32(q) : u32(d, q); q += 4; }
            s.sync = !(s.flags & 0x10000) && !(s.flags & 0x1000000); // not non-sync, not depends-on-other
            dts += s.dur; pos += s.size;
            tr.samples.push(s);
          }
          tr.chunks.push(chunk);
        });
      });
    });
  }

  function buildStbl(tr, chunkOffsets) {
    const S = tr.samples;
    // stts
    const stts = []; 
    for (const s of S) { const l = stts[stts.length - 1]; if (l && l[1] === s.dur) l[0]++; else stts.push([1, s.dur]); }
    // stsc (one chunk per fragment run)
    const stsc = []; 
    tr.chunks.forEach((c, i) => { const l = stsc[stsc.length - 1]; if (!l || l[1] !== c.count) stsc.push([i + 1, c.count, 1]); });
    const parts = [tr.stsd.raw,
      fullbox('stts', 0, 0, words([stts.length, ...stts.flat()])),
      fullbox('stsc', 0, 0, words([stsc.length, ...stsc.flat()])),
      fullbox('stsz', 0, 0, words([0, S.length, ...S.map((s) => s.size)])),
      fullbox('stco', 0, 0, words([chunkOffsets.length, ...chunkOffsets]))];
    if (tr.handler === 'vide') {
      const sync = []; S.forEach((s, i) => { if (s.sync) sync.push(i + 1); });
      if (sync.length && sync.length < S.length) parts.push(fullbox('stss', 0, 0, words([sync.length, ...sync])));
    }
    if (S.some((s) => s.cto)) {
      const neg = S.some((s) => s.cto < 0 || s.cto > 0x7fffffff);
      const ct = []; for (const s of S) { const l = ct[ct.length - 1]; if (l && l[1] === s.cto) l[0]++; else ct.push([1, s.cto]); }
      parts.push(fullbox('ctts', neg ? 1 : 0, 0, i32words([ct.length, ...ct.flat()])));
    }
    return box('stbl', ...parts);
  }

  function buildMoov(buf, init, order, offsets, baseOffset) {
    const { tracks, movieTimescale } = init;
    const mv = movieTimescale;
    let movieDur = 0;
    const traks = order.map((id) => {
      const tr = tracks[id];
      const dur = tr.samples.reduce((a, s) => a + s.dur, 0);
      tr.dur = dur;
      const delay = Math.round((tr.firstDts / tr.timescale - init.minSec) * mv); // movie units
      const tdur = Math.round((dur / tr.timescale) * mv) + delay;
      movieDur = Math.max(movieDur, tdur);
      // tkhd: copy as version 0 with patched duration
      const tk = buf.slice(tr.tkhd.start, tr.tkhd.end);
      const tkd = new DataView(tk.buffer);
      if (tr.tv === 0) tkd.setUint32(8 + 20, tdur); else { tkd.setUint32(8 + 28, 0); tkd.setUint32(8 + 32, tdur); }
      tkd.setUint32(8, (tk[8] << 24 | 3)); // version 0 + flags enabled|in_movie
      // mdhd: patched duration
      const mh = buf.slice(tr.mdhd.start, tr.mdhd.end);
      const mhd = new DataView(mh.buffer);
      if (tr.mv === 0) mhd.setUint32(8 + 16, dur); else { mhd.setUint32(8 + 24, 0); mhd.setUint32(8 + 28, dur); }
      const minfKids = boxes(buf, tr.minf.body, tr.minf.end).filter((b) => b.type !== 'stbl').map((b) => buf.slice(b.start, b.end));
      tr.stsd.raw = buf.slice(tr.stsd.start, tr.stsd.end);
      const stbl = buildStbl(tr, offsets[id]);
      const mdia = box('mdia', mh, buf.slice(tr.hdlr.start, tr.hdlr.end), box('minf', ...minfKids, stbl));
      const kids = [tk];
      if (delay > 0) kids.push(box('edts', fullbox('elst', 0, 0, words([2, delay, 0xffffffff, 0x00010000, Math.round((dur / tr.timescale) * mv), 0, 0x00010000]))));
      kids.push(mdia);
      return box('trak', ...kids);
    });
    const mh = buf.slice(init.mvhd.start, init.mvhd.end);
    const mhd = new DataView(mh.buffer);
    if (init.mvVer === 0) mhd.setUint32(8 + 16, movieDur); else { mhd.setUint32(8 + 24, 0); mhd.setUint32(8 + 28, movieDur); }
    return box('moov', mh, ...traks);
  }

  function defrag(parts) {
    const buf = concat(parts);
    const init = parseInit(buf);
    parseFragments(buf, init.tracks);
    const order = Object.keys(init.tracks).map(Number).filter((id) => init.tracks[id].samples.length);
    if (!order.length) throw new Error('no samples');
    init.minSec = Math.min(...order.map((id) => init.tracks[id].firstDts / init.tracks[id].timescale));
    const _build = (offsets) => buildMoov(buf, init, order, offsets);
    const ftyp = box('ftyp', new Uint8Array([105, 115, 111, 109]), words([512]), new Uint8Array([105, 115, 111, 109, 105, 115, 111, 50, 97, 118, 99, 49, 109, 112, 52, 49]));
    // interleave chunks by time
    const chunkList = [];
    order.forEach((id) => init.tracks[id].chunks.forEach((c, i) => {
      const tr = init.tracks[id];
      chunkList.push({ id, idx: i, c, t: tr.samples[c.first].dts / tr.timescale });
    }));
    chunkList.sort((a, b) => a.t - b.t || a.id - b.id);
    const dummy = {}; order.forEach((id) => (dummy[id] = new Array(init.tracks[id].chunks.length).fill(0)));
    const moovSize = _build(dummy).length;
    let off = ftyp.length + moovSize + 8; // +8 mdat header
    const offsets = {}; order.forEach((id) => (offsets[id] = new Array(init.tracks[id].chunks.length)));
    const data = [];
    chunkList.forEach(({ id, idx, c }) => {
      const tr = init.tracks[id];
      offsets[id][idx] = off;
      for (let i = c.first; i < c.first + c.count; i++) {
        const s = tr.samples[i];
        data.push(buf.subarray(s.pos, s.pos + s.size)); off += s.size;
      }
    });
    const moov = _build(offsets);
    if (moov.length !== moovSize) throw new Error('moov size changed');
    const total = data.reduce((a, b) => a + b.length, 0);
    const mdatHdr = new Uint8Array(8); new DataView(mdatHdr.buffer).setUint32(0, total + 8); mdatHdr.set([109, 100, 97, 116], 4);
    return new Blob([ftyp, moov, mdatHdr, ...data], { type: 'video/mp4' });
  }

  root.defragMp4 = defrag;
})(typeof self !== 'undefined' ? self : globalThis);
