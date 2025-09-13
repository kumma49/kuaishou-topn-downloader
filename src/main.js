// --- Fallback: Google SERP Actor -> retourne une liste d'URLs short-video/f ---
const serpSearch = async (keyword) => {
  if (!keyword) return [];
  const query = `site:kuaishou.com/short-video ${keyword}`;
  log.info(`SERP fallback query: ${query}`);

  // IMPORTANT: "queries" doit être un string (pas un tableau)
  const run = await Actor.call('apify/google-search-scraper', {
    queries: query,              // <= string
    resultsPerPage: 25,
    maxPagesPerQuery: 1,
    mobileResults: true,
    saveHtml: false,
  });

  // Récupération sûre du dataset de sortie
  const serpDatasetId =
    run?.defaultDatasetId ||
    run?.output?.defaultDatasetId ||
    run?.datasetId; // compat

  if (!serpDatasetId) {
    log.warning('SERP: pas de datasetId retourné par google-search-scraper.');
    return [];
  }

  const outDs = await Actor.openDataset(serpDatasetId);
  const { items } = await outDs.getData({ limit: 200 });

  const urls = (items || [])
    .map((it) => it?.url)
    .filter((u) => typeof u === 'string' && /kuaishou\.com\/(short-video|f)\//i.test(u));

  return unique(urls);
};
