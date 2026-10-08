FROM node:22-slim AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend .
ARG NEXT_PUBLIC_API_URL=http://localhost:8010
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
