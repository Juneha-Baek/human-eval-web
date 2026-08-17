FROM node:22-alpine

WORKDIR /app
COPY . .

# annotations live on a mounted volume so redeploys never lose data
ENV DATA_DIR=/data
ENV HOST=0.0.0.0
ENV PORT=8080
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "server.js"]
