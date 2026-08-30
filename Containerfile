FROM docker.io/library/node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

ENV PORT=3000
ENV DATA_DIR=/data
ENV EXECUTION_MODE=mock

RUN mkdir -p /data/assets /data/uploads && chown -R node:node /data
USER node

EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "src/server.mjs"]
