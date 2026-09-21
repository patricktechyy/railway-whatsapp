FROM node:22-alpine

WORKDIR /app
# libsignal installs from GitHub and builds native bits
RUN apk add --no-cache git python3 make g++
ENV NODE_ENV=production

# deps first so the layer caches; then the one-line Baileys platform patch
COPY package.json patch-baileys.mjs ./
RUN npm install --omit=dev --no-audit --no-fund && node patch-baileys.mjs

COPY server.js session.js store.js auth.js ./src/
COPY chat.html login.html setup.html admin.html ./public/

ENV PORT=8080 \
    DATA_DIR=/data \
    BRAND="WhatsApp Hub"

EXPOSE 8080
CMD ["node", "src/server.js"]
