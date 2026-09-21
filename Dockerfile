FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache git python3 make g++
ENV NODE_ENV=production

# deps first so the layer caches
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js session.js store.js ./src/
COPY chat.html portal.html ./public/

ENV PORT=8080 \
    DATA_DIR=/data \
    SESSIONS=3 \
    BRAND="WhatsApp Hub"

EXPOSE 8080
CMD ["node", "src/server.js"]
