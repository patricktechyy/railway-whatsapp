FROM node:22-alpine

WORKDIR /app
# libsignal installs from GitHub and builds native bits
RUN apk add --no-cache git python3 make g++
ENV NODE_ENV=production

# Install dependencies in a cache-friendly layer.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js session.js store.js auth.js ./src/
COPY chat.html login.html setup.html admin.html status.html ./public/

ENV PORT=8080 \
    DATA_DIR=/data \
    BRAND="Apa yang Diatas (Whats Up)"

EXPOSE 8080
CMD ["node", "src/server.js"]
