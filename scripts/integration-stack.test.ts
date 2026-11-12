import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("port allocator returns seven distinct loopback ephemeral ports", () => {
  const result = spawnSync(
    "node",
    ["scripts/lib/allocate-integration-ports.mjs"],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  const ports = result.stdout.trim().split("\n").map(Number);
  expect(ports).toHaveLength(7);
  expect(new Set(ports).size).toBe(7);
  expect(ports.every((port) => port > 0 && port <= 65535)).toBe(true);
});

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("sanitized compose uses explicit project/files and preserves failure on cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-harness-test-"));
  const trace = join(dir, "trace");
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> '${trace}'
if [[ -n "\${DATABASE_URL:-}\${COMPOSE_FILE:-}\${ANTHROPIC_API_KEY:-}" ]]; then exit 91; fi
case "$*" in
  *'version --short'*) echo 5.5.0 ;;
  *'config --format json'*) cat '${dir}/config' ;;
  *' down '*) exit 9 ;;
esac
`,
    { mode: 0o700 },
  );
  // Initialization must reject an invalid rendered config before startup or cleanup.
  writeFileSync(join(dir, "config"), "{}");
  const run = spawnSync(
    "bash",
    [
      "-c",
      "set -euo pipefail; source scripts/lib/integration-stack.sh; integration_init; integration_compose up -d",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DATABASE_URL: "poison",
        COMPOSE_FILE: "poison",
        ANTHROPIC_API_KEY: "poison",
      },
    },
  );
  expect(run.status).not.toBe(0);
  const lines = readFileSync(trace, "utf8").trim().split("\n");
  expect(lines.some((line) => line.includes("config --format json"))).toBe(
    true,
  );
  expect(
    lines.every((line) => !line.includes("up -d") && !line.includes("down")),
  ).toBe(true);
  for (const line of lines.filter(
    (line) => line.startsWith("compose ") && !line.includes("version"),
  )) {
    expect(line).toMatch(/-p mdcms-integration-[a-f0-9]+/);
    expect(line).toContain("docker-compose.integration.yml");
    expect(line).toContain("--env-file");
  }
  rmSync(dir, { recursive: true, force: true });
});

import {
  config as validateConfig,
  container as validateContainer,
} from "./lib/validate-integration-stack.mjs";

function fixture(project: string, ports: number[]) {
  const services: Record<string, any> = {};
  const layout: Record<string, number[]> = {
    server: [4000],
    postgres: [5432],
    redis: [6379],
    minio: [9000, 9001],
    mailhog: [1025, 8025],
    "db-migrate": [],
    "minio-init": [],
  };
  let index = 0;
  for (const [name, targets] of Object.entries(layout))
    services[name] = {
      networks: { default: null },
      environment: {},
      ports: targets.map((target) => ({
        host_ip: "127.0.0.1",
        target,
        published: String(ports[index++]),
        protocol: "tcp",
      })),
    };
  services.server.environment = {
    DATABASE_URL:
      "postgres://integration:integration-password@postgres:5432/mdcms_integration_test",
    NODE_ENV: "test",
    PORT: "4000",
    MDCMS_SERVER_URL: `http://127.0.0.1:${ports[0]}`,
    S3_PUBLIC_BASE_URL: `http://127.0.0.1:${ports[3]}/integration-test`,
    REDIS_URL: "redis://redis:6379",
    S3_ENDPOINT: "http://minio:9000",
    SMTP_HOST: "mailhog",
    SMTP_PORT: "1025",
    AI_PROVIDER: "",
    AI_MODEL: "",
    GROQ_API_KEY: "",
    GROQ_BASE_URL: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "",
  };
  services.server.environment.MDCMS_STUDIO_ALLOWED_ORIGINS =
    services.server.environment.MDCMS_SERVER_URL;
  services.server.environment.MDCMS_COLLAB_ALLOWED_ORIGINS =
    services.server.environment.MDCMS_SERVER_URL;
  for (const [service, source, target] of [
    ["postgres", "pgdata", "/var/lib/postgresql/data"],
    ["minio", "miniodata", "/data"],
    ["redis", "redisdata", "/data"],
  ])
    services[service!].volumes = [{ type: "volume", source, target }];
  services.postgres.environment = {
    POSTGRES_USER: "integration",
    POSTGRES_PASSWORD: "integration-password",
    POSTGRES_DB: "mdcms_integration_test",
  };
  services.postgres.healthcheck = {
    test: ["CMD-SHELL", "pg_isready -U integration -d mdcms_integration_test"],
  };
  services.minio.environment = {
    MINIO_ROOT_USER: "integration",
    MINIO_ROOT_PASSWORD: "integration-password",
  };
  services["minio-init"].environment = {
    S3_ENDPOINT: "http://minio:9000",
    S3_ACCESS_KEY: "integration",
    S3_SECRET_KEY: "integration-password",
    S3_BUCKET: "integration-test",
  };
  Object.assign(
    services.server.environment,
    services["minio-init"].environment,
  );
  services["db-migrate"].environment.DATABASE_URL =
    services.server.environment.DATABASE_URL;
  return {
    name: project,
    services,
    volumes: {
      pgdata: { name: `${project}_pgdata` },
      miniodata: { name: `${project}_miniodata` },
      redisdata: { name: `${project}_redisdata` },
    },
    networks: { default: { name: `${project}_default` } },
  };
}
const ports = [31001, 31002, 31003, 31004, 31005, 31006, 31007];
const project = "mdcms-integration-123";
function running(config: ReturnType<typeof fixture>, service = "server") {
  return {
    Config: {
      Labels: {
        "com.docker.compose.project": config.name,
        "com.docker.compose.service": service,
      },
      Env: Object.entries(config.services[service].environment).map(
        ([key, value]) => `${key}=${value}`,
      ),
    },
    Mounts: (config.services[service].volumes ?? []).map((v: any) => ({
      Type: "volume",
      Name: `${config.name}_${v.source}`,
      Destination: v.target,
    })),
    State: { Status: "running", Health: { Status: "healthy" }, ExitCode: 0 },
    NetworkSettings: {
      Ports: Object.fromEntries(
        config.services[service].ports.map((p: any) => [
          `${p.target}/tcp`,
          [{ HostIp: p.host_ip, HostPort: p.published }],
        ]),
      ),
    },
  };
}
test("configuration rejects wildcard ports, inherited endpoints and external resources", () => {
  validateConfig(fixture(project, ports), project, ports);
  const mutations = [
    (c: any) => (c.services.server.ports[0].host_ip = "0.0.0.0"),
    (c: any) =>
      c.services.server.ports.push({
        host_ip: "127.0.0.1",
        target: 4000,
        published: "4000",
      }),
    (c: any) =>
      (c.services.server.environment.DATABASE_URL = "postgres://production/db"),
    (c: any) => (c.services.server.environment.ANTHROPIC_API_KEY = "poison"),
    (c: any) =>
      (c.services.server.volumes = [
        { type: "bind", source: "/unrelated", target: "/data" },
      ]),
    (c: any) => (c.volumes.pgdata.external = true),
    (c: any) => (c.networks.default.external = true),
    (c: any) => (c.services.server.container_name = "presentation"),
  ];
  for (const mutate of mutations) {
    const c = fixture(project, ports);
    mutate(c);
    expect(() => validateConfig(c, project, ports)).toThrow();
  }
});
test("health requires matching labels, mappings, canonical URLs and healthy state", () => {
  const c = fixture(project, ports);
  expect(validateContainer(running(c), project, "server", c)).toBe(true);
  for (const mutate of [
    (i: any) => (i.Config.Labels["com.docker.compose.project"] = "other"),
    (i: any) => (i.Config.Labels["com.docker.compose.service"] = "postgres"),
    (i: any) => (i.NetworkSettings.Ports["4000/tcp"][0].HostPort = "4000"),
    (i: any) => (i.Config.Env = []),
    (i: any) =>
      i.Mounts.push({
        Type: "volume",
        Name: "anonymous",
        Destination: "/data",
      }),
    (i: any) => (i.State.Health.Status = "unhealthy"),
    (i: any) => (i.State.Status = "exited"),
  ]) {
    const item = running(c);
    mutate(item);
    expect(() => validateContainer(item, project, "server", c)).toThrow();
  }
  const noHealth = running(c);
  delete (noHealth.State as any).Health;
  expect(validateContainer(noHealth, project, "server", c)).toBe(false);
  const job = running(c, "db-migrate");
  job.State.Status = "exited";
  expect(validateContainer(job, project, "db-migrate", c)).toBe(true);
  job.State.ExitCode = 1;
  expect(() => validateContainer(job, project, "db-migrate", c)).toThrow();
});

