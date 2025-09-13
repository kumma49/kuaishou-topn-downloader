# Node 20 pour compatibilité des deps
FROM apify/actor-node-playwright:20

# Dossier de travail
WORKDIR /usr/src/app

# Copie des manifests
COPY package*.json ./

# Installe les deps en root (évite les soucis de permissions)
RUN npm install --omit=dev --no-audit --no-fund

# Copie le reste du code
COPY . ./

# Exécute l'actor en utilisateur non-root
USER myuser

CMD ["npm","start"]
