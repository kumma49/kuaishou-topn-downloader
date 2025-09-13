// === src/main.js (SEARCH infaillible: SERP fallback + m-dot + UA mobile) ===
import { Actor, KeyValueStore, Dataset } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (arr) => [...new Set(arr)];

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

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

// sniffer réseau AVANT la nav (mp4/m3u8)
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
  const dom = await page.$$eval('video, source', (els) =>
    els.map((e) => e.src || e.getAttribute('src')).filter(Boolean),
  );
  const merged = unique([...dom, ...preBag]);
  return pickBestUrl(merged, acceptM3U8);
};

const autoScroll = async (page, steps = 6) => {
  for (let i = 0; i < steps; i++) {
    try { await page.mouse.wheel(0, 1400); } catch {}
    await sleep(600 + Math.floor(Math.random() * 500));
  }
};

const gotoRobust = async (page, url) => {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    log.warning(`goto domcontentloaded failed: ${e.message}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  }
};

// --- Fallback: Google SERP Actor -> retourne une liste d'URLs short-video/f ---
const serpSearch = async (keyword) => {
  if (!keyword) return [];
  const query = `site:kuaishou.com/short-video ${keyword}`;
  log.info(`SERP fallback query: ${query}`);
  const run = await Actor.call('apify/google-search-scraper', {
    queries: [query],
    resultsPerPage: 25,
    maxPagesPerQuery: 1,
    mobileResults: true,
    saveHtml: false,
  });
  const outDs = await Actor.openDataset(run.defaultDatasetId);
  const { items } = await outDs.getData({ limit: 200 });
  const urls = (items || [])
    .map((it) => it?.url)
    .filter((u) => typeof u === 'string' && /kuaishou\.com\/(short-video|f)\//i.test(u));
  return unique(urls);
};

await Actor.init();
const input = (await Actor.getInput()) || {};
const {
  keyword,
  urlList = [],
  limit = 3,
  useApifyProxy = true,
  saveBinary = true,
  acceptM3U8 = false,
  apifyProxyGroups,
  apifyProxyCountry,
} = input;

const proxyConfiguration = useApifyProxy
  ? await Actor.createProxyConfiguration({
      groups: Array.isArray(apifyProxyGroups) ? apifyProxyGroups : undefined,
      countryCode: apifyProxyCountry || undefined,
    })
  : new ProxyConfiguration();

const kv = await KeyValueStore.open();
const dataset = await Dataset.open();

// start URLs
const startRequests = [];
if (keyword) {
  startRequests.push({
    url: `https://www.kuaishou.com/search/video?keyword=${encodeURIComponent(keyword)}`,
    userData: { label: 'SEARCH', triedMDot: false },
  });
}
for (const u of urlList) {
  startRequests.push({ url: u, userData: { label: 'DETAIL', likes: 0, rank: null } });
}

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  headless: true,
  maxConcurrency: 2,
  requestHandlerTimeoutSecs: 150,
  useSessionPool: true,
  persistCookiesPerSession: true,
  retryOnBlocked: true,
  maxRequestRetries: 2,

  preNavigationHooks: [
    async ({ page }) => {
      // UA mobile forcé avant toute exécution
      try {
        await page.addInitScript((ua) => {
          Object.defineProperty(navigator, 'userAgent', { get: () => ua });
          Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
          Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
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
    const { label, triedMDot } = request.userData || {};
    log.info(`Open: [${label || 'DETAIL'}] ${request.url}`);

    const sniffer = attachSniffer(page);
    await gotoRobust(page, request.url);

    // si /f/... (lien partage), attends redirection /short-video/...
    try { await page.waitForURL(/short-video|video/i, { timeout: 15000 }); } catch {}

    const currentUrl = page.url();
    try { await page.waitForSelector('body', { timeout: 15000 }); } catch {}

    if (label === 'SEARCH') {
      // clique l'onglet "视频" si visible
      try {
        const tabVideo = page.locator('text=视频');
        if (await tabVideo.count()) {
          await tabVideo.first().click();
          await page.waitForTimeout(1200);
        }
      } catch {}

      // attend un sélecteur plausible
      const anySelector = [
        'a[href*="/short-video/"]',
        'div[data-e2e*="card"] a[href]',
        'section a[href*="/short-video/"]',
      ].join(',');
      try { await page.waitForSelector(anySelector, { timeout: 30000 }); } catch {}

      await autoScroll(page, 7);

      // 1) DOM
      let hrefs = await page.$$eval('a[href]', (as) => as.map(a => a.href));

      // 2) Fallback: regex HTML
      if (!hrefs || hrefs.length < 5) {
        try {
          const html = await page.content();
          const viaRegex = html.match(/https:\/\/www\.kuaishou\.com\/(?:short-video|f)\/[A-Za-z0-9_-]+/g) || [];
          hrefs = [...new Set([...(hrefs || []), ...viaRegex])];
        } catch {}
      }

      let videoLinks = unique((hrefs || []).filter(h => /\/short-video\/|\/f\//i.test(h)));

      // 3) Fallback m-dot si rien
      if (!videoLinks.length && !triedMDot && keyword) {
        const mUrl = `https://m.kuaishou.com/search/video?keyword=${encodeURIComponent(keyword)}`;
        log.info('SEARCH fallback → m.kuaishou.com');
        sniffer.detach();
        await enqueueLinks({ urls: [mUrl], userData: { label: 'SEARCH', triedMDot: true }, forefront: true });
        return;
      }

      // 4) Fallback SERP si toujours rien
      if (!videoLinks.length && keyword) {
        log.info('SEARCH fallback → Google SERP actor');
        const serpUrls = await serpSearch(keyword);
        videoLinks = serpUrls.slice(0, Math.max(1, Math.min(limit, 50)));
      }

      if (!videoLinks.length) {
        // debug visuel + HTML
        try {
          const buf = await page.screenshot({ fullPage: true });
          await kv.setValue(`DEBUG_SEARCH_${Date.now()}.png`, buf, { contentType: 'image/png' });
          const html = await page.content();
          await kv.setValue(`DEBUG_SEARCH_${Date.now()}.html`, html, { contentType: 'text/html; charset=utf-8' });
        } catch {}
        log.warning('SEARCH: aucun lien vidéo détecté après tous les fallbacks.');
        sniffer.detach();
        return;
      }

      // score approximatif
      const cardsScored = await page.evaluate((links) => {
        const around = (u) => {
          const a = [...document.querySelectorAll('a[href]')].find(x => x.href === u);
          if (!a) return '';
          const t = a.innerText || '';
          const p = a.closest('article,section,div')?.innerText || '';
          return `${t}\n${p}`.slice(0, 500);
        };
        return links.map(u => ({ url: u, context: around(u) }));
      }, videoLinks).catch(() => videoLinks.map(u => ({ url: u, context: '' })));

      for (const c of cardsScored) {
        const m = c.context.match(/([\d.,]+\s*(?:w|万)|\d+)/i);
        c.likeCount = m ? (() => {
          const m2 = m[0];
          const w = m2.match(/([\d.,]+)\s*(w|万)/i);
          if (w) return Math.round(parseFloat(w[1].replace(',', '.')) * 10000);
          const n = m2.replace(/[^\d]/g, '');
          return n ? parseInt(n, 10) : 0;
        })() : 0;
      }

      const top = cardsScored
        .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
        .slice(0, Math.max(1, Math.min(limit, 50)));

      let rank = 1;
      for (const t of top) {
        await enqueueLinks({
          urls: [t.url],
          userData: { label: 'DETAIL', likes: t.likeCount || 0, rank },
          forefront: true,
        });
        rank++;
      }
      sniffer.detach();
      return;
    }

    // DETAIL
    const videoUrl = await extractVideoUrl(page, { acceptM3U8, preBag: sniffer.bag });
    sniffer.detach();

    const title = await page.title().catch(() => '');
    const item = { pageUrl: currentUrl, title, videoUrl: videoUrl || null, likes: request.userData?.likes ?? null, rank: request.userData?.rank ?? null };
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

    return;
  },

  failedRequestHandler({ request }) {
    log.error(`Failed: ${request.url}`);
  },
});

await crawler.run(
  startRequests.length
    ? startRequests
    : [{ url: 'https://www.kuaishou.com/search/video?keyword=cute', userData: { label: 'SEARCH', triedMDot: false } }],
);

await Actor.exit();
