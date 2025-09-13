FROM apify/actor-node-playwright:18
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . ./
CMD ["npm","start"]
