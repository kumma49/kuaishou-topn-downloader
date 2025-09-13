// === src/main.js ===
// Mode fiable: traite des liens Kuaishou (DETAIL) + recherche optionnelle si proxy résidentiel activé.

import { Actor, KeyValueStore, Dataset } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee';

// -------------------- Helpers --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (arr) => [...new Set(arr)];

// UA mobile Android + WeChat (souvent mieux côté CN)
const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.45';

const parseCount = (txt = '') => {
  const w = txt.match(/([\d.,]+)\s*(w|万)/i);
  if (w) return Math.round(parseFloat(w[1].replace(',', '.')) * 10000);
  const n = txt.replace(/[^\d]/g, '');
  return n ? parseInt(n, 10) : 0;
};

const pickBestUrl = (arr, acceptM3U8) => {
  if (!arr || !arr.length) return null;
  const mp4 = arr.find((u) => /\.mp4(\?|$)/i.test(u));
  if (mp4) return mp4;
  if (acceptM3U8) return arr.find((u) => /\.m3u8(\?|$)/i.test(u)) || null;
  return null;
};

// Sniffer réseau AVANT nav (capte mp4/m3u8)
const attachSniffer = (page) => {
  const bag = [];
  const seen = new Set();
  const listener = (resp) => {
    try {
      const u = resp.url();
      if (/\.(mp4|m3u8)(\?|$)/i.test(u) || (/play|video|stream/i.test(u) && u.startsWith('http'))) {
        if (!seen.has(u)) { seen.add(u); bag.push(u); }
      }
    } catch {}
  };
  page.on('response', listener);
  const detach = () => page.off('response', listener);
  return { bag, detach };
};

