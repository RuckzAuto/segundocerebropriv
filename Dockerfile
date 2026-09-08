FROM node:20-slim

# Instalar ferramentas básicas
RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Configurar diretório de trabalho
WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar apenas dependências de produção
RUN npm install --production

# Copiar o restante do código
COPY . .

# Expor a porta 3000
EXPOSE 3000

# Executar a aplicação
CMD ["node", "server.mjs"]
