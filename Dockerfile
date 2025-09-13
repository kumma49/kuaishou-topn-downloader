FROM apify/actor-node-playwright:18
WORKDIR /usr/src/app

# Copie d'abord package.json pour tirer parti du cache Docker
COPY package*.json ./

# Utilise npm install (pas npm ci) car on n'a pas de package-lock.json
RUN npm install --omit=dev

# Copie le reste du code
COPY . ./

CMD ["npm","start"]
