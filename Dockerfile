FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS build
WORKDIR /src

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
WORKDIR /app

COPY --from=build /src/dist ./dist
COPY package.json README.md LICENSE.md ./

WORKDIR /work
RUN chown node:node /work
USER node

ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["--help"]
