# Plain, unauthenticated Redis on Railway's private network.
# The proxy's config has a host:port field and no credential field, so a managed
# Redis (which requires auth) cannot be used. Reachable only inside the project.
FROM redis:7-alpine
CMD ["redis-server", "--save", "", "--appendonly", "no", "--protected-mode", "no", "--bind", "0.0.0.0"]
