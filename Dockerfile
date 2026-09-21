FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# deps first so the layer caches
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV PORT=8080 \
    DATA_DIR=/data \
    SESSIONS=3 \
    BRAND="WhatsApp Hub"

EXPOSE 8080
CMD ["node", "src/server.js"]
