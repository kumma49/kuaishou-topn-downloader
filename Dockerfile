# Node 20 + Playwright (base Apify)
FROM apify/actor-node-playwright:20

# 1) Passe en root pour l'installation
USER root

# 2) Dossier de travail
WORKDIR /usr/src/app

# 3) Assure les droits sur le workdir (par précaution)
RUN mkdir -p /usr/src/app && chown -R root:root /usr/src/app

# 4) Copie les manifests et installe les deps EN ROOT
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 5) Copie le reste du code
COPY . ./

# 6) Reviens à l'utilisateur non-root pour l'exécution
USER myuser

# 7) Lancement de l'actor
CMD ["npm","start"]
