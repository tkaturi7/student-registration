FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev \
    && npm cache clean --force

COPY server.js ./
COPY public ./public

RUN chown -R node:node /app

USER node

EXPOSE 3000

CMD ["npm", "start"]
