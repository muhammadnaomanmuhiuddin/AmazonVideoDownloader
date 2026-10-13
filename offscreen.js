// Downloads HLS playlists, joins segments, converts MPEG-TS to MP4 (via mux.js).
const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'hls') run(msg);
  if (msg.type === 'revoke') URL.revokeObjectURL(msg.blobUrl);
});

async function fetchRetry(url, as = 'arrayBuffer', tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r[as === 'text' ? 'text' : 'arrayBuffer']();
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw new Error(`Failed to fetch ${url.split('?')[0].split('/').pop()}: ${err.message}`);
}

async function loadPlaylist(url, depth = 0) {
  const text = await fetchRetry(url, 'text');
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  if (text.includes('#EXT-X-STREAM-INF')) {
    if (depth > 2) throw new Error('Playlist nesting too deep');
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bw = Number((/BANDWIDTH=(\d+)/.exec(lines[i]) || [])[1] || 0);
        const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
        if (uri) variants.push({ bw, url: new URL(uri, url).href });
      }
    }
    if (!variants.length) throw new Error('No video variants found in playlist');
    variants.sort((a, b) => b.bw - a.bw);
    return loadPlaylist(variants[0].url, depth + 1); // best quality
  }

  let map = null;
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/i.test(line)) {
      throw new Error('This stream is encrypted (DRM/AES) and can\'t be downloaded.');
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) map = new URL(m[1], url).href;
    } else if (line && !line.startsWith('#')) {
      segments.push(new URL(line, url).href);
    }
  }
  if (!segments.length) throw new Error('Playlist has no segments');
  return { segments, map };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

function transmux(buffers) {
  return new Promise((resolve, reject) => {
    const t = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
    const parts = [];
    let first = true;
    t.on('data', (s) => {
      if (first) {
        const b = new Uint8Array(s.initSegment.byteLength + s.data.byteLength);
        b.set(s.initSegment, 0); b.set(s.data, s.initSegment.byteLength);
        parts.push(b); first = false;
      } else parts.push(s.data);
    });
    t.on('done', () => (parts.length ? resolve(parts) : reject(new Error('Empty transmux result'))));
    try { buffers.forEach((b) => t.push(new Uint8Array(b))); t.flush(); } catch (e) { reject(e); }
  });
}

async function run({ id, url, filename }) {
  try {
    send({ type: 'progress', id, pct: 1, stage: 'Reading playlist…' });
    const { segments, map } = await loadPlaylist(url);
    const initBuf = map ? await fetchRetry(map) : null;
    const buffers = new Array(segments.length);
    let done = 0;
    await pool(segments, 6, async (u, i) => {
      buffers[i] = await fetchRetry(u);
      done++;
      send({ type: 'progress', id, pct: 2 + Math.round((done / segments.length) * 88), stage: `Downloading ${done}/${segments.length}` });
    });

    send({ type: 'progress', id, pct: 92, stage: 'Assembling…' });
    let blob, ext = '.mp4';
    const toArr = (b) => new Uint8Array(b);
    let frag = null;
    if (initBuf) {
      frag = [toArr(initBuf), ...buffers.map(toArr)]; // already fragmented MP4
    } else {
      try { frag = await transmux(buffers); } catch (e) { frag = null; }
    }
    if (frag) {
      try {
        blob = self.defragMp4(frag); // flat MP4: correct duration + seekable, no re-encode
      } catch (e) {
        blob = new Blob(frag, { type: 'video/mp4' }); // fallback: fragmented MP4
      }
    } else {
      blob = new Blob(buffers, { type: 'video/mp2t' }); // fallback: raw TS (plays in VLC)
      ext = '.ts';
    }
    send({ type: 'hls-done', id, blobUrl: URL.createObjectURL(blob), filename: filename + ext });
  } catch (e) {
    send({ type: 'hls-error', id, error: e.message });
  }
}
