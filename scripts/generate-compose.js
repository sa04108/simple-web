#!/usr/bin/env node
'use strict';

/**
 * generate-compose.js <userid> <appname> <runtimeJson>
 *
 * detect-runtime.js의 출력(JSON)을 받아 {APP_DIR}/docker-compose.yml을 생성한다.
 *
 * 환경 분기:
 *   RUN_MODE=development  → 호스트 포트 직접 노출 (20000-29999, djb2 해시 결정)
 *                               네트워크는 Compose가 자동 생성하는 로컬 브릿지
 *   RUN_MODE=production   → 포트 노출 없음, external 네트워크 사용 (리버스 프록시 라우팅)
 */

const fs = require('node:fs');
const path = require('node:path');

// --- 환경변수 (common.sh / .env 와 동일한 이름) ---
const PAAS_ROOT             = process.env.PAAS_ROOT             || '/paas';
const PAAS_HOST_ROOT        = process.env.PAAS_HOST_ROOT        || PAAS_ROOT;
const PAAS_APPS_DIR         = process.env.PAAS_APPS_DIR         || `${PAAS_ROOT}/apps`;
const PAAS_DOMAIN           = process.env.PAAS_DOMAIN           || 'my.domain.com';
const APP_NETWORK           = process.env.APP_NETWORK           || 'paas-app';
const APP_CONTAINER_PREFIX  = process.env.APP_CONTAINER_PREFIX  || 'paas-app';
const APP_SOURCE_SUBDIR     = process.env.APP_SOURCE_SUBDIR     || 'app';
const APP_DATA_SUBDIR       = process.env.APP_DATA_SUBDIR       || 'data';
const APP_COMPOSE_FILE      = process.env.APP_COMPOSE_FILE      || 'docker-compose.yml';
const DEFAULT_MEM_LIMIT     = process.env.DEFAULT_MEM_LIMIT     || '256m';
const DEFAULT_CPU_LIMIT     = process.env.DEFAULT_CPU_LIMIT     || '0.5';
const DEFAULT_RESTART_POLICY = process.env.DEFAULT_RESTART_POLICY || 'unless-stopped';

// --- 내부 규약 파일명 ---
const PAAS_DOCKERFILE_NAME = '.paas.Dockerfile';

const IS_DEV = process.env.RUN_MODE === 'development';

// --- 유틸 ---

/**
 * common.sh의 to_host_path()와 동일한 역할.
 * 포털 컨테이너 내부 경로 → 호스트 경로로 변환한다.
 */
function toHostPath(containerPath) {
  if (!PAAS_HOST_ROOT || PAAS_HOST_ROOT === PAAS_ROOT) return containerPath;
  return containerPath.replace(PAAS_ROOT, PAAS_HOST_ROOT);
}

function normalizeSlash(p) {
  return p.replaceAll('\\', '/');
}

/**
 * 앱별 결정적 호스트 포트 산출 (djb2 변형, 20000-29999 범위).
 * dev 환경에서만 사용.
 */
function resolveHostPort(userid, appname) {
  let hash = 5381;
  for (const ch of `${userid}/${appname}`) {
    hash = (((hash << 5) + hash) ^ ch.charCodeAt(0)) >>> 0;
  }
  return 20000 + (hash % 10000);
}

// --- compose 생성 ---

function buildCompose({ userid, appname, runtime, appDir }) {
  const containerName = `${APP_CONTAINER_PREFIX}-${userid}-${appname}`;
  const domain = `${userid}-${appname}.${PAAS_DOMAIN}`;

  const hostAppDir = normalizeSlash(toHostPath(path.join(appDir, APP_SOURCE_SUBDIR)));
  const hostDataDir = normalizeSlash(toHostPath(path.join(appDir, APP_DATA_SUBDIR)));

  const hasUserDockerfile = fs.existsSync(path.join(appDir, APP_SOURCE_SUBDIR, 'Dockerfile'));
  const dockerfileRef = hasUserDockerfile ? 'Dockerfile' : PAAS_DOCKERFILE_NAME;

  const portsLines = IS_DEV
    ? ['    ports:', `      - "0.0.0.0:${resolveHostPort(userid, appname)}:${runtime.port}"`]
    : [];

  const lines = [
    'services:',
    '  app:',
    '    build:',
    `      context: ${JSON.stringify(hostAppDir)}`,
    `      dockerfile: ${JSON.stringify(dockerfileRef)}`,
    `    container_name: ${JSON.stringify(containerName)}`,
    `    restart: ${JSON.stringify(DEFAULT_RESTART_POLICY)}`,
    ...portsLines,
    '    volumes:',
    `      - ${JSON.stringify(`${hostDataDir}:/data`)}`,
    '    environment:',
    `      - ${JSON.stringify(`PORT=${runtime.port}`)}`,
    `      - ${JSON.stringify(`APP_ID=${userid}-${appname}`)}`,
    '      - "NODE_ENV=production"',
    `    mem_limit: ${JSON.stringify(DEFAULT_MEM_LIMIT)}`,
    `    cpus: ${DEFAULT_CPU_LIMIT}`,
    '    networks:',
    `      - ${APP_NETWORK}`,
    '    labels:',
    `      - ${JSON.stringify('paas.type=user-app')}`,
    `      - ${JSON.stringify(`paas.userid=${userid}`)}`,
    `      - ${JSON.stringify(`paas.appname=${appname}`)}`,
    `      - ${JSON.stringify(`paas.domain=${domain}`)}`,
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
  ];

  return lines.join('\n');
}

// --- CLI entry point ---

const userid = process.argv[2];
const appname = process.argv[3];
const runtimeJson = process.argv[4];

if (!userid || !appname || !runtimeJson) {
  process.stderr.write('Usage: generate-compose.js <userid> <appname> <runtimeJson>\n');
  process.exit(1);
}

let runtime;
try {
  runtime = JSON.parse(runtimeJson);
} catch (e) {
  process.stderr.write(`runtimeJson 파싱 실패: ${e.message}\n`);
  process.exit(1);
}

const appDir = path.resolve(PAAS_APPS_DIR, userid, appname);
const composePath = path.join(appDir, APP_COMPOSE_FILE);

try {
  const content = buildCompose({ userid, appname, runtime, appDir });
  fs.writeFileSync(composePath, content);
  process.stdout.write(`[generate-compose] 생성 완료: ${composePath}\n`);
  if (IS_DEV) {
    const hostPort = resolveHostPort(userid, appname);
    process.stdout.write(`[generate-compose] 호스트 포트: ${hostPort} → 컨테이너 포트: ${runtime.port}\n`);
  }
} catch (e) {
  process.stderr.write(`docker-compose.yml 생성 실패: ${e.message}\n`);
  process.exit(1);
}
