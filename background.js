// Service worker: sniffs media requests per tab, starts downloads.
const MEDIA_RE = /\.(m3u8|mp4)$/i;
const SEG_RE = /\/(seg|segment|chunk|frag|init)[^/]*$/i; // skip HLS segment noise

let queue = Promise.resolve();
const key = (tabId) => `tab:${tabId}`;

function addSniffed(tabId, url) {
  queue = queue.then(async () => {
    const k = key(tabId);
    const data = await chrome.storage.session.get(k);
    const list = data[k] || [];
    if (!list.includes(url)) {
      list.push(url);
      await chrome.storage.session.set({ [k]: list.slice(-50) });
    }
  }).catch(() => {});
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const path = d.url.split('?')[0];
    if (!MEDIA_RE.test(path) || SEG_RE.test(path)) return;
    addSniffed(d.tabId, d.url);
  },
  { urls: ['*://*.media-amazon.com/*', '*://*.cloudfront.net/*'] }
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) chrome.storage.session.remove(key(tabId));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Assemble HLS video segments into a downloadable file'
  });
}

const blobByDownload = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && ['complete', 'interrupted'].includes(delta.state.current) && blobByDownload.has(delta.id)) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl: blobByDownload.get(delta.id) }).catch(() => {});
    blobByDownload.delete(delta.id);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-sniffed') {
    chrome.storage.session.get(key(msg.tabId)).then((d) => sendResponse(d[key(msg.tabId)] || []));
    return true;
  }
  if (msg.type === 'download') {
    (async () => {
      if (msg.kind === 'mp4') {
        await chrome.downloads.download({ url: msg.url, filename: `${msg.filename}.mp4`, conflictAction: 'uniquify' });
        chrome.runtime.sendMessage({ type: 'saved', id: msg.id }).catch(() => {});
      } else {
        await ensureOffscreen();
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls', id: msg.id, url: msg.url, filename: msg.filename });
      }
    })().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'hls-done') {
    chrome.downloads
      .download({ url: msg.blobUrl, filename: msg.filename, conflictAction: 'uniquify' })
      .then((downloadId) => {
        blobByDownload.set(downloadId, msg.blobUrl);
        chrome.runtime.sendMessage({ type: 'saved', id: msg.id }).catch(() => {});
      })
      .catch((e) => chrome.runtime.sendMessage({ type: 'hls-error', id: msg.id, error: e.message }).catch(() => {}));
  }
});
