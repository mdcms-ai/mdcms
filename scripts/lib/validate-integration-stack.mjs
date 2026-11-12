import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const services = [
  "db-migrate",
  "server",
  "postgres",
  "redis",
  "minio",
  "minio-init",
  "mailhog",
];
const portLayout = {
  server: [4000],
  postgres: [5432],
  redis: [6379],
  minio: [9000, 9001],
  mailhog: [1025, 8025],
};
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
export function ownership(item, project, kind) {
  const labels = kind === "container" ? item.Config.Labels : item.Labels;
  assert.equal(labels["com.docker.compose.project"], project);
  if (kind === "container")
    assert(services.includes(labels["com.docker.compose.service"]));
  if (kind === "volume")
    assert(
      ["pgdata", "miniodata", "redisdata"].includes(
        labels["com.docker.compose.volume"],
      ),
    );
  if (kind === "network")
    assert.equal(labels["com.docker.compose.network"], "default");
}
export function config(value, project, ports) {
  assert.equal(value.name, project);
  assert.deepEqual(Object.keys(value.services).sort(), [...services].sort());
  assert.equal(ports.length, 7);
  assert.equal(new Set(ports).size, 7);
  assert(
    ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535),
  );
  let index = 0;
  for (const [name, targets] of Object.entries(portLayout)) {
    const mappings = value.services[name].ports;
    assert.equal(mappings.length, targets.length);
    for (const [i, target] of targets.entries()) {
      const mapping = mappings[i];
      assert.equal(mapping.host_ip, "127.0.0.1");
      assert.equal(mapping.target, target);
      assert.equal(String(mapping.published), String(ports[index++]));
      assert.equal(mapping.protocol, "tcp");
    }
  }
  for (const [name, service] of Object.entries(value.services)) {
    assert(
      !service.container_name && !service.env_file && !service.network_mode,
    );
    assert.deepEqual(Object.keys(service.networks), ["default"]);
    if (!portLayout[name]) assert.equal((service.ports ?? []).length, 0);
    for (const mount of service.volumes ?? []) {
      assert.equal(mount.type, "volume");
      assert.equal(
        mount.source,
        name === "postgres"
          ? "pgdata"
          : name === "minio"
            ? "miniodata"
            : name === "redis"
              ? "redisdata"
              : "invalid",
      );
      assert.equal(
        mount.target,
        name === "postgres" ? "/var/lib/postgresql/data" : "/data",
      );
    }
  }
  assert.deepEqual(Object.keys(value.volumes).sort(), [
    "miniodata",
    "pgdata",
    "redisdata",
  ]);
  for (const name of ["postgres", "minio", "redis"])
    assert.equal(value.services[name].volumes.length, 1);
  for (const [name, volume] of Object.entries(value.volumes)) {
    assert(["pgdata", "miniodata", "redisdata"].includes(name));
    assert(!volume.external && !volume.driver_opts);
    assert.equal(volume.name, `${project}_${name}`);
  }
  assert.deepEqual(Object.keys(value.networks), ["default"]);
  assert(
    !value.networks.default.external && !value.networks.default.driver_opts,
  );
  assert.equal(value.networks.default.name, `${project}_default`);
  const env = value.services.server.environment;
  assert.equal(
    env.DATABASE_URL,
    "postgres://integration:integration-password@postgres:5432/mdcms_integration_test",
  );
  assert.equal(
    value.services["db-migrate"].environment.DATABASE_URL,
    env.DATABASE_URL,
  );
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.PORT, "4000");
  assert.equal(env.MDCMS_SERVER_URL, `http://127.0.0.1:${ports[0]}`);
  assert.equal(
    env.S3_PUBLIC_BASE_URL,
    `http://127.0.0.1:${ports[3]}/integration-test`,
  );
  assert.equal(env.REDIS_URL, "redis://redis:6379");
  assert.equal(env.S3_ENDPOINT, "http://minio:9000");
  assert.equal(env.SMTP_HOST, "mailhog");
  assert.equal(env.SMTP_PORT, "1025");
  assert.equal(env.MDCMS_STUDIO_ALLOWED_ORIGINS, env.MDCMS_SERVER_URL);
  assert.equal(env.MDCMS_COLLAB_ALLOWED_ORIGINS, env.MDCMS_SERVER_URL);
  assert.deepEqual(value.services.postgres.environment, {
    POSTGRES_USER: "integration",
    POSTGRES_PASSWORD: "integration-password",
    POSTGRES_DB: "mdcms_integration_test",
  });
  assert.deepEqual(value.services.postgres.healthcheck.test, [
    "CMD-SHELL",
    "pg_isready -U integration -d mdcms_integration_test",
  ]);
  assert.deepEqual(value.services.minio.environment, {
    MINIO_ROOT_USER: "integration",
    MINIO_ROOT_PASSWORD: "integration-password",
  });
  assert.deepEqual(value.services["minio-init"].environment, {
    S3_ENDPOINT: "http://minio:9000",
    S3_ACCESS_KEY: "integration",
    S3_SECRET_KEY: "integration-password",
    S3_BUCKET: "integration-test",
  });
  for (const key of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"])
    assert.equal(env[key], value.services["minio-init"].environment[key]);
  for (const key of [
    "AI_PROVIDER",
    "AI_MODEL",
    "GROQ_API_KEY",
    "GROQ_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
  ])
    assert.equal(env[key], "");
}
export function container(item, project, service, config) {
  ownership(item, project, "container");
  assert.equal(item.Config.Labels["com.docker.compose.service"], service);
  const expected = config.services[service];
  for (const [key, value] of Object.entries(expected.environment ?? {}))
    assert(item.Config.Env.includes(`${key}=${value}`));
  assert.equal(item.Mounts.length, (expected.volumes ?? []).length);
  for (const mount of item.Mounts) {
    const configured = expected.volumes.find(
      (volume) => volume.target === mount.Destination,
    );
    assert(configured);
    assert.equal(mount.Type, "volume");
    assert.equal(mount.Name, `${project}_${configured.source}`);
  }
  const state = item.State;
  if (["db-migrate", "minio-init"].includes(service)) {
    if (state.Status === "exited") {
      assert.equal(state.ExitCode, 0);
      return true;
    }
    assert(["created", "running"].includes(state.Status));
    return false;
  }
  assert(!["dead", "exited", "removing"].includes(state.Status));
  assert.notEqual(state.Health?.Status, "unhealthy");
  if (state.Status !== "running" || state.Health?.Status !== "healthy")
    return false;
  const actual = item.NetworkSettings.Ports;
  for (const mapping of expected.ports) {
    assert.deepEqual(actual[`${mapping.target}/tcp`], [
      { HostIp: "127.0.0.1", HostPort: String(mapping.published) },
    ]);
  }
  assert.equal(
    Object.values(actual).filter(Boolean).length,
    expected.ports.length,
  );
  return true;
}
if (process.argv[1]?.endsWith("validate-integration-stack.mjs")) {
  const [mode, path, project, extra, configPath] = process.argv.slice(2);
  try {
    if (mode === "version") {
      const match = readFileSync(path, "utf8")
        .trim()
        .match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
      assert(match);
      const [major, minor, patch] = match.slice(1).map(Number);
      assert(
        major > 2 ||
          (major === 2 && (minor > 24 || (minor === 24 && patch >= 4))),
      );
    } else if (mode === "config")
      config(
        read(path),
        project,
        readFileSync(extra, "utf8").trim().split("\n").map(Number),
      );
    else {
      const items = read(path);
      assert.equal(items.length, 1);
      if (mode === "ownership") ownership(items[0], project, extra);
      else if (!container(items[0], project, extra, read(configPath)))
        process.exit(2);
    }
  } catch {
    console.error(
      `Integration ${mode} validation failed${mode === "version" ? "; install Docker Compose 2.24.4 or later" : ""}`,
    );
    process.exit(1);
  }
}
