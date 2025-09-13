// main.js
const Apify = require('apify');
const { log } = Apify.utils;
const got = require('got');
const playwright = require('playwright');

Apify.main(async () => {
    const input = await Apify.getInput() || {};
    const keyword = input.keyword || '';
    if (!keyword) {
        log.error("Aucun mot-clé fourni dans l'input !");
        return;
    }
    const maxVideos = input.maxVideos || 10;
    const userAgentType = input.userAgentType || 'desktop';

    // Définir les User-Agent pour desktop et mobile
    const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';
    const mobileUA = 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36';
    const userAgent = userAgentType === 'mobile' ? mobileUA : desktopUA;

    log.info(`Recherche de vidéos pour le mot-clé "${keyword}"...`);

    // Lancer le navigateur Playwright
    const browser = await Apify.launchPlaywright({ 
        launcher: playwright.chromium,
        launchOptions: { headless: true }
    });
    // Créer un contexte avec le user-agent souhaité
    const context = await browser.newContext({ 
        userAgent: userAgent,
        viewport: userAgentType === 'mobile' ? { width: 414, height: 896 } : { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    // Naviguer vers la page de recherche Kuaishou pour le mot-clé
    const searchUrl = 'https://www.kuaishou.com/search/video?searchKey=' + encodeURIComponent(keyword);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

    let data;
    try {
        // Attendre la réponse GraphQL de la recherche
        const response = await page.waitForResponse(response => 
            response.url().includes('/graphql') && 
            response.request().method() === 'POST' &&
            response.request().postData().includes('visionSearchPhoto'),
            { timeout: 15000 }
        );
        data = await response.json();
    } catch (error) {
        // Si aucune réponse n'est reçue (bloqué ou aucun résultat)
        const content = await page.content();
        if (content.includes('拖动') || content.toLowerCase().includes('puzzle')) {
            log.error("Le site Kuaishou demande une vérification (CAPTCHA anti-robot).\n" +
                      "Veuillez réessayer plus tard, utiliser un autre user-agent ou un proxy.");
        } else {
            log.error("Aucune donnée de recherche reçue. Le mot-clé peut être invalide ou n'a retourné aucun résultat.");
        }
        await browser.close();
        return;
    }

    // Fermer la page de navigateur (plus nécessaire par la suite)
    await page.close();

    // Vérifier et extraire les résultats de la première page
    const feeds = data?.data?.visionSearchPhoto?.feeds || [];
    if (feeds.length === 0) {
        log.info("Aucune vidéo trouvée pour ce mot-clé.");
        await browser.close();
        return;
    }
    log.info(`${feeds.length} vidéos trouvées dans les résultats initiaux.`);

    const results = [];
    for (const item of feeds) {
        const title = item.photo.caption || "";
        const author = item.author?.name || "";
        const views = item.photo.viewCount ?? 0;
        const likes = item.photo.likeCount ?? 0;
        const id = item.photo.id;
        const videoPageLink = id ? `https://video.kuaishou.com/short-video/${id}` : "";
        const videoUrl = item.photo.photoUrl || "";
        results.push({ title, author, views, likes, videoPageLink, videoUrl });
        if (results.length >= maxVideos) break;
    }

    // Si besoin de plus de vidéos et qu'un curseur de page existe, continuer la pagination
    let pcursor = data.data.visionSearchPhoto.pcursor;
    while (pcursor && results.length < maxVideos) {
        log.info("Chargement de plus de vidéos (page suivante)...");
        // Préparer la requête GraphQL pour la page suivante
        const queryPayload = {
            operationName: "visionSearchPhoto",
            variables: {
                keyword: keyword,
                pcursor: pcursor,
                page: "search"
            },
            query: GRAPHQL_QUERY
        };
        try {
            const resp = await got.post('https://www.kuaishou.com/graphql', {
                json: queryPayload,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': userAgent,
                    'Origin': 'https://www.kuaishou.com',
                    'Referer': searchUrl,
                    'Cookie': (await context.cookies()).map(c => c.name + '=' + c.value).join('; ')
                }
            }).json();
            const newFeeds = resp.data?.visionSearchPhoto?.feeds || [];
            pcursor = resp.data?.visionSearchPhoto?.pcursor;
            if (newFeeds.length === 0) break;
            for (const item of newFeeds) {
                const title = item.photo.caption || "";
                const author = item.author?.name || "";
                const views = item.photo.viewCount ?? 0;
                const likes = item.photo.likeCount ?? 0;
                const id = item.photo.id;
                const videoPageLink = id ? `https://video.kuaishou.com/short-video/${id}` : "";
                const videoUrl = item.photo.photoUrl || "";
                results.push({ title, author, views, likes, videoPageLink, videoUrl });
                if (results.length >= maxVideos) break;
            }
        } catch (e) {
            log.error("Erreur lors de la récupération de la page suivante : " + e.message);
            break;
        }
    }

    // Limiter le nombre de résultats à maxVideos
    if (results.length > maxVideos) {
        results.length = maxVideos;
    }

    log.info(`Téléchargement de ${results.length} vidéo(s)...`);
    const fs = require('fs');
    // Créer les dossiers de sortie si non existants
    if (!fs.existsSync('output')) fs.mkdirSync('output');
    if (!fs.existsSync('output/videos')) fs.mkdirSync('output/videos', { recursive: true });

    let count = 0;
    for (const video of results) {
        const videoUrl = video.videoUrl;
        if (!videoUrl) continue;
        // Générer un nom de fichier: basé sur le titre (nettoyé) et l'ID
        let fileNameBase = video.title.replace(/[\/?<>:*|\n\r]/g, '').trim();
        if (!fileNameBase) fileNameBase = "video";
        if (fileNameBase.length > 50) {
            fileNameBase = fileNameBase.substring(0, 50);
        }
        const fileName = `${fileNameBase}_${video.videoPageLink.split('/').pop()}.mp4`;
        const filePath = `output/videos/${fileName}`;
        try {
            const downloadStream = got.stream(videoUrl, { headers: { 'User-Agent': userAgent } });
            await new Promise((resolve, reject) => {
                const fileWriter = fs.createWriteStream(filePath);
                downloadStream.pipe(fileWriter);
                downloadStream.on('error', err => reject(err));
                fileWriter.on('finish', () => resolve());
                fileWriter.on('error', err => reject(err));
            });
            count++;
            log.info(`Vidéo téléchargée : ${fileName}`);
        } catch (err) {
            log.error(`Échec du téléchargement de ${videoUrl} : ${err.message}`);
        }
        // Retirer le URL direct de la vidéo des résultats (plus utile à l'utilisateur)
        delete video.videoUrl;
        video.file = `output/videos/${fileName}`;
    }

    // Écrire les métadonnées des vidéos dans un fichier JSON
    fs.writeFileSync('output/results.json', JSON.stringify(results, null, 2), 'utf-8');
    log.info(`Téléchargement terminé. ${count} vidéo(s) téléchargée(s) dans le dossier output/videos.`);

    await browser.close();
});

// Requête GraphQL utilisée pour la pagination (récupérer les pages suivantes de résultats)
const GRAPHQL_QUERY = `fragment photoContent on PhotoEntity {
 __typename
 id
 duration
 caption
 originCaption
 likeCount
 viewCount
 commentCount
 realLikeCount
 coverUrl
 photoUrl
 photoH265Url
 manifest
 manifestH265
 videoResource
 coverUrls { url __typename }
 timestamp
 expTag
 animatedCoverUrl
 distance
 videoRatio
 liked
 stereoType
 profileUserTopPhoto
 musicBlocked
 riskTagContent
 riskTagUrl
}

fragment recoPhotoFragment on recoPhotoEntity {
 __typename
 id
 duration
 caption
 originCaption
 likeCount
 viewCount
 commentCount
 realLikeCount
 coverUrl
 photoUrl
 photoH265Url
 manifest
 manifestH265
 videoResource
 coverUrls { url __typename }
 timestamp
 expTag
 animatedCoverUrl
 distance
 videoRatio
 liked
 stereoType
 profileUserTopPhoto
 musicBlocked
 riskTagContent
 riskTagUrl
}

fragment feedContent on Feed {
 type
 author { id name headerUrl following headerUrls { url __typename } __typename }
 photo { ...photoContent ...recoPhotoFragment __typename }
 canAddComment
 llsid
 status
 currentPcursor
 tags { type name __typename }
 __typename
}

query visionSearchPhoto($keyword: String, $pcursor: String, $searchSessionId: String, $page: String, $webPageArea: String) {
  visionSearchPhoto(keyword: $keyword, pcursor: $pcursor, searchSessionId: $searchSessionId, page: $page, webPageArea: $webPageArea) {
    result
    llsid
    webPageArea
    feeds { ...feedContent __typename }
    searchSessionId
    pcursor
    aladdinBanner { imgUrl link __typename }
    __typename
  }
}`;