const extractVideoUrl = async (page, { acceptM3U8, preBag = [] }) => {
  // 1) DOM direct
  const dom = await page.$$eval('video, source', (els) =>
    els.map((e) => e.src || e.getAttribute('src')).filter(Boolean),
  );
  // 2) regex HTML fallback
  let htmlUrls = [];
  try {
    const html = await page.content();
    const m = html.match(/https?:\/\/[^"' ]+\.(?:mp4|m3u8)(?:\?[^"' ]*)?/gi);
    if (m) htmlUrls = m;
  } catch {}
  const merged = unique([...(dom || []), ...(preBag || []), ...htmlUrls]);
  return pickBestUrl(merged, acceptM3U8);
};

const gotoRobust = async (page, url) => {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    log.warning(`goto domcontentloaded failed: ${e.message}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  }
};

// KV (set après init)
let kv;
const saveDebug = async (page, prefix = 'DEBUG') => {
  try {
    const png = await page.screenshot({ fullPage: true });
    const html = await page.content();
    const ts = Date.now();
    await kv.setValue(`${prefix}_${ts}.png`, png, { contentType: 'image/png' });
    await kv.setValue(`${prefix}_${ts}.html`, html, { contentType: 'text/html; charset=utf-8' });
    log.info(`${prefix}: artefacts sauvegardés dans KV (png + html)`);
  } catch (e) {
    log.warning(`${prefix}: échec sauvegarde debug -> ${e?.message || e}`);
  }
};

// --- SERP (optionnel) ---
const trySerpAgg = async (keyword, limit) => {
  const take = (dsId) => dsId ? Actor.openDataset(dsId).then(ds => ds.getData({ limit: 200 })) : null;

  const tasks = [];
  // Google
  tasks.push(Actor.call('apify/google-search-scraper', {
    queries: `site:kuaishou.com/short-video ${keyword}`, // string (pas tableau)
    resultsPerPage: 25, maxPagesPerQuery: 1, mobileResults: true, saveHtml: false,
  }).then(run => run?.defaultDatasetId || run?.output?.defaultDatasetId || run?.datasetId).then(take));
  // Bing
  tasks.push(Actor.call('apify/bing-search-scraper', {
    query: `site:kuaishou.com/short-video ${keyword}`,
    maxPagesPerQuery: 1, countryCode: 'HK', useMobileVersion: true,
  }).then(run => run?.defaultDatasetId || run?.output?.defaultDatasetId || run?.datasetId).then(take));
  // DuckDuckGo
  tasks.push(Actor.call('apify/duckduckgo-search-scraper', {
    queries: `site:kuaishou.com/short-video ${keyword}`,
    maxResults: 25, region: 'wt-wt', safeSearch: 'moderate',
  }).then(run => run?.defaultDatasetId || run?.output?.defaultDatasetId || run?.datasetId).then(take));

  const settled = await Promise.allSettled(tasks);
  const urls = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value && s.value.items) {
      for (const it of s.value.items) {
        const u = it?.url;
        if (typeof u === 'string' && /kuaishou\.com\/(short-video|f)\//i.test(u)) urls.push(u);
      }
    }
  }
  return unique(urls).slice(0, Math.max(1, Math.min(limit || 3, 50)));
};

// -------------------- Main --------------------
await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  // MODE A (fiable): fournis des /f/... ou /short-video/... ici
  urlList = [],
  // MODE B (optionnel): recherche (nécessite proxy résidentiel HK/CN)
  keyword,
  limit = 3,
  useApifyProxy = true,
  saveBinary = true,
  acceptM3U8 = false,
  useSerpFallback = false,            // <— n’active la SERP que si tu es sûr d’avoir du résidentiel
  apifyProxyGroups,                   // ex: ["RESIDENTIAL"]
  apifyProxyCountry,                  // ex: "HK" ou "CN"
} = input;

const proxyConfiguration = useApifyProxy
  ? await Actor.createProxyConfiguration({
      groups: Array.isArray(apifyProxyGroups) ? apifyProxyGroups : undefined,
      countryCode: apifyProxyCountry || undefined,
    })
  : new ProxyConfiguration();

kv = await KeyValueStore.open();
const dataset = await Dataset.open();

// Seeds
const startRequests = [];
for (const u of urlList) {
  startRequests.push({ url: u, userData: { label: 'DETAIL', likes: 0, rank: null } });
}
if (keyword && useSerpFallback) {
  // on pousse seulement SERP (économise des échecs sur /search/)
  startRequests.push({ url: 'about:blank', userData: { label: 'SERP', keyword } });
}

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  headless: true,
  maxConcurrency: 2,
  requestHandlerTimeoutSecs: 150,
  navigationTimeoutSecs: 90,
  useSessionPool: true,
  persistCookiesPerSession: true,
  retryOnBlocked: true,
  maxRequestRetries: 2,

  preNavigationHooks: [
    async ({ page }) => {
      // Spoofs simples anti-bot + UA
      try {
        await page.addInitScript((ua) => {
          Object.defineProperty(navigator, 'userAgent', { get: () => ua });
          Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8' });
          Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
          Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          // Plugins/mimeTypes fake
          Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
          Object.defineProperty(navigator, 'mimeTypes', { get: () => [1] });
        }, UA_MOBILE);
      } catch {}
      try { await page.setViewportSize({ width: 390, height: 844 }); } catch {}
      try {
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Upgrade-Insecure-Requests': '1',
          'Referer': 'https://www.kuaishou.com/',
        });
      } catch {}
      await sleep(250 + Math.floor(Math.random() * 400));
    },
  ],

  async requestHandler({ request, page, enqueueLinks, log }) {
    const { label, keyword: kw } = request.userData || {};
    log.info(`Open: [${label || 'DETAIL'}] ${request.url}`);

    if (label === 'SERP') {
      try {
        const serpUrls = await trySerpAgg(kw, limit);
        if (serpUrls.length) {
          await enqueueLinks({
            urls: serpUrls,
            userData: { label: 'DETAIL', likes: 0, rank: null },
            forefront: true,
          });
          log.info(`SERP: ${serpUrls.length} liens ajoutés.`);
        } else {
          log.warning('SERP: aucun lien trouvé.');
        }
      } catch (e) {
        log.warning(`SERP error: ${e?.message || e}`);
      }
      return;
    }

    // Sniffer AVANT d’interagir + navigation robuste
    const sniffer = attachSniffer(page);
    await gotoRobust(page, request.url);

    // /f/... → attends redirection /short-video/...
    try { await page.waitForURL(/short-video|video/i, { timeout: 15000 }); } catch {}
    try { await page.waitForSelector('body', { timeout: 15000 }); } catch {}

    // DETAIL : extraire l’URL vidéo + sauvegarder MP4
    const videoUrl = await extractVideoUrl(page, { acceptM3U8, preBag: sniffer.bag });
    if (!videoUrl) await saveDebug(page, 'DEBUG_DETAIL');
    sniffer.detach();

    const title = await page.title().catch(() => '');
    const item = {
      pageUrl: page.url(),
      title,
      videoUrl: videoUrl || null,
      likes: request.userData?.likes ?? null,
      rank: request.userData?.rank ?? null,
    };
    await dataset.pushData(item);

    if (saveBinary && videoUrl && /\.mp4(\?|$)/i.test(videoUrl)) {
      try {
        const res = await fetch(videoUrl);
        const buf = Buffer.from(await res.arrayBuffer());
        const key = `VIDEO_${Date.now()}${item.rank ? `_r${item.rank}` : ''}.mp4`;
        await kv.setValue(key, buf, { contentType: 'video/mp4' });
        await Actor.setValue(`META_${key.replace('.mp4', '')}.json`, { ...item, kvKey: key });
        log.info(`Saved MP4 to KV: ${key}`);
      } catch (e) {
        log.warning(`Download failed: ${e?.message || e}`);
      }
    }
  },

  failedRequestHandler({ request }) {
    log.error(`Failed: ${request.url}`);
  },
});

// Lance
await crawler.run(
  startRequests.length
    ? startRequests
    : [{ url: 'about:blank', userData: { label: 'SERP', keyword: '搞笑 狗' } }],
);

await Actor.exit();
