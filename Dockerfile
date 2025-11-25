# Use Node official image
FROM node:20-alpine

WORKDIR /app

# copy dependency manifests
COPY package*.json ./

# install dependencies
RUN npm ci --only=production

# copy app source
COPY . .

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server.js"]
