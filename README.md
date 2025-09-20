docker run  -p 3000:3000 \
  --env-file .env \
  

example env file:

GEMINI_API_KEY="AIza"
# Basic cookie auth for server-side routes
NUXT_AUTH_USER="admin"
NUXT_AUTH_PASSWORD="secret"
DATABASE_URL="file:./dev.db"


The gemini api is currently a mess, and gives 