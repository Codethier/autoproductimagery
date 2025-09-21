FROM node:latest
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
ENV NUXT_GEMINI_API_KEY=ALZAXXXXXXXXXXXXX \
    NUXT_AUTH_USER=admin \
    NUXT_AUTH_PASSWORD=secretMakeItVeryLongAndSecure \
    DATABASE_URL="file:./sqlite/drizzle.db"
EXPOSE 3000
CMD ["/bin/sh", "-c", "npm run drizzle:migrate && node .output/server/index.mjs"]