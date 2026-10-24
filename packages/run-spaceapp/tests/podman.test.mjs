import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  applyConfigRepairs,
  composeCommand,
  createDefaultConfig,
  initializeInstallation,
  loadConfig,
  planConfigRepairs,
  prepareInstallation,
  renderWorkspaceCompose,
  resolveInstallEngine,
  saveConfig,
  validateConfig
} from "../src/index.mjs";
import {
  ensureDockerAvailable,
  inspectContainerEngine,
  inspectPodmanEnvironment,
  parsePodmanVersion,
  validatePodmanMachineResources
} from "../src/prerequisites.mjs";
import { inspectStoragePlan } from "../src/storage.mjs";

const launcherManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const CURRENT_VERSION = launcherManifest.version;
const RUNTIME_VERSION = launcherManifest.spaceappRuntimeVersion;

/**
 * Creates a writable capture stream for test assertions.
 *
 * @returns {{ stream: Writable, value: () => string }} Capture stream and reader.
 */
function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

/**
 * Creates a fake Podman command executor with healthy rootless cgroup v2 defaults.
 *
 * @param {object} [overrides={}] - Custom Podman info or command behaviors.
 * @returns {{ calls: object[], execute: Function }} Recorded calls and executor.
 */
function createPodmanExecutor(overrides = {}) {
  const calls = [];
  const podmanInfo = {
    host: {
      arch: "amd64",
      cpus: 8,
      memTotal: 16 * 1024 ** 3,
      cgroupVersion: "v2",
      cgroupControllers: ["cpu", "cpuset", "io", "memory", "pids"],
      security: {
        rootless: true
      },
      ...overrides.host
    },
    store: {
      graphRoot: "/tmp/podman-storage",
      ...overrides.store
    },
    version: {
      Version: overrides.version ?? "5.2.1"
    }
  };

  const execute = async (spec, io = {}) => {
    calls.push(spec);
    if (typeof overrides.onCommand === "function") {
      const custom = await overrides.onCommand(spec, io);
      if (custom !== undefined) {
        return custom;
      }
    }
    if (spec.command === "docker") {
      throw new Error(`Unexpected docker command in Podman mode: ${spec.args?.join(" ")}`);
    }
    if (spec.command === "podman" && spec.args[0] === "--version") {
      io.stdout?.write(`podman version ${podmanInfo.version.Version}\n`);
      return overrides.cliCode ?? 0;
    }
    if (spec.command === "podman" && spec.args[0] === "compose" && spec.args[1] === "version") {
      io.stdout?.write("podman compose version 1.2.0\n");
      return overrides.composeCode ?? 0;
    }
    if (spec.command === "podman" && spec.args[0] === "info") {
      if ((overrides.infoCode ?? 0) === 0) {
        io.stdout?.write(`${JSON.stringify(podmanInfo)}\n`);
      }
      return overrides.infoCode ?? 0;
    }
    if (spec.command === "podman" && spec.args[0] === "machine" && spec.args[1] === "inspect") {
      const machinePayload = overrides.machineInspect ?? [
        {
          Name: "podman-machine-default",
          State: "running",
          Resources: {
            CPUs: 4,
            Memory: 8192,
            DiskSize: 40
          }
        }
      ];
      io.stdout?.write(`${JSON.stringify(machinePayload)}\n`);
      return overrides.machineCode ?? 0;
    }
    if (spec.command === "podman" && spec.args[0] === "image" && spec.args[1] === "inspect") {
      io.stdout?.write("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t104857600\n");
      return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "compose" && spec.args.includes("checkpointDump")) {
      io.stdout?.write("PGDMP-CHECKPOINT");
      return 0;
    }
    if (spec.command === "podman" && spec.args.includes("pg_dump")) {
      io.stdout?.write("PGDMP-CHECKPOINT");
      return 0;
    }
    return 0;
  };

  return { calls, execute };
}

