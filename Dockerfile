FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=d*v

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
