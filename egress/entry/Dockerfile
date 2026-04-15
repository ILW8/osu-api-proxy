FROM node:lts-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:lts-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY --from=build /app/dist/src/ ./dist/
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || true
EXPOSE 5080 5404
CMD ["node", "dist/index.js"]
