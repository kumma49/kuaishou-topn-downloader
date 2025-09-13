# 1) Passe à Node 20 pour éviter EBADENGINE
FROM apify/actor-node-playwright:20

# 2) Dossier de travail
WORKDIR /usr/src/app

# 3) Copie des manifests avec le bon propriétaire
COPY --chown=myuser:myuser package*.json ./

# 4) Exécute npm en tant que 'myuser' (droits ok)
USER myuser
RUN npm install --omit=dev --no-audit --no-fund

# 5) Copie du reste du code avec les bons droits
COPY --chown=myuser:myuser . ./

# 6) Démarrage
CMD ["npm","start"]
