// === src/main.js ===
// Kuaishou Top-N downloader : search robuste (www + m-dot + SERP Google/Bing/DDG) + capture MP4 dans KV

import { Actor, KeyValueStore, Dataset } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee';

// -------------------- Helpers --------------------
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
  // 2) JSON/HTML heuristics (parfois l’URL apparaît dans le HTML)
  let htmlUrls = [];
  try {
    const html = await page.content();
    const m = html.match(/https?:\/\/[^"' ]+\.(?:mp4|m3u8)(?:\?[^"' ]*)?/gi);
    if (m) htmlUrls = m;
  } catch {}
  const merged = unique([...(dom || []), ...(preBag || []), ...htmlUrls]);
  return pickBestUrl(merged, acceptM3U8);
};

// Scroll + récolte incrémentale des <a href>
const incrementalScrollAndHarvest = async (page, steps = 7) => {
  const harvested = new Set();
  for (let i = 0; i < steps; i++) {
    await page.evaluate(async () => {
      window.scrollBy(0, 1400);
      await new Promise(r => setTimeout(r, 650));
    });
    await sleep(550 + Math.floor(Math.random() * 450));
    try {
      const hrefs = await page.$$eval('a[href]', (as) => as.map(a => a.href));
      hrefs.forEach(h => harvested.add(h));
    } catch {}
  }
  return [...harvested];
};

// Nav robuste
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

// ------ SERP providers (Google, Bing, DuckDuckGo) ------
const serpSearchGoogle = async (keyword) => {
  const query = `site:kuaishou.com/short-video ${keyword}`;
  log.info(`SERP(Google): ${query}`);
  const run = await Actor.call('apify/google-search-scraper', {
    queries: query, // IMPORTANT: string, pas tableau
    resultsPerPage: 25,
    maxPagesPerQuery: 1,
    mobileResults: true,
    saveHtml: false,
  });
  const dsId = run?.defaultDatasetId || run?.output?.defaultDatasetId || run?.datasetId;
  if (!dsId) return [];
  const ds = await Actor.openDataset(dsId);
  const { items } = await ds.getData({ limit: 200 });
  return (items || []).map(i => i?.url).filter(u => /kuaishou\.com\/(short-video|f)\//i.test(u));
};

const serpSearchBing = async (keyword) => {
  const query = `site:kuaishou.com/short-video ${keyword}`;
  log.info(`SERP(Bing): ${query}`);
  const run = await Actor.call('apify/bing-search-scraper', {
    query, // ce scraper prend "query"
    maxPagesPerQuery: 1,
    countryCode: 'HK',
    useMobileVersion: true,
  });
  const dsId = run?.defaultDatasetId || run?.output?.defaultDatasetId || run?.datasetId;
  if (!dsId) return [];
  const ds = await Actor.openDataset(dsId);
  const { items } = await ds.getData({ limit: 200 });
  return (items || []).map(i => i?.url).filter(u => /kuaishou\.com\/(short-video|f)\//i.test(u));
};

const serpSearchDDG = async (keyword) => {
  const query = `site:kuaishou.com/short-video ${keyword}`;
  log.info(`SERP(DDG): ${query}`);
  const run = await Actor.call('apify/duckduckgo-search-scraper', {
    queries: query, // ce scraper accepte string aussi
    maxResults: 25,
    region: 'wt-wt',
    safeSearch: 'moderate',
  });
  const dsId = run?.defaultDatasetId || run?.output?.defaultDatasetId || run?.datasetId;
  if (!dsId) return [];
  const ds = await Actor.openDataset(dsId);
  const { items } = await ds.getData({ limit: 200 });
  return (items || []).map(i => i?.url).filter(u => /kuaishou\.com\/(short-video|f)\//i.test(u));
};

const serpSearch = async (keyword) => {
  // On agrège les trois, on dédoublonne
  const [g, b, d] = await Promise.allSettled([
    serpSearchGoogle(keyword),
    serpSearchBing(keyword),
    serpSearchDDG(keyword),
  ]);
  const urls = [
    ...(g.status === 'fulfilled' ? g.value : []),
    ...(b.status === 'fulfilled' ? b.value : []),
    ...(d.status === 'fulfilled' ? d.value : []),
  ];
  return unique(urls);
};

// -------------------- Main --------------------
await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  keyword,
  urlList = [],
  limit = 3,
  useApifyProxy = true,
  saveBinary = true,
  acceptM3U8 = false,
  // si tu veux exposer ces champs dans l’UI, ajoute-les dans input_schema.json
  apifyProxyGroups,
  apifyProxyCountry,
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
if (keyword) {
  startRequests.push({
    url: `https://www.kuaishou.com/search/video?keyword=${encodeURIComponent(keyword)}`,
    userData: { label: 'SEARCH', source: 'www', keyword, triedMDot: false },
  });
  startRequests.push({
    url: `https://m.kuaishou.com/search/video?keyword=${encodeURIComponent(keyword)}`,
    userData: { label: 'SEARCH', source: 'm', keyword, triedMDot: true },
  });
  // SERP synthétique (pas de navigation)
  startRequests.push({
    url: 'about:blank',
    userData: { label: 'SERP', keyword },
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
  navigationTimeoutSecs: 90,
  useSessionPool: true,
  persistCookiesPerSession: true,
  retryOnBlocked: true,
  maxRequestRetries: 2,

  preNavigationHooks: [
    async ({ page }) => {
      // Forcer UA mobile + signaux "mobile"
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
    const { label, keyword: kw } = request.userData || {};
    log.info(`Open: [${label || 'DETAIL'}] ${request.url}`);

    // Cas spécial: SERP synthétique
    if (label === 'SERP') {
      try {
        const serpUrls = await serpSearch(kw);
        const pick = serpUrls.slice(0, Math.max(1, Math.min(limit || 3, 50)));
        if (pick.length) {
          await enqueueLinks({
            urls: pick,
            userData: { label: 'DETAIL', likes: 0, rank: null },
            forefront: true,
          });
          log.info(`SERP: ${pick.length} liens ajoutés depuis SERP (agg).`);
        } else {
          log.warning('SERP: aucun lien trouvé.');
        }
      } catch (e) {
        log.warning(`SERP error: ${e?.message || e}`);
      }
      return;
    }

    // Sniffer AVANT d’interagir
    const sniffer = attachSniffer(page);
    await gotoRobust(page, request.url);

    // /f/... → attends redirection /short-video/...
    try { await page.waitForURL(/short-video|video/i, { timeout: 15000 }); } catch {}
    try { await page.waitForSelector('body', { timeout: 15000 }); } catch {}

    if (label === 'SEARCH') {
      // Onglet "视频"
      try {
        const tabVideo = page.locator('text=视频');
        if (await tabVideo.count()) {
          await tabVideo.first().click();
          await page.waitForTimeout(1200);
        }
      } catch {}

      // Attente de sélecteurs plausibles
      const anySelector = [
        'a[href*="/short-video/"]',
        'div[data-e2e*="card"] a[href]',
        'section a[href*="/short-video/"]',
      ].join(',');
      try { await page.waitForSelector(anySelector, { timeout: 30000 }); } catch {}

      // Scroll + harvest
      let hrefs = await incrementalScrollAndHarvest(page, 7);

      // Fallback regex HTML
      if (!hrefs || hrefs.length < 5) {
        try {
          const html = await page.content();
          const viaRegex = html.match(/https:\/\/www\.kuaishou\.com\/(?:short-video|f)\/[A-Za-z0-9_-]+/g) || [];
          hrefs = [...new Set([...(hrefs || []), ...viaRegex])];
        } catch {}
      }

      const videoLinks = unique((hrefs || []).filter(h => /\/short-video\/|\/f\//i.test(h)));

      if (!videoLinks.length) {
        await saveDebug(page, 'DEBUG_SEARCH');
        log.warning('SEARCH: aucun lien vidéo détecté (voir DEBUG_SEARCH_* dans KV).');
        sniffer.detach();
        return;
      }

      // Score approximatif (likes) pour Top-N
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
        .slice(0, Math.max(1, Math.min(limit || 3, 50)));

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

    // DETAIL : extraire l’URL vidéo + sauvegarder MP4
    const videoUrl = await extractVideoUrl(page, { acceptM3U8, preBag: sniffer.bag });
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
    : [{ url: 'https://www.kuaishou.com/search/video?keyword=cute', userData: { label: 'SEARCH', source: 'www', keyword: 'cute', triedMDot: false } }],
);

await Actor.exit();
