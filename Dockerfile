FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
# lib/push-store.js persists push subscriptions under /app/data.
RUN mkdir -p /app/data && chown -R 1000:1000 /app/data
# Run as the base image's non-root `node` user, named by NUMBER (UID 1000):
# the platform runs containers with runAsNonRoot, which refuses an image that
# would run as root and can only verify a numeric UID.
USER 1000
EXPOSE 3000
# 127.0.0.1, not localhost: in Alpine `/etc/hosts` lists `::1 localhost`
# before `127.0.0.1 localhost`, BusyBox wget resolves to the v6 address
# first, and Express's app.listen(PORT, '0.0.0.0') binds IPv4 only — so
# wget against `localhost` fails with "connection refused" and the
# container shows up as `unhealthy` even when the dapp is fine.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
