// === src/main.js (version finale) ===
import { Actor, KeyValueStore, Dataset } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee';

// --- Helpers ---
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (arr) => [...new Set(arr)];

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

// Branche un sniffer réseau AVANT goto, et renvoie { bag, detach }
const attachSniffer = (page) => {
  const bag = [];
  const seen = new Set();
  const listener = (resp) => {
    try {
      const u = resp.url();
      if (
        /\.(mp4|m3u8)(\?|$)/i.test(u) ||
        (/play|video|stream/i.test(u) && u.startsWith('http'))
      ) {
        if (!seen.has(u)) {
          seen.add(u);
          bag.push(u);
        }
      }
    } catch {}
  };
  page.on('response', listener);
  const detach = () => page.off('response', listener);
  return { bag, detach };
};

// Tente d’extraire la vidéo depuis le DOM + ce qu’a sniffé le réseau
const extractVideoUrl = async (page, { acceptM3U8, preBag = [] }) => {
  const dom = await page.$$eval('video, source', (els) =>
    els.map((e) => e.src || e.getAttribute('src')).filter(Boolean),
  );
  const merged = unique([...dom, ...preBag]);
  return pickBestUrl(merged, acceptM3U8);
};

// Auto-scroll pour charger plus de cartes en recherche
const autoScroll = async (page, steps = 4) => {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 1200);
    await sleep(700 + Math.floor(Math.random() * 400));
  }
};

// --- Programme principal ---
await Actor.init();
const input = (await Actor.getInput()) || {};
const {
  keyword,
  urlList = [],
  limit = 3,
  useApifyProxy = true,
  saveBinary = true,
  acceptM3U8 = false,
} = input;

const proxyConfiguration = useApifyProxy
  ? await Actor.createProxyConfiguration()
  : new ProxyConfiguration();

const kv = await KeyValueStore.open();
const dataset = await Dataset.open();

// Pages de départ: SEARCH (si keyword) + DETAIL (si urlList)
const startRequests = [];
if (keyword) {
  startRequests.push({
    url: `https://www.kuaishou.com/search/video?keyword=${encodeURIComponent(keyword)}`,
    userData: { label: 'SEARCH' },
  });
}
for (const u of urlList) {
  startRequests.push({ url: u, userData: { label: 'DETAIL', likes: 0, rank: null } });
}

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  headless: true,
  maxConcurrency: 2,
  requestHandlerTimeoutSecs: 90,
  useSessionPool: true,
  persistCookiesPerSession: true,
  retryOnBlocked: true,
  maxRequestRetries: 2,

  // UA/viewport mobile au niveau du context (correct Playwright)
  launchContext: {
    contextOptions: {
      userAgent: UA_MOBILE,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    },
  },

  preNavigationHooks: [
    async () => {
      await sleep(300 + Math.floor(Math.random() * 400));
    },
  ],

  async requestHandler({ request, page, enqueueLinks, log }) {
    const { label } = request.userData || {};
    log.info(`Open: [${label || 'DETAIL'}] ${request.url}`);

    // 👉 Sniffer AVANT la navigation
    const sniffer = attachSniffer(page);

    await page.goto(request.url, { waitUntil: 'networkidle' });

    if (label === 'SEARCH') {
      await autoScroll(page, 5);

      const cards = await page.$$eval('a[href*="/short-video/"]', (as) =>
        as.map((a) => {
          const text = a.innerText || '';
          const href = a.href;
          return { href, text };
        }),
      );

      const dedup = [...new Map(cards.map((c) => [c.href, c])).values()];
      const scored = dedup.map((c) => ({
        url: c.href,
        likes: (c.text && c.text.match(/[\d.,]+\s*(?:w|万)|\d+/i)) ? c.text : '',
      }));
      for (const s of scored) s.likeCount = parseCount(s.likes);

      const top = scored
        .sort((a, b) => b.likeCount - a.likeCount)
        .slice(0, Math.max(1, Math.min(limit, 50)));

      let rank = 1;
      for (const t of top) {
        await enqueueLinks({
          urls: [t.url],
          userData: { label: 'DETAIL', likes: t.likeCount, rank },
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
    const item = {
      pageUrl: request.url,
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

    // Exploration limitée
    await enqueueLinks({
      strategy: 'same-domain',
      globs: ['https://www.kuaishou.com/short-video/**', 'https://www.kuaishou.com/search/video?*'],
      maxRequestsPerCrawl: 20,
    });
  },

  failedRequestHandler({ request }) {
    log.error(`Failed: ${request.url}`);
  },
});

await crawler.run(
  startRequests.length
    ? startRequests
    : [{ url: 'https://www.kuaishou.com', userData: { label: 'SEARCH' } }],
);

await Actor.exit();
