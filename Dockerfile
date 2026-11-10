# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS source
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json LICENSE NOTICE ./
RUN npm ci

FROM source AS web-build
RUN npm run build --workspace @media-router/web && chown -R node:node /app/apps/web/.next

FROM web-build AS web
ENV NODE_ENV=production
USER node
EXPOSE 4320
CMD ["npm", "exec", "--workspace", "@media-router/web", "--", "next", "start", "--hostname", "0.0.0.0", "--port", "4320"]

# API and worker run the same TypeScript core; no frontend build or secret is needed.
FROM source AS server
ENV NODE_ENV=production
USER node
EXPOSE 4310
CMD ["npm", "run", "dev:api"]
