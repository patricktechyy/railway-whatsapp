# ---- 1. build the Todolist page (React + Vite) ------------------------------
FROM node:22-alpine AS todo
WORKDIR /todo
COPY todo/package.json todo/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY todo/ ./
RUN npm run build

# ---- 2. Whats Up, with the Todolist built in ---------------------------------
FROM node:22-alpine

WORKDIR /app
# libsignal installs from GitHub and builds native bits
RUN apk add --no-cache git python3 make g++
ENV NODE_ENV=production

# Install dependencies in a cache-friendly layer.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js session.js store.js auth.js schedule.js backup.js ./src/
COPY chat.html login.html setup.html admin.html status.html ui.css ./public/
# the Todolist: its server part, and the page built above (served at /todo/)
COPY todo/server ./src/todo/server
COPY --from=todo /todo/dist ./src/todo/dist

ENV PORT=8080 \
    DATA_DIR=/data \
    BRAND="Apa yang Diatas (Whats Up)"

EXPOSE 8080
CMD ["node", "src/server.js"]
