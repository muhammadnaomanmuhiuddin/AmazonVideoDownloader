const $ = (s) => document.querySelector(s);
const SEG_RE = /\/(seg|segment|chunk|frag|init)[^/]*$/i;
const HOST_OK = /(^|\.)(media-amazon\.com|cloudfront\.net|amazon\.[a-z.]+)$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let items = [];

// Runs inside the Amazon page: finds video URLs plus title / thumbnail / duration next to each one.
function scrapePage() {
  const unesc = (s) => s.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const html = unesc(document.documentElement.innerHTML);
  const urls = [...new Set(html.match(/https:\/\/[^"'\s<>\\)]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>\\)]*)?/gi) || [])];
  document.querySelectorAll('video').forEach((v) => {
    [v.currentSrc, v.src].forEach((u) => u && /^https?:/.test(u) && !urls.includes(u) && urls.push(u));
    v.querySelectorAll('source').forEach((s) => s.src && !urls.includes(s.src) && urls.push(s.src));
  });

  const decode = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
  const enclosing = (idx) => {
    let depth = 0, start = -1;
    for (let i = idx; i >= Math.max(0, idx - 4000); i--) {
      const c = html[i];
      if (c === '}') depth++;
      else if (c === '{') { if (depth === 0) { start = i; break; } depth--; }
    }
    if (start < 0) return '';
    depth = 0;
    for (let j = start; j < Math.min(html.length, start + 8000); j++) {
      if (html[j] === '{') depth++;
      else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
    }
    return '';
  };
  const pick = (obj, keys) => {
    for (const k of keys) {
      const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(obj);
      if (m && m[1]) return decode(m[1]);
    }
    return '';
  };

  const meta = {};
  for (const u of urls) {
    const idx = html.indexOf(u);
    let obj = idx >= 0 ? enclosing(idx) : '';
    if (!obj || obj.length > 3000) obj = idx >= 0 ? html.slice(Math.max(0, idx - 800), idx + 800) : '';
    meta[u] = {
      title: pick(obj, ['title', 'videoTitle', 'headline', 'name']),
      thumb: pick(obj, ['slateUrl', 'thumb', 'thumbUrl', 'thumbnail', 'poster', 'imageUrl']),
      duration: pick(obj, ['durationTimestamp', 'duration', 'videoDuration'])
    };
  }
  const domThumbs = [...document.querySelectorAll('#altImages li.videoThumbnail img, #altImages li[class*="video" i] img, .video-thumbnail img')]
    .map((i) => i.currentSrc || i.src).filter((s) => /^https?:/.test(s));
  const posters = [...document.querySelectorAll('video[poster]')].map((v) => v.poster);

  const title = (document.querySelector('#productTitle')?.textContent || document.title || 'amazon').trim();
  const asin = (location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || '';
  return { urls, meta, domThumbs: domThumbs.concat(posters), title, asin };
}

const clean = (s) => s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'amazon';
const kindOf = (u) => (/\.m3u8$/i.test(u.split('?')[0]) ? 'hls' : 'mp4');
const bigThumb = (u) => (u ? u.replace(/\._[^/]*?_\.(jpg|jpeg|png|webp)/i, '._SX200_.$1') : '');

// One entry per video: group HLS/MP4 variants of the same video id, keep page order.
function group(urls, meta) {
  const groups = new Map();
  for (const u of urls) {
    let url; try { url = new URL(u); } catch { continue; }
    if (!HOST_OK.test(url.hostname) || SEG_RE.test(url.pathname)) continue;
    const id = (UUID_RE.exec(url.pathname) || [])[0] || u.split('?')[0];
    if (!groups.has(id)) groups.set(id, { id, urls: [] });
    groups.get(id).urls.push(u);
  }
  return [...groups.values()].map((g) => {
    const hls = g.urls.filter((u) => kindOf(u) === 'hls').sort((a, b) => a.split('?')[0].length - b.split('?')[0].length)[0];
    const url = hls || g.urls[0];
    const m = g.urls.map((u) => meta[u]).find((x) => x && (x.title || x.thumb || x.duration)) || {};
    return { url, kind: kindOf(url), title: m.title || '', thumb: bigThumb(m.thumb), duration: m.duration || '' };
  });
}

function render() {
  const list = $('#list'); list.innerHTML = '';
  items.forEach((it, i) => {
    const el = document.createElement('div'); el.className = 'item'; el.id = `it${i}`;
    el.innerHTML = `<div class="row">
        <div class="thumb"><img alt=""><span class="play">▶</span><em class="dur"></em></div>
        <div class="name"><b class="t"></b><small class="m"></small></div>
        <button>Download</button>
      </div>
      <div class="bar"><i></i></div><div class="status"></div>`;
    const img = el.querySelector('img');
    if (it.thumb) { img.src = it.thumb; img.onerror = () => { img.remove(); }; } else img.remove();
    if (it.duration) { const d = el.querySelector('.dur'); d.textContent = it.duration; d.style.display = 'block'; }
    el.querySelector('.t').textContent = it.title || `Video ${i + 1}`;
    el.querySelector('.m').textContent = `Video ${i + 1} · ${it.kind === 'hls' ? 'stream → MP4' : 'MP4'}`;
    el.querySelector('button').onclick = () => start(i);
    list.appendChild(el);
  });
  $('#all').hidden = items.length < 2;
}

async function start(i) {
  const it = items[i], el = $(`#it${i}`);
  el.querySelector('button').disabled = true;
  el.querySelector('.bar').style.display = 'block';
  el.querySelector('.status').className = 'status';
  el.querySelector('.status').textContent = 'Starting…';
  const r = await chrome.runtime.sendMessage({ type: 'download', id: i, kind: it.kind, url: it.url, filename: it.filename });
  if (!r?.ok) fail(i, r?.error || 'Failed');
}
function fail(i, msg) {
  const el = $(`#it${i}`); if (!el) return;
  el.querySelector('.status').className = 'status err';
  el.querySelector('.status').textContent = msg;
  el.querySelector('button').disabled = false;
}

chrome.runtime.onMessage.addListener((m) => {
  const el = m.id !== undefined && $(`#it${m.id}`);
  if (!el) return;
  if (m.type === 'progress') { el.querySelector('.bar i').style.width = m.pct + '%'; el.querySelector('.status').textContent = m.stage; }
  if (m.type === 'saved') { el.querySelector('.bar i').style.width = '100%'; el.querySelector('.status').textContent = 'Saved to Downloads ✓'; }
  if (m.type === 'hls-error') fail(m.id, m.error);
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\/([^/]+\.)?amazon\.[a-z.]+\//i.test(tab.url)) {
    $('#sub').textContent = 'Open an Amazon product page first.'; $('#hint').hidden = true; return;
  }
  const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePage });
  const sniffed = await chrome.runtime.sendMessage({ type: 'get-sniffed', tabId: tab.id });
  const base = clean(page?.title || 'amazon') + (page?.asin ? `_${page.asin}` : '');
  $('#sub').textContent = page?.title || tab.title;

  items = group([...(page?.urls || []), ...(sniffed || [])], page?.meta || {});
  // Fallback thumbnails from the gallery strip / <video poster>, matched by order.
  let t = 0;
  items.forEach((it) => { if (!it.thumb && page?.domThumbs?.[t]) it.thumb = bigThumb(page.domThumbs[t]); t++; });
  items.forEach((it, i) => { it.filename = `${base}_video${i + 1}`; });

  if (!items.length) { $('#list').innerHTML = '<p>No videos found on this page yet.</p>'; return; }
  $('#sub').textContent = `${items.length} video${items.length > 1 ? 's' : ''} · ${page?.title || tab.title}`;
  render();
  $('#all').onclick = () => items.forEach((_, i) => start(i));
})();
