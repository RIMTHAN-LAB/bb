import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const helperUrl = new URL("../scripts/smoke-processes.mjs", import.meta.url).href;

async function runFixture(scenario: string): Promise<unknown> {
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedProcesses, waitForProcessExit } from ${JSON.stringify(helperUrl)};
const root = await mkdtemp(join(tmpdir(), "bb-smoke-processes-"));
const manager = createManagedProcesses({ cwd: root });
const refs = [];
const controls = [];
const originalKill = process.kill;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (pid) => {
  try { originalKill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
const waitUntil = async (predicate) => {
  const deadline = performance.now() + 2_000;
  for (let attempt = 0; attempt < 100 && performance.now() < deadline; attempt += 1) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Process fixture deadline exhausted");
};
const timeouts = { interruptTimeoutMs: 200, terminateTimeoutMs: 200, killTimeoutMs: 1_000 };
const service = String.raw\`
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const root = process.env.FIXTURE_ROOT;
  let stopping = false;
  const stop = (signal) => {
    writeFileSync(join(root, signal), "observed");
    if (process.env.FIXTURE_MODE === "resistant" || stopping) return;
    stopping = true;
    setTimeout(() => {
      mkdirSync(join(root, "plugins", "fixture", "logs"), { recursive: true });
      writeFileSync(join(root, "plugins", "fixture", "logs", "plugin.log"), "dispose");
      writeFileSync(join(root, "late-write"), "observed");
    }, 100);
    setTimeout(() => process.exit(0), 180);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  setInterval(() => {}, 1_000);
  writeFileSync(join(root, "ready.json"), JSON.stringify({ pid: process.pid }));
\`;
const startFamily = async (mode, exitEarly = false) => {
  const launcher = \`
    const { spawn } = require("node:child_process");
    const { existsSync } = require("node:fs");
    const { join } = require("node:path");
    const child = spawn(process.execPath, ["-e", \${JSON.stringify(service)}], {
      env: process.env, stdio: "ignore"
    });
    child.once("exit", (code) => { process.exitCode = code ?? 128; });
    if (process.env.FIXTURE_EXIT_EARLY === "true") {
      const timer = setInterval(() => {
        if (!existsSync(join(process.env.FIXTURE_ROOT, "ready.json"))) return;
        clearInterval(timer); process.exit(0);
      }, 10);
    }
  \`;
  const ref = manager.spawnManagedProcess({
    command: process.execPath, args: ["-e", launcher], label: "fixture launcher",
    env: { FIXTURE_ROOT: root, FIXTURE_MODE: mode, FIXTURE_EXIT_EARLY: String(exitEarly) }
  });
  refs.push(ref);
  await waitUntil(() => existsSync(join(root, "ready.json")));
  const { pid } = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"));
  return { ref, pid };
};
try {
  ${scenario}
} finally {
  process.kill = originalKill;
  for (const ref of refs) {
    if (exists(-ref.groupId)) originalKill(-ref.groupId, "SIGKILL");
    await waitUntil(() => !exists(-ref.groupId));
    await waitForProcessExit(ref.childProcess);
  }
  for (const control of controls) {
    if (exists(control.pid)) originalKill(control.pid, "SIGKILL");
    await waitForProcessExit(control);
  }
  await rm(root, { force: true, recursive: true });
}
`,
    ],
    { timeout: 10_000, maxBuffer: 64 << 10 },
  );
  const result: unknown = JSON.parse(stdout);
  return result;
}

