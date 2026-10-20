# ---------------------------------------------------------------------------
# DocuMind AI - multi-stage production image
# Stage 1 compiles TypeScript; stage 2 runs as the non-root `node` user.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY public ./public

# Run as the unprivileged user shipped with the node image.
USER node
EXPOSE 3200

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3200/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/src/index.js"]