test("resolveInstallEngine, config validation, and config repairs support docker and podman", () => {
  assert.equal(resolveInstallEngine(undefined), "docker");
  assert.equal(resolveInstallEngine(undefined, "podman"), "podman");
  assert.equal(resolveInstallEngine("docker"), "docker");
  assert.equal(resolveInstallEngine("podman"), "podman");
  assert.throws(() => resolveInstallEngine("containerd"), /Container engine must be docker or podman/);

  const defaultConfig = createDefaultConfig({ version: "0.7.0", profile: "small" });
  assert.equal(defaultConfig.engine, undefined);
  assert.ok(validateConfig(defaultConfig));

  const podmanConfig = createDefaultConfig({ version: "0.7.0", profile: "small", engine: "podman" });
  assert.equal(podmanConfig.engine, "podman");
  assert.ok(validateConfig(podmanConfig));

  assert.throws(
    () => validateConfig({ ...podmanConfig, accessMode: "host-root" }),
    /Host-root access is not supported with Podman/
  );
  assert.throws(
    () => validateConfig({ ...podmanConfig, engine: "rkt" }),
    /engine must be docker or podman/
  );

  const repairs = planConfigRepairs({
    ...podmanConfig,
    engine: "invalid-engine"
  });
  assert.equal(repairs.actions.some((item) => item.type === "reset-invalid-engine"), true);
  const repaired = applyConfigRepairs({
    ...podmanConfig,
    engine: "invalid-engine"
  });
  assert.equal(repaired.engine, "docker");
});

test("renderWorkspaceCompose adds rootless Podman userns_mode and SELinux z flags only when engine is podman", () => {
  const baseConfig = {
    ...createDefaultConfig({
      version: "0.7.0",
      profile: "small"
    }),
    workspaces: [
      { id: "alpha-12345678", name: "alpha", hostPath: "/home/dev/alpha", containerPath: "/workspaces/alpha-12345678", readOnly: false },
      { id: "docs-87654321", name: "docs", hostPath: "/home/dev/docs", containerPath: "/workspaces/docs-87654321", readOnly: true }
    ],
    users: [
      { id: "user:alice", memoryLimit: "2g", workspaces: [] }
    ]
  };

  const dockerCompose = renderWorkspaceCompose(baseConfig);
  assert.doesNotMatch(dockerCompose, /userns_mode:/);
  assert.doesNotMatch(dockerCompose, /selinux: z/);
  assert.match(dockerCompose, /\.\/cli-hosts\.json:\/etc\/spaceapp\/cli-hosts\.json:ro\n/);
  assert.match(dockerCompose, /\.\/secrets\/users\/alice-dabd1d\/providers:\/run\/spaceapp-secrets\/providers:ro\n/);

  const podmanCompose = renderWorkspaceCompose({ ...baseConfig, engine: "podman" });
  assert.match(
    podmanCompose,
    /spaceapp-core:\n    userns_mode: "keep-id:uid=10001,gid=10001"/
  );
  assert.match(
    podmanCompose,
    /spaceapp-cli:\n    userns_mode: "keep-id:uid=10001,gid=10001"/
  );
  assert.match(
    podmanCompose,
    /codex-sessions-init:\n    userns_mode: "keep-id:uid=10001,gid=10001"/
  );
  assert.match(
    podmanCompose,
    /spaceapp-cli-alice-dabd1d:[\s\S]*?userns_mode: "keep-id:uid=10001,gid=10001"/
  );
  assert.match(podmanCompose, /bind:\n          selinux: z/);
  assert.match(podmanCompose, /\.\/cli-hosts\.json:\/etc\/spaceapp\/cli-hosts\.json:ro,z\n/);
  assert.match(podmanCompose, /\.\/secrets\/users\/alice-dabd1d\/providers:\/run\/spaceapp-secrets\/providers:ro,z\n/);
});

test("prepareInstallation persists engine=podman and blocks switching engines in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-prepare-"));
  try {
    const prepared = await prepareInstallation(root, {
      version: "0.7.0",
      profile: "small",
      engine: "podman"
    });
    assert.equal(prepared.config.engine, "podman");

    const saved = await initializeInstallation(root, {
      version: "0.7.0",
      profile: "small",
      engine: "podman"
    });
    assert.equal(saved.config.engine, "podman");

    await assert.rejects(
      () => prepareInstallation(root, {
        version: "0.7.0",
        profile: "small",
        engine: "docker"
      }),
      /switching to docker in place is not supported/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composeCommand uses podman compose when engine is podman", () => {
  const root = "/tmp/spaceapp-podman-root";
  for (const action of ["up", "down", "status", "logs", "pull", "backup", "purge", "repair"]) {
    const spec = composeCommand(action, root, { profile: "small", engine: "podman" });
    assert.equal(spec.command, "podman");
    assert.equal(spec.args[0], "compose");
  }
  const dockerSpec = composeCommand("up", root, { profile: "small" });
  assert.equal(dockerSpec.command, "docker");
});

