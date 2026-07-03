# Torch executor agent, built for Google Cloud Confidential Space.
# The executor key is generated INSIDE the enclave at boot (no key baked in).
# Build context is the agent/ directory:  docker build -t <img> agent/
FROM node:20-slim

WORKDIR /app

# Install deps (incl. tsx and the optional Hyperliquid SDK) before prod flip.
COPY package.json ./
RUN npm install --include=optional && npm cache clean --force

# Source + generated config (deployments.json + ABIs, baked from a Coston2 deploy).
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# No EXECUTOR_PRIVATE_KEY here: it is generated in-enclave. HL_PRIVATE_KEY (a
# trade-only API wallet) is supplied at runtime via Secret Manager or VM env.
CMD ["npx", "tsx", "src/index.ts"]
