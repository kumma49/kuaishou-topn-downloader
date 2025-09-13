# Scraper Kuaishou - Extraction et téléchargement de vidéos

Ce projet est un **scraper Kuaishou** complet qui permet de rechercher des vidéos sur [kuaishou.com](https://www.kuaishou.com) par mot-clé, d’en extraire les métadonnées (titre, auteur, vues, likes, lien de la vidéo) et de télécharger les vidéos sur votre ordinateur. 

Le projet est structuré pour être utilisé tel quel sur GitHub ou sur la plateforme Apify.

## Fonctionnalités

- Recherche de vidéos en fonction d’un mot-clé fourni (par exemple *animaux domestiques*, modifiable par l’utilisateur).
- Extraction des métadonnées pour chaque vidéo trouvée : **titre**, **auteur**, **nombre de vues**, **nombre de likes**, **lien vers la vidéo**.
- **Téléchargement** de chaque vidéo dans un dossier local (`output/videos`).
- Navigation automatisée sur kuaishou.com à l’aide de **Playwright** (via l’Apify SDK) pour charger les résultats.
- Gestion de la **pagination** : le scraper défile la page et utilise l’API interne pour charger plusieurs pages de résultats si nécessaire.
- Possibilité de configurer le type de **User-Agent** (mobile ou desktop) pour simuler un navigateur mobile ou PC.
- Fourniture d’un fichier d’**input JSON** d’exemple pour configurer facilement le mot-clé et le nombre de vidéos à récupérer.
- **Robustesse** : le scraper attend le chargement complet des éléments et gère les cas où aucun résultat n’est trouvé ou si un captcha anti-robot apparaît.

## Prérequis

- **Node.js** (version 16 ou supérieure) doit être installé sur votre machine.
- (Optionnel) Un compte Apify si vous souhaitez exécuter ce scraper sur la plateforme Apify. Dans ce cas, vous n’aurez pas besoin d’installer Node.js localement, mais l’utilisation locale est recommandée pour tester.

## Installation et configuration

1. **Téléchargez l’archive ZIP** du projet et décompressez-la dans un dossier de votre choix.
2. **Dans un terminal**, placez-vous dans le dossier du projet décompressé.
3. Exécutez la commande : `npm install`  
   Cela installera les dépendances nécessaires (Apify SDK, Playwright, etc.).
4. Ouvrez le fichier `input.json` (fourni à la racine du projet) dans un éditeur de texte. Vous pouvez y configurer :
   - `keyword` : le mot-clé de recherche (par exemple `"animaux domestiques"`). **Utilisez les guillemets** car c’est une chaîne de caractères.
   - `maxVideos` : le nombre maximum de vidéos à récupérer (le scraper s’arrêtera après ce nombre si suffisamment de résultats sont trouvés).
   - `userAgentType` : `"desktop"` pour simuler un navigateur desktop, ou `"mobile"` pour simuler un navigateur mobile. Par défaut c’est desktop.
5. Enregistrez vos modifications du fichier `input.json`.

## Utilisation locale (sur PC)

Une fois les étapes d’installation terminées et le `input.json` configuré :

- **Exécution du scraper :** Dans le terminal, lancez la commande : `npm start`  
  (Vous pouvez aussi exécuter `node main.js` directement. Sur Apify CLI, vous pourriez utiliser `apify run` si vous avez le CLI, mais `npm start` suffit.)

- Le scraper va alors ouvrir un navigateur headless et naviguer sur kuaishou.com, effectuer la recherche, charger les résultats et télécharger les vidéos. Vous verrez dans le terminal des messages de log indiquant la progression (nombre de vidéos trouvées, téléchargements en cours, etc.).

- **Résultats :** 
  - Les vidéos téléchargées se trouvent dans le dossier `output/videos`. Chaque fichier vidéo est nommé d’après le titre de la vidéo (tronqué si trop long) suivi de l’identifiant unique de la vidéo. 
  - Un fichier `output/results.json` est également généré, contenant la liste des vidéos avec leurs métadonnées (au format JSON). Dans ce fichier, chaque entrée comporte le titre, l’auteur, le nombre de vues, le nombre de likes, le lien de la vidéo sur le site et le chemin du fichier vidéo téléchargé en local.

- **Fin d’exécution :** Une fois le téléchargement terminé, le script affiche un message de fin avec le nombre de vidéos téléchargées. Vous pouvez alors consulter le dossier `output/` pour voir les vidéos et le fichier de résultats.

## Utilisation sur la plateforme Apify

Ce projet est compatible avec la plateforme [Apify](https://apify.com). Pour l’utiliser en tant qu’**Actor** Apify :
1. Uploadez l’ensemble des fichiers du projet sur un nouveau dépôt GitHub ou zippez-les.
2. Créez un nouvel Actor sur Apify et importez le projet depuis GitHub **ou** uploadez directement le zip.
3. Dans les paramètres de l’Actor sur Apify, assurez-vous que l’image Docker utilisée est bien celle indiquée dans `apify.json` (une image avec Playwright, par exemple `apify/actor-node-playwright-chrome:latest`).
4. Sur Apify, fournissez le JSON d’input (même format que le fichier `input.json`) via l’interface utilisateur d’exécution. Vous pouvez coller le contenu de votre `input.json` dans le champ d’input de l’Actor.
5. Lancez l’exécution. 
6. Une fois terminée, vous trouverez les fichiers téléchargés dans le stockage par défaut de l’Actor (dans la sortie de l’exécution, section *Key-Value Store* sous la clé `OUTPUT` ou similaires, et possiblement dans le dossier `output` du système de fichiers de l’Actor). Vous pourrez télécharger le dossier `output` complet via l’Apify Console si nécessaire. Les métadonnées seront également consultables dans le fichier `output/results.json` ou dans le dataset par défaut si vous choisissez de pousser les données différemment.

*Remarque:* Sur Apify, les fichiers téléchargés sont stockés dans le système de fichiers temporaire de l’Actor. Pour les conserver, vous pouvez modifier le script pour sauvegarder les vidéos dans le *Key-Value Store* (non implémenté par défaut dans ce projet).

## Remarques et dépannage

- **Captcha anti-robot :** Si le site détecte une activité suspecte, il peut demander une vérification (puzzle à glisser). Le script tentera de détecter ce cas et le signalera dans les logs. Si cela se produit fréquemment, essayez de réduire le nombre de requêtes (baisser `maxVideos`), d’utiliser un `userAgentType` différent (`mobile` au lieu de `desktop` ou vice-versa), ou d’utiliser un proxy résidentiel/localisé en Chine pour éviter le blocage.
- **Limites de taux :** Le scraper utilise des délais et un défilement progressif pour ne pas surcharger le site. Toutefois, évitez de mettre un `maxVideos` trop élevé (des centaines) sans ajustements, car cela pourrait déclencher des mécanismes anti-scraping.
- **Structure des résultats :** Le fichier `output/results.json` vous donne toutes les informations extraites. Vous pouvez l’ouvrir avec un éditeur de texte ou un visualiseur JSON. Si besoin, ces données peuvent être facilement converties en CSV ou Excel pour analyse.
- **Environnement :** Par défaut, le navigateur tourne en mode headless (non-visible). Pour voir l’action en direct (debuggage), vous pouvez modifier `headless: true` en `headless: false` dans le code (`main.js`), ce qui ouvrira un vrai navigateur visible (pensez alors à ne pas bouger la souris/clavier pendant que le robot fonctionne).

## Structure du projet

```text
kuaishou-video-scraper/
├── main.js          # Script principal contenant le code du scraper
├── package.json     # Fichier de configuration npm avec les dépendances
├── apify.json       # Configuration de l’Actor Apify (image Docker, métadonnées)
├── input.json       # Exemple de configuration d’input (mot-clé, nombre de vidéos, etc.)
├── README.md        # Ce fichier d’explications
├── .gitignore       # Fichier gitignore pour exclure node_modules, outputs, etc.
└── output/          # Dossier de sortie (créé après exécution) contenant les vidéos et le fichier results.json
    ├── videos/      # Vidéos téléchargées (.mp4)
    └── results.json # Métadonnées des vidéos extraites (au format JSON)
