// === src/main.js (Kuaishou crawler + fallback Google CSE) ===
import { Actor, KeyValueStore, Dataset } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee';
import fetch from 'node-fetch';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (arr) => [...new Set(arr)];

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

// -------- Google SERP Fallback (Custom Search API) ----------
async function serpGoogleBatch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
    log.warning("Google API key ou CSE ID manquant → configure GOOGLE_API_KEY et GOOGLE_CSE_ID !");
    return [];
  }
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&cx=${GOOGLE_CSE_ID}&key=${GOOGLE_API_KEY}&num=10`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const urls = (data.items || [])
      .map((it) => it?.link)
      .filter((u) => typeof u === 'string' && /kuaishou\.com\/(short-video|f)\//i.test(u));
    return unique(urls);
  } catch (e) {
    log.error(`SERP Google API error: ${e.message}`);
    return [];
  }
}

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

const extractVideoUrl = async (page, { preBag = [] }) => {
  const dom = await page.$$eval('video, source', (els) =>
    els.map((e) => e.src || e.getAttribute('src')).filter(Boolean),
  );
  return unique([...dom, ...preBag])[0] || null;
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
  } catch {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  }
};

await Actor.init();
const input = (await Actor.getInput()) || {};
const {
  keyword,
  urlList = [],
  limit = 3,
  useApifyProxy = true,
} = input;

const proxyConfiguration = useApifyProxy
  ? await Actor.createProxyConfiguration()
  : new ProxyConfiguration();

const kv = await KeyValueStore.open();
const dataset = await Dataset.open();

// start URLs
const startRequests = [];
if (keyword) {
  startRequests.push({
    url: `https://m.kuaishou.com/search/video?keyword=${encodeURIComponent(keyword)}`,
    userData: { label: 'SEARCH' },
  });
}
for (const u of urlList) {
  startRequests.push({ url: u, userData: { label: 'DETAIL' } });
}

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  headless: true,
  maxConcurrency: 2,
  requestHandlerTimeoutSecs: 120,

  preNavigationHooks: [
    async ({ page }) => {
      try {
        await page.addInitScript((ua) => {
          Object.defineProperty(navigator, 'userAgent', { get: () => ua });
          Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
          Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
        }, UA_MOBILE);
      } catch {}
      try { await page.setViewportSize({ width: 390, height: 844 }); } catch {}
    },
  ],

  async requestHandler({ request, page, enqueueLinks, log }) {
    const { label } = request.userData || {};
    log.info(`Open: [${label}] ${request.url}`);

    const sniffer = attachSniffer(page);
    await gotoRobust(page, request.url);

    if (label === 'SEARCH') {
      await autoScroll(page, 6);
      let hrefs = await page.$$eval('a[href]', (as) => as.map(a => a.href));
      hrefs = hrefs.filter((h) => /\/short-video\/|\/f\//i.test(h));

      // fallback SERP si rien
      if (!hrefs.length && keyword) {
        log.info("Fallback Google CSE...");
        hrefs = await serpGoogleBatch(`site:kuaishou.com/short-video ${keyword}`);
      }

      if (!hrefs.length) {
        const buf = await page.screenshot({ fullPage: true });
        await kv.setValue(`DEBUG_SEARCH_${Date.now()}.png`, buf, { contentType: 'image/png' });
        log.warning("SEARCH: aucun lien trouvé !");
        sniffer.detach();
        return;
      }

      const top = hrefs.slice(0, limit);
      for (const u of top) {
        await enqueueLinks({ urls: [u], userData: { label: 'DETAIL' }, forefront: true });
      }
      sniffer.detach();
      return;
    }

    // DETAIL
    const videoUrl = await extractVideoUrl(page, { preBag: sniffer.bag });
    sniffer.detach();

    await dataset.pushData({ pageUrl: page.url(), videoUrl });
    if (videoUrl) log.info(`Video trouvée: ${videoUrl}`);
  },
});

await crawler.run(startRequests);
await Actor.exit();
