FROM node:alpine

WORKDIR /app

# Install dependencies for telegram bot and typescript
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build the TypeScript code
RUN npm run build

# Remove dev dependencies to reduce image size (optional but recommended)
RUN npm prune --production

# Start the bot
CMD ["node", "index.js"] 