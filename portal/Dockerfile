FROM node:22-alpine

RUN apk add --no-cache bash docker-cli \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && wget -O /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

WORKDIR /paas/portal
