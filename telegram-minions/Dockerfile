FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Goose CLI
RUN curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

# Set Goose config location
ENV GOOSE_CONFIG=/app/goose/config.yaml

CMD ["node", "dist/main.js"]
