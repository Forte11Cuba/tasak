# tasaK: the site and its server (tasak) in one image. See «Docker» in the README.
#
#   docker compose up -d --build
#
# The image has tasak, web/ and shared/; the .env is mounted at run time (docker-compose.yml), and the
# archive (ARCHIVE_DIR) lives in a volume. The signing key, if any, is mounted read-only: never baked in.

FROM rust:1.94.1-slim-trixie AS build
WORKDIR /src/server
# Dependencies first, so a code change doesn't download them again
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && touch src/lib.rs && cargo fetch --locked && rm -r src
COPY server/ ./
RUN cargo build --release --locked --bin tasak

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 tasak \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin tasak \
    && mkdir -p /data \
    && chown tasak:tasak /data
COPY --from=build /src/server/target/release/tasak /usr/local/bin/tasak
# web/ belongs to tasak: it writes config.js, favicon.svg, shared/ and api/ into it when it starts
COPY --chown=tasak:tasak web/ /app/web/
COPY --chown=tasak:tasak shared/ /app/shared/

WORKDIR /app
USER tasak
# Inside the container it must listen on every interface; publish the port on the host's 127.0.0.1
# (docker-compose.yml) and put the HTTPS proxy in front. These take precedence over .env
ENV LISTEN=0.0.0.0:8765 \
    ARCHIVE_DIR=/data
VOLUME ["/data"]
EXPOSE 8765
# A GET / without curl or wget: bash's /dev/tcp (if you change LISTEN, change the port here too)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8765 && printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3 && head -n 1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["tasak"]
