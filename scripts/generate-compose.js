#!/usr/bin/env node
'use strict';

/**
 * generate-compose.js <userid> <appname>
 *
 * {APP_DIR}/docker-compose.yml을 생성한다.
 *
 * 컨테이너 포트: 사용 중인 Dockerfile의 EXPOSE 포트 (없으면 기본값)
 *
 * 모든 환경에서 포트를 직접 노출하지 않고 Traefik 리버스 프록시를 경유한다.
 * dev 환경에서는 PAAS_DOMAIN=localhost 설정으로 *.localhost 도메인을 통해 접근한다.
 */

const fs = require('node:fs');
const path = require('node:path');

// --- 환경변수 (common.sh / .env 와 동일한 이름) ---
const PAAS_ROOT              = process.env.PAAS_ROOT              || '/paas';
const PAAS_APPS_DIR          = process.env.PAAS_APPS_DIR          || `${PAAS_ROOT}/apps`;
const PAAS_DOMAIN            = process.env.PAAS_DOMAIN            || 'my.domain.com';
const APP_NETWORK            = process.env.APP_NETWORK            || 'paas-app';
const APP_CONTAINER_PREFIX   = process.env.APP_CONTAINER_PREFIX   || 'paas-app';
const APP_SOURCE_SUBDIR      = process.env.APP_SOURCE_SUBDIR      || 'app';
const APP_DATA_SUBDIR        = process.env.APP_DATA_SUBDIR        || 'data';
const APP_COMPOSE_FILE       = process.env.APP_COMPOSE_FILE       || 'docker-compose.yml';
const DEFAULT_MEM_LIMIT      = process.env.DEFAULT_MEM_LIMIT      || '256m';
const DEFAULT_CPU_LIMIT      = process.env.DEFAULT_CPU_LIMIT      || '0.5';
const DEFAULT_RESTART_POLICY = process.env.DEFAULT_RESTART_POLICY || 'unless-stopped';

// --- 내부 규약 ---
const PAAS_DOCKERFILE_NAME = '.paas.Dockerfile';
const DEFAULT_CONTAINER_PORT = 5000;

// --- 유틸 ---

/**
 * Dockerfile의 첫 번째 EXPOSE 포트를 파싱한다.
 * 없거나 읽기 실패 시 null 반환.
 */
function parseDockerfileExposePort(dockerfilePath) {
  try {
    const content = fs.readFileSync(dockerfilePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (/^EXPOSE\s+\d+/i.test(trimmed)) {
        const port = Number.parseInt(trimmed.split(/\s+/)[1], 10);
        if (port > 0 && port <= 65535) return port;
      }
    }
  } catch {
    // 읽기/파싱 실패
  }
  return null;
}

// --- compose 생성 ---

/**
 * @returns {{ content: string, containerPort: number }}
 */
function buildCompose({ userid, appname, appDir }) {
  const containerName = `${APP_CONTAINER_PREFIX}-${userid}-${appname}`;
  const domain = `${userid}-${appname}.${PAAS_DOMAIN}`;

  const userDockerfilePath = path.join(appDir, APP_SOURCE_SUBDIR, 'Dockerfile');
  const hasUserDockerfile = fs.existsSync(userDockerfilePath);

  // 사용 중인 Dockerfile 결정
  const dockerfileRef = hasUserDockerfile ? 'Dockerfile' : PAAS_DOCKERFILE_NAME;

  // 컨테이너 포트: 사용 Dockerfile의 EXPOSE 값, 없으면 기본값
  const dockerfilePath = hasUserDockerfile
    ? userDockerfilePath
    : path.join(appDir, APP_SOURCE_SUBDIR, PAAS_DOCKERFILE_NAME);
  const containerPort = parseDockerfileExposePort(dockerfilePath) ?? DEFAULT_CONTAINER_PORT;

  const content = [
    'services:',
    '  app:',
    '    build:',
    `      context: ./${APP_SOURCE_SUBDIR}`,
    `      dockerfile: ${JSON.stringify(dockerfileRef)}`,
    `    container_name: ${JSON.stringify(containerName)}`,
    `    restart: ${JSON.stringify(DEFAULT_RESTART_POLICY)}`,
    '    volumes:',
    `      - "./${APP_DATA_SUBDIR}:/data"`,
    '    environment:',
    `      - ${JSON.stringify(`PORT=${containerPort}`)}`,
    `      - ${JSON.stringify(`APP_ID=${userid}-${appname}`)}`,
    '      - "NODE_ENV=production"',
    `    mem_limit: ${JSON.stringify(DEFAULT_MEM_LIMIT)}`,
    `    cpus: ${DEFAULT_CPU_LIMIT}`,
    '    networks:',
    `      - ${APP_NETWORK}`,
    '    labels:',
    `      - ${JSON.stringify('traefik.enable=true')}`,
    // 라우터: defaultRule 대신 명시적으로 선언해야 미들웨어를 붙일 수 있다.
    `      - ${JSON.stringify(`traefik.http.routers.${containerName}.rule=Host(\`${domain}\`)`)}`,
    `      - ${JSON.stringify(`traefik.http.routers.${containerName}.entrypoints=web`)}`,
    `      - ${JSON.stringify(`traefik.http.routers.${containerName}.service=${containerName}`)}`,
    `      - ${JSON.stringify(`traefik.http.routers.${containerName}.middlewares=${containerName}-rewrite-host`)}`,
    // 서비스: 컨테이너가 실제로 리스닝하는 포트로 명시적 포워딩
    `      - ${JSON.stringify(`traefik.http.services.${containerName}.loadbalancer.server.port=${containerPort}`)}`,
    // 미들웨어: Host 헤더를 localhost로 재작성 → Vite 등 dev server의 host 검증을 통과시킨다.
    `      - ${JSON.stringify(`traefik.http.middlewares.${containerName}-rewrite-host.headers.customrequestheaders.Host=localhost`)}`,
    `      - ${JSON.stringify('paas.type=user-app')}`,
    `      - ${JSON.stringify(`paas.userid=${userid}`)}`,
    `      - ${JSON.stringify(`paas.appname=${appname}`)}`,
    `      - ${JSON.stringify(`paas.domain=${domain}`)}`,
    `      - ${JSON.stringify(`paas.port=${containerPort}`)}`,
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
    '',
    'networks:',
    `  ${APP_NETWORK}:`,
    '    external: true',
    `    name: ${JSON.stringify(APP_NETWORK)}`,
    '',
  ].join('\n');

  return { content, containerPort };
}

// --- CLI entry point ---

const userid = process.argv[2];
const appname = process.argv[3];

if (!userid || !appname) {
  process.stderr.write('Usage: generate-compose.js <userid> <appname>\n');
  process.exit(1);
}

const appDir = path.resolve(PAAS_APPS_DIR, userid, appname);
const composePath = path.join(appDir, APP_COMPOSE_FILE);

try {
  const { content, containerPort } = buildCompose({ userid, appname, appDir });
  fs.writeFileSync(composePath, content);
  process.stdout.write(`[generate-compose] 생성 완료: ${composePath}\n`);
  process.stdout.write(`[generate-compose] 컨테이너 포트: ${containerPort}\n`);
} catch (e) {
  process.stderr.write(`docker-compose.yml 생성 실패: ${e.message}\n`);
  process.exit(1);
}
