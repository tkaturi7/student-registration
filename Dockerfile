FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev \
    && npm cache clean --force

COPY server.js ./
COPY public ./public

RUN chown -R 1000:1000 /app

USER 1000:1000

EXPOSE 3000

CMD ["npm", "start"]
