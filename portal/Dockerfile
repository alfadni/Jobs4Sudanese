# Jobs4Sudanese portal. Build from the REPOSITORY ROOT (the portal runs the
# career-ops engine scripts that live there):
#
#   DOCKER_BUILDKIT=1 docker build -f portal/Dockerfile -t jobs4sudanese .
#   docker run -p 3100:3100 -v j4s-data:/data \
#     -e PORTAL_SECRET=... -e ANTHROPIC_API_KEY=... -e PORTAL_ADMIN_EMAILS=you@example.com \
#     jobs4sudanese
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORTAL_DATA_DIR=/data \
    PORT=3100 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
# Engine dependencies first (cached layer), then the portal's.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY portal/package.json portal/package-lock.json ./portal/
RUN cd portal && npm ci --omit=dev --no-audit --no-fund

# User data and secrets never enter the build context: see Dockerfile.dockerignore.
COPY . .
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 3100
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "portal/server.mjs"]
