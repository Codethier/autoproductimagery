FROM node:latest
WORKDIR /app
COPY . .
RUN npm install
RUN npx prisma generate
RUN npm run build
RUN npm migrate:deploy
ENV NUXT_GEMINI_API_KEY=ALZA \
    NUXT_AUTH_USER=admin \
    NUXT_AUTH_PASSWORD=secret \
    DATABASE_URL="file:./prisma.db"
EXPOSE 3000
CMD ["node","/app/output/server/index.mjs"]