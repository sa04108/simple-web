#!/usr/bin/env node
'use strict';

/**
 * generate-dockerfile.js <runtimeJson> <appDir>
 *
 * detect-runtime.js가 출력한 JSON을 받아 <appDir>/.paas.Dockerfile을 생성한다.
 * - 사용자 repo에 이미 Dockerfile이 있으면 생성을 건너뛴다.
 * - .paas.dockerignore도 함께 생성한다.
 */

const fs = require('fs');
const path = require('path');

// --- 내부 규약 파일명 ---
const PAAS_DOCKERFILE_NAME   = '.paas.Dockerfile';
const PAAS_DOCKERIGNORE_NAME = '.paas.dockerignore';

function buildDockerfile(runtime) {
  const {
    nodeVersion = '22',
    hasBuild,
    buildCommand,
    startCommand,
    port = 3000,
    hasLockFile,
  } = runtime;

  const installCmd = hasLockFile ? 'npm ci' : 'npm install';
  const installCmdWithDev = hasLockFile ? 'npm ci' : 'npm install';
  const installCmdProdOnly = hasLockFile ? 'npm ci --omit=dev' : 'npm install --omit=dev';

  // startCommand가 "npm start" 같은 문자열 → CMD 배열로 변환
  const cmdArray = startCommand.split(' ');
  const cmdJson = JSON.stringify(cmdArray);

  const lines = [
    `FROM node:${nodeVersion}-alpine`,
    'WORKDIR /app',
    '',
    '# package.json만 먼저 복사해 의존성 레이어 캐시 활용',
    'COPY package*.json ./',
  ];

  if (hasBuild) {
    // 빌드 단계에서는 devDependencies 포함 설치
    lines.push(`RUN ${installCmdWithDev}`);
  } else {
    lines.push(`RUN ${installCmdProdOnly}`);
  }

  lines.push('');
  lines.push('COPY . .');

  if (hasBuild) {
    lines.push('');
    lines.push(`RUN ${buildCommand}`);
    lines.push('');
    lines.push('# 빌드 완료 후 devDependencies 제거해 이미지 크기 감소');
    lines.push('RUN npm prune --omit=dev');
  }

  lines.push('');
  lines.push(`EXPOSE ${port}`);
  lines.push(`ENV PORT=${port}`);
  lines.push(`CMD ${cmdJson}`);

  return lines.join('\n') + '\n';
}

const DOCKERIGNORE_CONTENT = `node_modules/
.git/
.gitignore
*.log
npm-debug.log*
.env
.env.*
.DS_Store
dist/
.next/
.nuxt/
.output/
coverage/
`;

function run(runtimeJson, appDir) {
  const resolvedDir = path.resolve(appDir);

  // 사용자 repo에 자체 Dockerfile이 있으면 건너뜀
  if (fs.existsSync(path.join(resolvedDir, 'Dockerfile'))) {
    process.stdout.write(`[generate-dockerfile] 사용자 Dockerfile 감지 → 자동 생성 건너뜀\n`);
    return;
  }

  let runtime;
  try {
    runtime = JSON.parse(runtimeJson);
  } catch (e) {
    throw new Error('runtimeJson 파싱 실패: ' + e.message);
  }

  const dockerfilePath = path.join(resolvedDir, PAAS_DOCKERFILE_NAME);
  const dockerignorePath = path.join(resolvedDir, PAAS_DOCKERIGNORE_NAME);

  fs.writeFileSync(dockerfilePath, buildDockerfile(runtime));
  fs.writeFileSync(dockerignorePath, DOCKERIGNORE_CONTENT);

  process.stdout.write(`[generate-dockerfile] 생성 완료: ${dockerfilePath}\n`);
}

// --- CLI entry point ---

const runtimeJson = process.argv[2];
const appDir = process.argv[3];

if (!runtimeJson || !appDir) {
  process.stderr.write('Usage: generate-dockerfile.js <runtimeJson> <appDir>\n');
  process.exit(1);
}

try {
  run(runtimeJson, appDir);
} catch (e) {
  process.stderr.write('Dockerfile 생성 실패: ' + e.message + '\n');
  process.exit(1);
}
