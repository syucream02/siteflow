FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY .npmrc ./

RUN npm ci

COPY . .

RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "node_modules/vinext/dist/cli.js", "start"]