describe.skipIf(process.platform === "win32")("owned smoke process teardown", () => {
  it("waits for a descendant's delayed plugin write and exit after its launcher dies", async () => {
    const result = await runFixture(`
      const { ref, pid } = await startFamily("graceful");
      const stop = manager.stopManagedProcess(ref, timeouts);
      await waitForProcessExit(ref.childProcess);
      assert.equal(exists(pid), true);
      await stop;
      assert.equal(readFileSync(join(root, "late-write"), "utf8"), "observed");
      assert.equal(exists(pid), false);
      assert.equal(exists(-ref.groupId), false);
      await manager.cleanupTemporaryRoot(timeouts);
      await delay(200);
      assert.equal(existsSync(root), false);
      console.log(JSON.stringify({ descendantExited: true, lateWriteFinished: true, temporaryRootRemoved: true }));
    `);
    expect(result).toMatchObject({
      descendantExited: true,
      lateWriteFinished: true,
      temporaryRootRemoved: true,
    });
  });

  it("stops a live descendant even when the launcher exited before cleanup began", async () => {
    const result = await runFixture(`
      const { ref, pid } = await startFamily("graceful", true);
      await waitForProcessExit(ref.childProcess);
      assert.equal(exists(pid), true);
      await manager.stopManagedProcess(ref, timeouts);
      assert.equal(exists(pid), false);
      assert.equal(exists(-ref.groupId), false);
      console.log(JSON.stringify({ alreadyExitedLauncher: true, descendantExited: true }));
    `);
    expect(result).toMatchObject({
      alreadyExitedLauncher: true,
      descendantExited: true,
    });
  });

  it("escalates a descendant that ignores both interrupt and termination", async () => {
    const result = await runFixture(`
      const { ref, pid } = await startFamily("resistant");
      const started = performance.now();
      await manager.stopManagedProcess(ref, timeouts);
      assert.equal(existsSync(join(root, "SIGINT")), true);
      assert.equal(existsSync(join(root, "SIGTERM")), true);
      assert.equal(exists(pid), false);
      assert.equal(exists(-ref.groupId), false);
      assert.ok(performance.now() - started < 2_000);
      console.log(JSON.stringify({ interruptObserved: true, terminationObserved: true, resistantDescendantExited: true }));
    `);
    expect(result).toMatchObject({
      interruptObserved: true,
      terminationObserved: true,
      resistantDescendantExited: true,
    });
  });

  it("accepts an already terminated group repeatedly and preserves an unrelated control", async () => {
    const result = await runFixture(`
      const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      controls.push(control);
      const ref = manager.spawnManagedProcess({ command: process.execPath, args: ["-e", "process.exit(0)"], label: "finished launcher" });
      refs.push(ref);
      await waitForProcessExit(ref.childProcess);
      await waitUntil(() => !exists(-ref.groupId));
      await manager.stopManagedProcess(ref, timeouts);
      await manager.stopManagedProcess(ref, timeouts);
      await manager.cleanupTemporaryRoot(timeouts);
      assert.equal(exists(control.pid), true);
      assert.equal(exists(process.pid), true);
      assert.equal(existsSync(root), false);
      console.log(JSON.stringify({ repeatedCleanupAccepted: true, unrelatedControlSurvived: true, invokingProcessSurvived: true }));
    `);
    expect(result).toMatchObject({
      repeatedCleanupAccepted: true,
      unrelatedControlSurvived: true,
      invokingProcessSurvived: true,
    });
  });

  it("refuses unproved termination within finite deadlines and retains the owned root without repeating signals", async () => {
    const result = await runFixture(`
      const { ref, pid } = await startFamily("resistant");
      writeFileSync(join(root, "protected-data"), "keep");
      const signals = [];
      process.kill = (target, signal) => {
        if (target === -ref.groupId && signal !== 0) { signals.push(signal); return true; }
        return originalKill(target, signal);
      };
      const shortTimeouts = { interruptTimeoutMs: 50, terminateTimeoutMs: 50, killTimeoutMs: 50 };
      const started = performance.now();
      await assert.rejects(manager.stopManagedProcess(ref, shortTimeouts), /Could not prove/);
      assert.ok(performance.now() - started < 1_000);
      assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
      await assert.rejects(manager.cleanupTemporaryRoot(shortTimeouts), (error) => error.message.includes("retained owned temporary root " + root));
      assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
      assert.equal(readFileSync(join(root, "protected-data"), "utf8"), "keep");
      assert.equal(exists(pid), true);
      console.log(JSON.stringify({ boundedRefusal: true, rootRetained: true, noRepeatedSignals: true, liveWriterNotConcealed: true }));
    `);
    expect(result).toMatchObject({
      boundedRefusal: true,
      rootRetained: true,
      noRepeatedSignals: true,
      liveWriterNotConcealed: true,
    });
  });

  it("waits through transient zero-signal permission errors until the real group disappears", async () => {
    const result = await runFixture(`
      const { ref, pid } = await startFamily("graceful");
      let interrupted = false;
      let deniedProbes = 0;
      let disappearanceObserved = false;
      process.kill = (target, signal) => {
        if (target === -ref.groupId && signal === "SIGINT") interrupted = true;
        if (target === -ref.groupId && signal === 0 && interrupted && deniedProbes < 4) {
          deniedProbes += 1;
          throw Object.assign(new Error("probe permission denied"), { code: "EPERM" });
        }
        try { return originalKill(target, signal); }
        catch (error) {
          if (target === -ref.groupId && signal === 0 && error.code === "ESRCH") disappearanceObserved = true;
          throw error;
        }
      };
      await manager.stopManagedProcess(ref, { ...timeouts, interruptTimeoutMs: 400 });
      assert.equal(deniedProbes, 4);
      assert.equal(disappearanceObserved, true);
      assert.ok(ref.childProcess.exitCode !== null || ref.childProcess.signalCode !== null);
      assert.equal(exists(pid), false);
      assert.equal(exists(-ref.groupId), false);
      assert.equal(readFileSync(join(root, "late-write"), "utf8"), "observed");
      await manager.cleanupTemporaryRoot(timeouts);
      assert.equal(existsSync(root), false);
      console.log(JSON.stringify({ transientProbesWaited: true, realDisappearanceObserved: true, launcherReaped: true, lateWriteFinished: true, temporaryRootRemoved: true }));
    `);
    expect(result).toMatchObject({
      transientProbesWaited: true,
      realDisappearanceObserved: true,
      launcherReaped: true,
      lateWriteFinished: true,
      temporaryRootRemoved: true,
    });
  });

  it("retains the root after persistent zero-signal permission uncertainty despite real process exit", async () => {
    const result = await runFixture(`
      const { ref, pid } = await startFamily("graceful");
      writeFileSync(join(root, "protected-data"), "keep");
      let deniedProbes = 0;
      const signals = [];
      process.kill = (target, signal) => {
        if (target === -ref.groupId && signal === 0) {
          deniedProbes += 1;
          throw Object.assign(new Error("probe permission denied"), { code: "EPERM" });
        }
        if (target === -ref.groupId) signals.push(signal);
        return originalKill(target, signal);
      };
      const shortTimeouts = { interruptTimeoutMs: 250, terminateTimeoutMs: 50, killTimeoutMs: 50 };
      const started = performance.now();
      await assert.rejects(manager.stopManagedProcess(ref, shortTimeouts), /Could not prove/);
      assert.ok(performance.now() - started < 1_000);
      assert.ok(deniedProbes > 1);
      assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
      assert.ok(ref.childProcess.exitCode !== null || ref.childProcess.signalCode !== null);
      assert.equal(exists(pid), false);
      assert.equal(exists(-ref.groupId), false);
      assert.equal(readFileSync(join(root, "late-write"), "utf8"), "observed");
      await assert.rejects(manager.cleanupTemporaryRoot(shortTimeouts), (error) => error.message.includes("retained owned temporary root " + root));
      assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
      assert.equal(readFileSync(join(root, "protected-data"), "utf8"), "keep");
      console.log(JSON.stringify({ persistentUncertaintyRefused: true, boundedRefusal: true, realProcessesExited: true, rootRetained: true, noRepeatedSignals: true }));
    `);
    expect(result).toMatchObject({
      persistentUncertaintyRefused: true,
      boundedRefusal: true,
      realProcessesExited: true,
      rootRetained: true,
      noRepeatedSignals: true,
    });
  });

  it("propagates real signal permission denial and retains the live writer's root", async () => {
    const result = await runFixture(`
      const { ref, pid } = await startFamily("resistant");
      writeFileSync(join(root, "protected-data"), "keep");
      const permissionError = Object.assign(new Error("signal permission denied"), { code: "EPERM" });
      const signals = [];
      process.kill = (target, signal) => {
        if (target === -ref.groupId && signal !== 0) {
          signals.push(signal);
          throw permissionError;
        }
        return originalKill(target, signal);
      };
      await assert.rejects(manager.stopManagedProcess(ref, timeouts), (error) => error === permissionError);
      await assert.rejects(manager.stopManagedProcess(ref, timeouts), (error) => error === permissionError);
      await assert.rejects(manager.cleanupTemporaryRoot(timeouts), (error) =>
        error.message.includes("retained owned temporary root " + root) &&
        error.cause instanceof AggregateError && error.cause.errors[0] === permissionError
      );
      assert.deepEqual(signals, ["SIGINT"]);
      assert.equal(readFileSync(join(root, "protected-data"), "utf8"), "keep");
      assert.equal(exists(pid), true);
      assert.equal(exists(-ref.groupId), true);
      console.log(JSON.stringify({ signalPermissionErrorPreserved: true, liveWriterNotConcealed: true, rootRetained: true, noRepeatedSignals: true }));
    `);
    expect(result).toMatchObject({
      signalPermissionErrorPreserved: true,
      liveWriterNotConcealed: true,
      rootRetained: true,
      noRepeatedSignals: true,
    });
  });
});
