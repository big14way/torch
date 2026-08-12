# Thin wrapper over the scaffold's tee-proxy: same binary, config rendered from
# the environment so no credential is ever baked into a pushed image.
ARG BASE=local/tee-proxy:latest
FROM ${BASE}
USER root
COPY extension_proxy.template.toml /app/config/config.template.toml
COPY proxy-entrypoint.sh /usr/local/bin/proxy-entrypoint.sh
RUN chmod +x /usr/local/bin/proxy-entrypoint.sh \
 && mkdir -p /app/config \
 && chown -R appuser /app/config
USER appuser
ENTRYPOINT ["/usr/local/bin/proxy-entrypoint.sh"]
CMD ["./main"]
