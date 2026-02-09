#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TEMPLATE_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/;

function fail(message) {
  process.stderr.write(`[template-runtime] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const command = String(argv[2] || "").trim();
  const options = {};

  for (let index = 3; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) {
      fail(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!key || typeof value === "undefined") {
      fail(`Missing value for ${token}`);
    }
    options[key] = String(value);
    index += 1;
  }

  return { command, options };
}

function readJsonFile(filePath, { required = false } = {}) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (!required && error && error.code === "ENOENT") {
      return null;
    }
    if (!required && error instanceof SyntaxError) {
      return null;
    }
    fail(`Failed to read JSON: ${filePath}`);
  }
}

function normalizeTemplateId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!TEMPLATE_ID_REGEX.test(normalized)) {
    return "";
  }
  return normalized;
}

function requireOption(options, name) {
  const value = String(options[name] || "").trim();
  if (!value) {
    fail(`--${name} is required`);
  }
  return value;
}

function readTemplate(templateDirValue) {
  const templateDirInput = String(templateDirValue || "").trim();
  if (!templateDirInput) {
    fail("--template-dir is required");
  }
  const templateDir = path.resolve(templateDirInput);
  const templatePath = path.join(templateDir, "template.json");
  const payload = readJsonFile(templatePath, { required: true });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail(`Invalid template.json: ${templatePath}`);
  }

  const templateId = normalizeTemplateId(payload.id);
  if (!templateId) {
    fail(`template.json id is required and must match ${TEMPLATE_ID_REGEX}`);
  }

  return {
    templateDir,
    templateId,
    payload
  };
}

function normalizeHookPath(rawValue) {
  const hookPath = String(rawValue || "").trim();
  if (!hookPath) {
    return "";
  }
  if (path.isAbsolute(hookPath)) {
    fail("Hook path must be relative");
  }
  if (hookPath.split(/[\\/]/).includes("..")) {
    fail("Hook path cannot contain '..'");
  }
  return hookPath.replaceAll("\\", "/");
}

function readTemplateRuntime(templatePayload) {
  const runtime = templatePayload.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    fail("template runtime object is required");
  }

  const image = String(runtime.image || "").trim();
  if (!image) {
    fail("template runtime.image is required");
  }

  let command = null;
  if (Array.isArray(runtime.command)) {
    command = runtime.command.map((item) => String(item));
  } else if (typeof runtime.command === "string" && runtime.command.trim()) {
    command = runtime.command.trim();
  }

  const workdir = String(runtime.workdir || "/app").trim() || "/app";
  const mounts = Array.isArray(runtime.mounts) && runtime.mounts.length
    ? runtime.mounts
    : [{ type: "app", target: "/app" }, { type: "data", target: "/data" }];
  const environment =
    runtime.environment && typeof runtime.environment === "object" && !Array.isArray(runtime.environment)
      ? runtime.environment
      : {};

  return {
    image,
    command,
    workdir,
    mounts,
    environment
  };
}

function normalizePathValue(value) {
  return String(value || "").trim().replaceAll("\\", "/");
}

function joinPath(baseValue, ...parts) {
  const base = normalizePathValue(baseValue).replace(/\/+$/, "");
  const normalizedParts = parts
    .map((part) => normalizePathValue(part).replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);

  return [base, ...normalizedParts].filter(Boolean).join("/");
}

function mapMountSource({ mount, appDir, sharedDir, templateId }) {
  const type = String(mount.type || "").trim();
  const source = String(mount.source || "").trim();

  if (type === "app") {
    return joinPath(appDir, "app");
  }
  if (type === "data") {
    return joinPath(appDir, "data");
  }
  if (type === "logs") {
    return joinPath(appDir, "logs");
  }
  if (type === "shared") {
    if (!source) {
      fail("shared mount requires source");
    }
    return joinPath(sharedDir, templateId, source);
  }
  if (type === "host") {
    if (!source) {
      fail("host mount requires source");
    }
    return normalizePathValue(source);
  }
  fail(`Unsupported mount type: ${type}`);
}

function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function renderCommand(command) {
  if (command === null) {
    return "";
  }
  if (Array.isArray(command)) {
    return JSON.stringify(command);
  }
  return JSON.stringify(String(command));
}

function buildEnvironment({ templatePayload, runtime, userid, appname, templateId }) {
  const env = {};
  for (const [rawKey, rawValue] of Object.entries(runtime.environment)) {
    const key = String(rawKey || "").trim();
    if (!key) {
      continue;
    }
    env[key] = String(rawValue ?? "");
  }

  if (!Object.prototype.hasOwnProperty.call(env, "APP_ID")) {
    env.APP_ID = `${userid}-${appname}`;
  }
  if (!Object.prototype.hasOwnProperty.call(env, "TEMPLATE_ID")) {
    env.TEMPLATE_ID = templateId;
  }
  if (!Object.prototype.hasOwnProperty.call(env, "PORT")) {
    const internalPort = Number.parseInt(String(templatePayload.internalPort || ""), 10);
    if (Number.isInteger(internalPort) && internalPort > 0) {
      env.PORT = String(internalPort);
    }
  }

  return env;
}

function buildCompose({
  templatePayload,
  runtime,
  templateId,
  appDir,
  userid,
  appname,
  domain,
  network,
  sharedDir,
  memLimit,
  cpuLimit,
  restartPolicy
}) {
  const env = buildEnvironment({ templatePayload, runtime, userid, appname, templateId });
  const renderedCommand = renderCommand(runtime.command);
  const volumes = runtime.mounts.map((mount, index) => {
    if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
      fail(`Invalid mount at index ${index}`);
    }
    const target = String(mount.target || "").trim();
    if (!target) {
      fail(`mount target is required at index ${index}`);
    }
    const source = mapMountSource({ mount, appDir, sharedDir, templateId });
    const readOnly = toBoolean(mount.readOnly);
    return `${source}:${target}${readOnly ? ":ro" : ""}`;
  });

  const lines = [
    "services:",
    "  app:",
    `    image: ${JSON.stringify(runtime.image)}`,
    `    container_name: ${JSON.stringify(`paas-app-${userid}-${appname}`)}`,
    `    restart: ${JSON.stringify(restartPolicy)}`,
    `    working_dir: ${JSON.stringify(runtime.workdir)}`
  ];

  if (renderedCommand) {
    lines.push(`    command: ${renderedCommand}`);
  }

  lines.push("    volumes:");
  for (const volume of volumes) {
    lines.push(`      - ${JSON.stringify(volume)}`);
  }

  lines.push("    environment:");
  for (const [key, value] of Object.entries(env)) {
    lines.push(`      - ${JSON.stringify(`${key}=${value}`)}`);
  }

  lines.push(`    mem_limit: ${JSON.stringify(memLimit)}`);
  lines.push(`    cpus: ${JSON.stringify(cpuLimit)}`);
  lines.push("    networks:");
  lines.push("      - paas-proxy");
  lines.push("    labels:");
  lines.push(`      - ${JSON.stringify("paas.type=user-app")}`);
  lines.push(`      - ${JSON.stringify(`paas.userid=${userid}`)}`);
  lines.push(`      - ${JSON.stringify(`paas.appname=${appname}`)}`);
  lines.push(`      - ${JSON.stringify(`paas.domain=${userid}-${appname}.${domain}`)}`);
  lines.push("    logging:");
  lines.push("      driver: json-file");
  lines.push("      options:");
  lines.push('        max-size: "10m"');
  lines.push('        max-file: "3"');
  lines.push("");
  lines.push("networks:");
  lines.push("  paas-proxy:");
  lines.push("    external: true");
  lines.push(`    name: ${JSON.stringify(network)}`);
  lines.push("");

  return lines.join("\n");
}

function commandHook(options) {
  const templateDir = requireOption(options, "template-dir");
  const hookName = requireOption(options, "name");
  const { payload } = readTemplate(templateDir);
  const hooks =
    payload.hooks && typeof payload.hooks === "object" && !Array.isArray(payload.hooks)
      ? payload.hooks
      : {};
  const hookPath = normalizeHookPath(hooks[hookName]);
  process.stdout.write(hookPath);
}

function commandRuntimeImage(options) {
  const templateDir = requireOption(options, "template-dir");
  const { payload } = readTemplate(templateDir);
  const runtime = readTemplateRuntime(payload);
  process.stdout.write(runtime.image);
}

function commandResolveTemplateId(options) {
  const appDir = path.resolve(requireOption(options, "app-dir"));
  const metaPath = path.join(appDir, ".paas-meta.json");
  const templatePath = path.join(appDir, "template.json");

  const meta = readJsonFile(metaPath);
  const fromMeta = normalizeTemplateId(meta && meta.templateId);
  if (fromMeta) {
    process.stdout.write(fromMeta);
    return;
  }

  const templateJson = readJsonFile(templatePath);
  const fromTemplate = normalizeTemplateId(templateJson && templateJson.id);
  if (fromTemplate) {
    process.stdout.write(fromTemplate);
  }
}

function commandCompose(options) {
  const templateDir = requireOption(options, "template-dir");
  const passedTemplateId = normalizeTemplateId(options["template-id"]);
  const appDir = requireOption(options, "app-dir");
  const userid = requireOption(options, "userid");
  const appname = requireOption(options, "appname");
  const domain = requireOption(options, "domain");
  const network = requireOption(options, "network");
  const sharedDir = requireOption(options, "shared-dir");
  const memLimit = requireOption(options, "mem-limit");
  const cpuLimit = requireOption(options, "cpu-limit");
  const restartPolicy = requireOption(options, "restart-policy");

  const { payload, templateId } = readTemplate(templateDir);
  if (passedTemplateId && passedTemplateId !== templateId) {
    fail(`template id mismatch. arg=${passedTemplateId}, template.json=${templateId}`);
  }
  const runtime = readTemplateRuntime(payload);
  const compose = buildCompose({
    templatePayload: payload,
    runtime,
    templateId,
    appDir,
    userid,
    appname,
    domain,
    network,
    sharedDir,
    memLimit,
    cpuLimit,
    restartPolicy
  });
  process.stdout.write(compose);
}

function main() {
  const { command, options } = parseArgs(process.argv);

  if (command === "hook") {
    commandHook(options);
    return;
  }
  if (command === "runtime-image") {
    commandRuntimeImage(options);
    return;
  }
  if (command === "resolve-template-id") {
    commandResolveTemplateId(options);
    return;
  }
  if (command === "compose") {
    commandCompose(options);
    return;
  }

  fail("Usage: template-runtime.js <hook|runtime-image|resolve-template-id|compose> ...");
}

main();