function fakeRun(scenario: string, body = "integration_compose up -d; exit 0") {
  const dir = mkdtempSync(join(tmpdir(), "integration-harness-test-"));
  const trace = join(dir, "trace");
  writeFileSync(
    join(dir, "fixture.json"),
    JSON.stringify(fixture("PROJECT", ports)),
  );
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)}, scenario = ${JSON.stringify(scenario)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'trace'), JSON.stringify({args, env: process.env})+'\\n');
if (['DATABASE_URL','COMPOSE_FILE','COMPOSE_PROJECT_NAME','ANTHROPIC_API_KEY'].some(k => process.env[k])) process.exit(91);
if(args.includes('version')) { console.log('5.5.0'); process.exit(); }
const p = args[args.indexOf('-p')+1];
if(args.includes('config')) {
 const env = fs.readFileSync(args[args.indexOf('--env-file')+1], 'utf8');
 const ports = env.trim().split('\\n').map(l => Number(l.split('=')[1]));
 const c = JSON.parse(fs.readFileSync(path.join(dir,'fixture.json')));
 c.name = p; c.volumes.pgdata.name=p+'_pgdata'; c.volumes.miniodata.name=p+'_miniodata'; c.networks.default.name=p+'_default'; c.volumes.redisdata.name=p+'_redisdata';
 let index=0; for(const s of Object.values(c.services)) for(const port of s.ports) port.published=String(ports[index++]);
 c.services.server.environment.MDCMS_SERVER_URL='http://127.0.0.1:'+ports[0];
 c.services.server.environment.MDCMS_STUDIO_ALLOWED_ORIGINS=c.services.server.environment.MDCMS_SERVER_URL;
 c.services.server.environment.MDCMS_COLLAB_ALLOWED_ORIGINS=c.services.server.environment.MDCMS_SERVER_URL;
 c.services.server.environment.S3_PUBLIC_BASE_URL='http://127.0.0.1:'+ports[3]+'/integration-test';
 fs.writeFileSync(path.join(dir,'config'),JSON.stringify(c)); console.log(JSON.stringify(c));
} else if(args.includes('up')) {
 fs.writeFileSync(path.join(dir,'started'),'1');
 if(scenario==='startup-failure') process.exit(42);
 if(scenario==='bind-failure') {
   const net=require('node:net');
   const c=JSON.parse(fs.readFileSync(path.join(dir,'config')));
   const port=Number(c.services.server.ports[0].published);
   const blocker=net.createServer();
   blocker.listen(port,'127.0.0.1',()=>{
     const contender=net.createServer();
     contender.once('error',error=>process.exit(error.code==='EADDRINUSE'?42:92));
     contender.listen(port,'127.0.0.1',()=>process.exit(93));
   });
 }
} else if(args.includes('down')) {
 if(scenario==='cleanup-failure') process.exit(9);
 fs.rmSync(path.join(dir,'started'),{force:true});
} else if(args[0]==='ps') {
 if(scenario==='collision' || fs.existsSync(path.join(dir,'started'))) console.log('abc123');
} else if(args[0]==='container' && args[1]==='inspect') {
 const c=JSON.parse(fs.readFileSync(path.join(dir,'config')));
 console.log(JSON.stringify([{Config:{Labels:{'com.docker.compose.project':scenario==='ownership-mismatch'?'unrelated':c.name,'com.docker.compose.service':'server'}}}]));
} else if(args[0]==='compose' && args.includes('ps')) {
 if(scenario==='duplicate') console.log('abc123\\ndef456');
}
`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; source scripts/lib/integration-stack.sh; integration_init; ${body}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DATABASE_URL: "poison",
        COMPOSE_FILE: "poison",
        COMPOSE_PROJECT_NAME: "poison",
        ANTHROPIC_API_KEY: "poison",
      },
    },
  );
  const lines = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  for (const { args } of lines.filter(
    (l) => l.args[0] === "compose" && !l.args.includes("version"),
  )) {
    expect(args[args.indexOf("-p") + 1]).toMatch(
      /^mdcms-integration-[a-f0-9]{24}$/,
    );
    expect(args.filter((a: string) => a === "-f")).toHaveLength(2);
    expect(args).toContain("--env-file");
  }
  const envFile = lines.find((l) => l.args.includes("--env-file"))?.args;
  if (envFile)
    expect(() =>
      readFileSync(envFile[envFile.indexOf("--env-file") + 1]),
    ).toThrow();
  rmSync(dir, { recursive: true, force: true });
  return { result, commands: lines.map((l) => l.args.join(" ")) };
}
for (const [scenario, body, status] of [
  ["success", "integration_compose up -d", 0],
  ["startup-failure", "integration_compose up -d", 42],
  ["bind-failure", "integration_compose up -d", 42],
  ["assertion-failure", "integration_compose up -d; exit 7", 7],
  ["interrupt", "integration_compose up -d; kill -INT $$", 130],
  ["terminate", "integration_compose up -d; kill -TERM $$", 143],
  ["cleanup-failure", "integration_compose up -d", 9],
  ["cleanup-failure", "integration_compose up -d; exit 7", 7],
  ["missing", "integration_wait server", 1],
  ["duplicate", "integration_wait server", 1],
] as const)
  test(`fake Docker ${scenario}: exit ${status}`, () => {
    const { result, commands } = fakeRun(scenario, body);
    expect(result.status).toBe(status);
    expect(commands.filter((c) => c.includes(" down "))).toHaveLength(1);
  });
for (const scenario of ["collision", "ownership-mismatch"])
  test(`never delete on ${scenario}`, () => {
    const { result, commands } = fakeRun(scenario);
    expect(result.status).not.toBe(0);
    expect(commands.some((c) => c.includes(" down "))).toBe(false);
  });

test("recreation retains the exact project, env file and port configuration", () => {
  const { result, commands } = fakeRun(
    "restart",
    "integration_compose up -d; integration_down; integration_compose up -d",
  );
  expect(result.status).toBe(0);
  const ups = commands.filter((c) => c.endsWith(" up -d"));
  expect(ups).toHaveLength(2);
  expect(ups[0]).toBe(ups[1]);
  expect(
    commands.filter((c) => c.endsWith("config --format json")),
  ).toHaveLength(1);
  expect(commands.filter((c) => c.endsWith("down --volumes"))).toHaveLength(1);
});

test("unsupported Compose versions fail before resource creation", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-version-"));
  try {
    for (const [version, status] of [
      ["2.24.3", 1],
      ["1.29.2", 1],
      ["garbage", 1],
      ["2.24.4", 0],
      ["5.5.0", 0],
    ] as const) {
      writeFileSync(join(dir, "version"), version);
      const result = spawnSync("node", [
        "scripts/lib/validate-integration-stack.mjs",
        "version",
        join(dir, "version"),
      ]);
      expect(result.status).toBe(status);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nested Bun suite invocation does not load repository dotenv credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-dotenv-"));
  try {
    writeFileSync(join(dir, ".env"), "MDCMS_ISOLATION_POISON=poison\n");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { suite: "bun test fixture.test.ts" } }),
    );
    writeFileSync(
      join(dir, "fixture.test.ts"),
      'import { test, expect } from "bun:test"; test("clean", () => expect(process.env.MDCMS_ISOLATION_POISON).toBeUndefined());',
    );
    const result = spawnSync(
      process.execPath,
      ["--no-env-file", "run", "--cwd", dir, "suite", "--no-env-file"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health curl ignores poisoned default configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-curl-config-"));
  const requests: Array<{ target: string; header: string | null }> = [];
  const intended = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        target: "intended",
        header: request.headers.get("x-poison"),
      });
      return Response.json({ status: "ok" });
    },
  });
  const unrelated = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        target: "unrelated",
        header: request.headers.get("x-poison"),
      });
      return Response.json({ status: "ok" });
    },
  });
  try {
    writeFileSync(
      join(dir, ".curlrc"),
      [
        `connect-to = "127.0.0.1:${intended.port}:127.0.0.1:${unrelated.port}"`,
        `url = "http://127.0.0.1:${unrelated.port}/unexpected"`,
        'header = "X-Poison: injected"',
        "",
      ].join("\n"),
    );
    const child = Bun.spawn(
      [
        "bash",
        "-c",
        [
          "set -euo pipefail",
          "source scripts/lib/integration-stack.sh",
          // CURL_HOME selects the fixture without reading the operator's real config.
          'integration_clean_env+=("CURL_HOME=$INTEGRATION_CURL_FIXTURE")',
          "integration_wait() { :; }",
          "verify_server_health",
        ].join("; "),
      ],
      {
        env: {
          ...process.env,
          INTEGRATION_CURL_FIXTURE: dir,
          INTEGRATION_SERVER_URL: `http://127.0.0.1:${intended.port}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    expect(requests).toEqual([{ target: "intended", header: null }]);
  } finally {
    intended.stop(true);
    unrelated.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
