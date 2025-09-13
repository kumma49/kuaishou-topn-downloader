import { Actor, KeyValueStore, Dataset } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee';

// --- Helpers ---
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseCount = (txt = '') => {
  // "1.2w" or "1.2万" => 12000 ; otherwise plain number
  const w = txt.match(/([\d.,]+)\s*(w|万)/i);
  if (w) return Math.round(parseFloat(w[1].replace(',', '.')) * 10000);
  const n = txt.replace(/[^\d]/g, '');
  return n ? parseInt(n, 10) : 0;
};

const unique = (arr) => [...new Set(arr)];

const pickBestUrl = (arr, acceptM3U8) => {
  if (!arr || !arr.length) return null;
  const mp4 = arr.find((u) => /\.mp4(\?|$)/i.test(u));
  if (mp4) return mp4;
  if (acceptM3U8) return arr.find((u) => /\.m3u8(\?|$)/i.test(u)) || null;
  return null;
};

// --- Extraction depuis une page vidéo ---
const extractVideoUrl = async (page, { acceptM3U8 }) => {
  // 1) DOM direct
  const dom = await page.$$eval('video, source', (els) =>
    els.map((e) => e.src || e.getAttribute('src')).filter(Boolean)
  );
  let candidate = pickBestUrl(unique(dom), acceptM3U8);
  if (candidate) return candidate;

  // 2) Sniff réseau (placer listener avant goto dans handler)
  const bag = [];
  const seen = new Set();
  page.on('response', (resp) => {
    try {
      const u = resp.url();
      if (/\.(mp4|m3u8)(\?|$)/i.test(u) || (/play|video|stream/i.test(u) && u.startsWith('http'))) {
        if (!seen.has(u)) { seen.add(u); bag.push(u); }
      }
    } catch {}
  });
  await sleep(1500);
  candidate = pickBestUrl(unique(bag), acceptM3U8);
  return candidate;
};

// --- Auto-scroll pour charger plus de cartes en recherche ---
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

// On va faire 2 types de pages: SEARCH (si keyword) et DETAIL (pages vidéo).
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

  preNavigationHooks: [
    async ({ page }) => {
      await page.setUserAgent(UA_MOBILE);
      await page.setViewportSize({ width: 390, height: 844 });
      await sleep(300 + Math.floor(Math.random() * 400));
    },
  ],

  async requestHandler({ request, page, enqueueLinks, log }) {
    const { label } = request.userData || {};
    log.info(`Open: [${label || 'DETAIL'}] ${request.url}`);

    await page.goto(request.url, { waitUntil: 'networkidle' });

    // === SEARCH: on récupère les cartes, on score, on enfile top N vers DETAIL ===
    if (label === 'SEARCH') {
      await autoScroll(page, 5); // charge plusieurs écrans

      // Cherche les cartes et extrait url + score likes
      const cards = await page.$$eval('a[href*="/short-video/"]', (as) =>
        as.map((a) => {
          const text = a.innerText || '';
          const href = a.href;
          return { href, text };
        })
      );

      // Nettoyage + score
      const dedup = [...new Map(cards.map((c) => [c.href, c])).values()];
      const scored = dedup.map((c) => ({
        url: c.href,
        likes: (c.text && c.text.match(/[\d.,]+\s*(?:w|万)|\d+/i)) ? c.text : '',
      }));

      // Convertit en nombre
      for (const s of scored) s.likeCount = parseCount(s.likes);

      // tri desc & top N
      const top = scored
        .sort((a, b) => b.likeCount - a.likeCount)
        .slice(0, Math.max(1, Math.min(limit, 50)));

      // Enqueue vers DETAIL avec métadonnées (likes/rank)
      let rank = 1;
      for (const t of top) {
        await enqueueLinks({
          urls: [t.url],
          userData: { label: 'DETAIL', likes: t.likeCount, rank },
          forefront: true,
        });
        rank++;
      }

      // On sort tout de suite (les DETAIL seront traités)
      return;
    }

    // === DETAIL: on récupère videoUrl + (optionnel) on télécharge MP4 vers KV ===
    const videoUrl = await extractVideoUrl(page, { acceptM3U8 });
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
  },

  failedRequestHandler({ request }) {
    log.error(`Failed: ${request.url}`);
  },
});

await crawler.run(startRequests.length ? startRequests : [{
  url: 'https://www.kuaishou.com',
  userData: { label: 'SEARCH' },
}]);

await Actor.exit();
