FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS build
WORKDIR /src

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app

COPY --from=build /src/dist ./dist
COPY package.json README.md LICENSE.md ./

WORKDIR /work
RUN chown node:node /work
USER node

ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["--help"]
