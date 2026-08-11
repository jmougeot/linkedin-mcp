# Image de production du serveur MCP LinkedIn (Node).
# Ne contient QUE le serveur : l'extension Chrome tourne sur le poste de
# l'utilisateur, pas sur le VPS.
FROM node:22-bookworm-slim
WORKDIR /app

# Dépendances d'abord (cache Docker)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Code serveur
COPY server.js ./

# Mode VM par défaut ; le jeton (LI_TOKEN) vient de .env, jamais de l'image.
# BIND 0.0.0.0 : joignable par ruby-caddy via le réseau Docker (port non publié).
ENV LI_TRANSPORT=http
ENV LI_MCP_PORT=3210
ENV LI_BIND=0.0.0.0

# Compteurs du jour persistés sur un volume monté en /app/data
RUN mkdir -p /app/data
EXPOSE 3210

CMD ["node", "server.js"]