test("inspectStoragePlan uses podman info --format json and parses graphRoot and host resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-storage-"));
  try {
    const { calls, execute } = createPodmanExecutor({
      store: { graphRoot: root },
      host: { cpus: 6, memTotal: 12 * 1024 ** 3, arch: "amd64" }
    });
    const plan = await inspectStoragePlan({
      root,
      config: { version: "0.7.0", profile: "small", engine: "podman" },
      resources: {
        cpuCount: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        freeDiskBytes: 30 * 1024 ** 3
      },
      execute,
      operation: "fresh"
    });
    assert.equal(calls.every((spec) => spec.command === "podman"), true);
    assert.equal(
      calls.some((spec) => spec.args[0] === "info" && spec.args[1] === "--format" && spec.args[2] === "json"),
      true
    );
    assert.equal(typeof plan.dockerFreeDiskBytes, "number");
    assert.equal(plan.resources.engineCpuCount, 6);
    assert.equal(plan.resources.engineMemoryBytes, 12 * 1024 ** 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectPodmanEnvironment and ensureDockerAvailable validate rootless Podman, cgroup v2, and macOS machine limits", async () => {
  assert.deepEqual(parsePodmanVersion("podman version 5.2.1"), {
    raw: "podman version 5.2.1",
    version: "5.2.1",
    major: 5,
    minor: 2,
    patch: 1
  });

  const healthy = createPodmanExecutor();
  const envReport = await inspectPodmanEnvironment({
    execute: healthy.execute,
    platform: "linux"
  });
  assert.equal(envReport.ready, true);
  assert.equal(envReport.mode, "rootless");
  assert.equal(envReport.cgroupVersion, "v2");
  assert.equal(envReport.cpuDelegated, true);
  assert.equal(envReport.memoryDelegated, true);

  const missingDelegation = createPodmanExecutor({
    host: {
      cgroupVersion: "v2",
      cgroupControllers: ["pids"]
    }
  });
  const stderrDelegation = capture();
  const delegationResult = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: {},
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: stderrDelegation.stream,
    execute: missingDelegation.execute,
    engine: "podman",
    installArgs: { requestedEngine: "podman", requestedProfile: "small" }
  });
  assert.equal(delegationResult.code, 1);
  assert.match(stderrDelegation.value(), /delegate\.conf/);
  assert.match(stderrDelegation.value(), /cpu controller, memory controller/);

  const macUndersized = createPodmanExecutor({
    machineInspect: [
      {
        Name: "podman-machine-default",
        State: "running",
        Resources: {
          CPUs: 2,
          Memory: 2048,
          DiskSize: 10
        }
      }
    ]
  });
  const stderrMac = capture();
  const macCheck = await validatePodmanMachineResources({
    execute: macUndersized.execute,
    profile: "small",
    stderr: stderrMac.stream
  });
  assert.equal(macCheck.ok, false);
  assert.match(
    stderrMac.value(),
    /podman machine stop && podman machine set --cpus 4 --memory 7168 --disk-size 20 && podman machine start/
  );

  const stderrWin = capture();
  const winResult = await ensureDockerAvailable({
    platform: "win32",
    arch: "x64",
    env: {},
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: stderrWin.stream,
    execute: healthy.execute,
    engine: "podman"
  });
  assert.equal(winResult.code, 1);
  assert.match(stderrWin.value(), /Podman is only supported on Linux and macOS/);
});

