# Only needed for self-hosting (Fly, a VPS, docker compose).
# Vercel does not use this file — it builds api/index.js as a function.
FROM node:22-alpine

WORKDIR /app
COPY . .

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# State lives in Supabase, so the container is stateless and needs no volume.
CMD ["node", "server.js"]
