# Dockerfile — Node 20 with libs Chromium needs for Puppeteer
FROM node:20-bullseye-slim

# install system deps for Chromium
RUN apt-get update && apt-get install -y \
  ca-certificates wget gnupg \
  fonts-liberation libasound2 libatk1.0-0 libatk-bridge2.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 \
  libfontconfig1 libgbm1 libgcc-s1 libgdk-pixbuf2.0-0 libglib2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 \
  libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# copy package files first for npm caching
COPY package*.json ./
RUN npm ci --production=false

# copy rest
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