test("CLI install, doctor, support-bundle, repair, update, factory-reset, and failed-install rollback preserve engine=podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-cli-"));
  try {
    const { calls, execute } = createPodmanExecutor({
      store: { graphRoot: root }
    });
    const stdout = capture();
    const stderr = capture();

    const installCode = await run(
      [
        "install",
        "--engine",
        "podman",
        "--profile",
        "small",
        "--access",
        "isolated",
        "--no-open",
        "--non-interactive",
        "--answers",
        JSON.stringify({
          confirm: true,
          profile: "small",
          access: "isolated",
          companions: false,
          telemetry: false,
          open: false
        })
      ],
      {
        env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
        platform: "linux",
        arch: "x64",
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
        execute,
        inspectResources: async () => ({
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeDiskBytes: 30 * 1024 ** 3
        }),
        prepareDockerPath: async () => {},
        request: async (url) => ({
          ok: true,
          status: 200,
          async json() {
            if (String(url).endsWith("/api/setup/status")) {
              return { setupRequired: true, expiresAt: null };
            }
            return { ok: true };
          }
        }),
        sleep: async () => {},
        launcherVersion: CURRENT_VERSION,
        runtimeVersion: RUNTIME_VERSION
      }
    );
    assert.equal(installCode, 0, stderr.value());
    const installedConfig = await loadConfig(root);
    assert.equal(installedConfig.engine, "podman");
    assert.equal(calls.every((spec) => spec.command === "podman"), true);

    const workspaceCompose = await readFile(join(root, "compose.workspaces.yml"), "utf8");
    assert.match(workspaceCompose, /userns_mode: "keep-id:uid=10001,gid=10001"/);

    // Doctor reports Podman CLI, Podman Compose, and Podman Engine with mode, cgroup, and controller delegation
    const doctorOut = capture();
    const doctorErr = capture();
    const doctorCode = await run(["doctor"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      arch: "x64",
      stdin: Readable.from([]),
      stdout: doctorOut.stream,
      stderr: doctorErr.stream,
      execute,
      inspectResources: async () => ({
        cpuCount: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        freeDiskBytes: 30 * 1024 ** 3
      }),
      prepareDockerPath: async () => {}
    });
    assert.equal(doctorCode, 0, doctorErr.value());
    assert.match(doctorOut.value(), /PASS Podman CLI: available \(engine=podman, version=5\.2\.1\)/);
    assert.match(doctorOut.value(), /PASS Podman Compose: available/);
    assert.match(
      doctorOut.value(),
      /PASS Podman Engine: available \(engine=podman, version=5\.2\.1, mode=rootless, cgroup=v2, cpuLimit=delegated, memoryLimit=delegated\)/
    );

    // Support bundle includes containerEngine and installation.config.engine === "podman"
    const bundlePath = join(root, "support-bundle.json");
    const bundleCode = await run(["support-bundle", "--out", bundlePath], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      arch: "x64",
      stdin: Readable.from([]),
      stdout: capture().stream,
      stderr: capture().stream,
      execute,
      prepareDockerPath: async () => {},
      request: async () => ({ ok: true, status: 200, async json() { return { ok: true }; } })
    });
    assert.equal(bundleCode, 0);
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    assert.equal(bundle.installation.config.engine, "podman");
    assert.deepEqual(bundle.containerEngine, {
      engine: "podman",
      ready: true,
      version: "5.2.1",
      mode: "rootless",
      cgroupVersion: "v2",
      limits: {
        cpuDelegated: true,
        memoryDelegated: true
      }
    });

    // Repair preserves engine=podman and calls only podman
    const repairCode = await run(
      ["repair", "--non-interactive", "--answers", JSON.stringify({ confirm: true })],
      {
        env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
        platform: "linux",
        arch: "x64",
        stdin: Readable.from([]),
        stdout: capture().stream,
        stderr: capture().stream,
        execute,
        inspectResources: async () => ({
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeDiskBytes: 30 * 1024 ** 3
        }),
        prepareDockerPath: async () => {},
        request: async (url) => ({
          ok: true,
          status: 200,
          async json() {
            if (String(url).endsWith("/api/setup/status")) {
              return { setupRequired: true, expiresAt: null };
            }
            return { ok: true };
          }
        }),
        sleep: async () => {}
      }
    );
    assert.equal(repairCode, 0);
    assert.equal((await loadConfig(root)).engine, "podman");

    // Factory-reset preserves engine=podman
    const resetStdin = Readable.from(["y\nFACTORY-RESET\n"]);
    resetStdin.isTTY = true;
    resetStdin.setRawMode = () => {};
    const resetCode = await run(
      ["factory-reset"],
      {
        env: { SPACEAPP_HOME: root },
        platform: "linux",
        arch: "x64",
        stdin: resetStdin,
        stdout: capture().stream,
        stderr: capture().stream,
        execute,
        prepareDockerPath: async () => {},
        runtimeVersion: RUNTIME_VERSION
      }
    );
    assert.equal(resetCode, 0);
    assert.equal((await loadConfig(root)).engine, "podman");
    assert.equal(calls.every((spec) => spec.command === "podman"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Podman install diagnostics, rollback, and uninstall --purge-data never invoke docker", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-rollback-"));
  try {
    const { calls, execute } = createPodmanExecutor();
    let failReadiness = false;

    // Initial successful install with Podman
    const initialCode = await run(
      [
        "install",
        "--engine",
        "podman",
        "--profile",
        "small",
        "--access",
        "isolated",
        "--no-open",
        "--non-interactive",
        "--answers",
        JSON.stringify({
          confirm: true,
          profile: "small",
          access: "isolated",
          companions: false,
          telemetry: false,
          open: false
        })
      ],
      {
        env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
        platform: "linux",
        arch: "x64",
        stdin: Readable.from([]),
        stdout: capture().stream,
        stderr: capture().stream,
        execute,
        inspectResources: async () => ({
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeDiskBytes: 30 * 1024 ** 3
        }),
        prepareDockerPath: async () => {},
        request: async (url) => ({
          ok: true,
          status: 200,
          async json() {
            if (String(url).endsWith("/api/setup/status")) {
              return { setupRequired: true, expiresAt: null };
            }
            return { ok: true };
          }
        }),
        sleep: async () => {},
        launcherVersion: CURRENT_VERSION,
        runtimeVersion: RUNTIME_VERSION
      }
    );
    assert.equal(initialCode, 0);

    // Failed subsequent install triggers reportInstallDiagnostics and restoreRuntimeAfterFailedInstall
    failReadiness = true;
    const failedErr = capture();
    const failedCode = await run(
      [
        "install",
        "--engine",
        "podman",
        "--profile",
        "standard",
        "--access",
        "isolated",
        "--no-open",
        "--non-interactive",
        "--answers",
        JSON.stringify({
          confirm: true,
          profile: "standard",
          access: "isolated",
          companions: false,
          telemetry: false,
          open: false
        })
      ],
      {
        env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
        platform: "linux",
        arch: "x64",
        stdin: Readable.from([]),
        stdout: capture().stream,
        stderr: failedErr.stream,
        execute,
        inspectResources: async () => ({
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeDiskBytes: 30 * 1024 ** 3
        }),
        prepareDockerPath: async () => {},
        request: async () => {
          if (failReadiness) {
            throw new Error("readiness timeout");
          }
          return { ok: true, status: 200, async json() { return { ok: true }; } };
        },
        sleep: async () => {},
        launcherVersion: CURRENT_VERSION,
        runtimeVersion: RUNTIME_VERSION
      }
    );
    assert.equal(failedCode, 1);
    assert.match(failedErr.value(), /The previous SpaceApp runtime and access mode were restored/);
    assert.equal((await loadConfig(root)).engine, "podman");
    assert.equal((await loadConfig(root)).profile, "small");

    // Uninstall --purge-data uses podman compose down --volumes --remove-orphans
    const uninstallStdin = Readable.from(["DELETE\n"]);
    uninstallStdin.isTTY = true;
    uninstallStdin.setRawMode = () => {};
    const uninstallCode = await run(
      ["uninstall", "--purge-data"],
      {
        env: { SPACEAPP_HOME: root },
        platform: "linux",
        arch: "x64",
        stdin: uninstallStdin,
        stdout: capture().stream,
        stderr: capture().stream,
        execute,
        prepareDockerPath: async () => {}
      }
    );
    assert.equal(uninstallCode, 0);
    assert.equal(calls.every((spec) => spec.command === "podman"), true);
    assert.equal(
      calls.some((spec) => spec.args.includes("down") && spec.args.includes("--volumes")),
      true
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
