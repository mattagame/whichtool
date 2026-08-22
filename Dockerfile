FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS build
WORKDIR /src

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
WORKDIR /app

COPY --from=build /src/dist ./dist
COPY package.json README.md LICENSE.md ./

WORKDIR /work
RUN chown node:node /work
USER node

ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["--help"]
