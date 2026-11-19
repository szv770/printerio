# Printio website (apps/web) as a self-contained Node container.
#
# The website runs on its own, never on a print server (docs/SAAS-LAUNCH-PLAN.md, "Independence and one-button updates").
# Build from the repo root:
#   docker build -t printio-web \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... --build-arg NEXT_PUBLIC_APP_URL=... \
#     --build-arg GITHUB_SHA=$(git rev-parse HEAD) --build-arg GITHUB_REF_NAME=$(git branch --show-current) .
# Run (secrets come from the host's environment, never from the image):
#   docker run -p 3000:3000 -e SUPABASE_SERVICE_ROLE_KEY=... -e GATEWAY_SHARED_SECRET=... -e PRINTIO_CRON_SECRET=... printio-web
#
# NEXT_PUBLIC_* values are baked into the browser code at build time, so they are build arguments (they are public by design).

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG GITHUB_SHA
ARG GITHUB_REF_NAME
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    GITHUB_SHA=$GITHUB_SHA \
    GITHUB_REF_NAME=$GITHUB_REF_NAME \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @printio/web build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
# The standalone server mirrors the monorepo layout: apps/web/server.js. Static files and public/ are not traced into it.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
# Liveness only (no database, no print server): a deploy that never becomes healthy is rolled back by the pipeline.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
