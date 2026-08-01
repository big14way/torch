# Torch executor agent, built for Google Cloud Confidential Space.
# The executor key is generated INSIDE the enclave at boot (no key baked in).
# Build context is the agent/ directory:  docker build -t <img> agent/
FROM node:22-slim

WORKDIR /app

# Install from the lockfile, not from ^ ranges. Without this two builds of the
# same source resolve different transitive trees and produce different image
# digests, so nobody (including us) can reproduce the digest the enclave
# attests to -- which makes the attestation unfalsifiable in both directions.
COPY package.json package-lock.json ./
RUN npm ci --include=optional && npm cache clean --force

# Source + generated config (deployments.json + ABIs, baked from a Coston2 deploy).
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# No EXECUTOR_PRIVATE_KEY here: it is generated in-enclave. HL_PRIVATE_KEY (a
# trade-only API wallet) is supplied at runtime via Secret Manager or VM env.
CMD ["npx", "tsx", "src/index.ts"]
