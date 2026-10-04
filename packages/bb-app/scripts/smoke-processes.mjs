import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const PROCESS_POLL_INTERVAL_MS = 25;
const DEFAULT_TIMEOUTS = {
  interruptTimeoutMs: 5_000,
  terminateTimeoutMs: 5_000,
  killTimeoutMs: 1_000,
};

function hasProcessExited(childProcess) {
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

export function waitForProcessExit(childProcess) {
  if (hasProcessExited(childProcess)) {
    return Promise.resolve({
      code: childProcess.exitCode,
      signal: childProcess.signalCode,
    });
  }
  return new Promise((resolvePromise, reject) => {
    const onExit = (code, signal) => {
      childProcess.off("error", onError);
      resolvePromise({ code, signal });
    };
    const onError = (error) => {
      childProcess.off("exit", onExit);
      reject(error);
    };
    childProcess.once("exit", onExit);
    childProcess.once("error", onError);
  });
}

export function collectProcessOutput(childProcess) {
  const output = { stderr: "", stdout: "" };
  childProcess.stdout?.on("data", (chunk) => {
    output.stdout += chunk.toString("utf8");
  });
  childProcess.stderr?.on("data", (chunk) => {
    output.stderr += chunk.toString("utf8");
  });
  return output;
}

function groupExists(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function isStopped(processRef) {
  const groupStopped = !processRef.detached || !groupExists(processRef.groupId);
  return groupStopped && hasProcessExited(processRef.childProcess);
}

function signalProcess(processRef, signal) {
  if (!processRef.detached) {
    if (!hasProcessExited(processRef.childProcess)) {
      processRef.childProcess.kill(signal);
    }
    return;
  }
  try {
    process.kill(-processRef.groupId, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

async function waitUntilStopped(processRef, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const maxPolls = Math.ceil(timeoutMs / PROCESS_POLL_INTERVAL_MS) + 1;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (isStopped(processRef)) return true;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return false;
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, Math.min(PROCESS_POLL_INTERVAL_MS, remainingMs));
    });
  }
  return isStopped(processRef);
}

async function stopProcess(processRef, options) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options };
  for (const timeoutMs of Object.values(timeouts)) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error("Smoke process shutdown requires finite positive deadlines");
    }
  }
  if (!Number.isSafeInteger(processRef.groupId) || processRef.groupId < 1) {
    throw new Error(`Cannot prove process ownership for ${processRef.label}`);
  }
  for (const [signal, timeoutMs] of [
    ["SIGINT", timeouts.interruptTimeoutMs],
    ["SIGTERM", timeouts.terminateTimeoutMs],
    ["SIGKILL", timeouts.killTimeoutMs],
  ]) {
    if (isStopped(processRef)) return;
    signalProcess(processRef, signal);
    if (await waitUntilStopped(processRef, timeoutMs)) return;
  }
  throw new Error(`Could not prove ${processRef.label} launcher and owned process group stopped`);
}

export function createManagedProcesses({ cwd, env = {} }) {
  const running = new Set();
  const stopping = new WeakMap();

  function spawnManagedProcess({ args, command, env: processEnv = {}, label }) {
    const detached = process.platform !== "win32";
    const childProcess = spawn(command, args, {
      cwd,
      detached,
      env: { ...process.env, ...processEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const processRef = {
      childProcess,
      detached,
      groupId: childProcess.pid,
      label,
      output: collectProcessOutput(childProcess),
    };
    running.add(processRef);
    return processRef;
  }

  async function stopManagedProcess(processRef, options = {}) {
    const existing = stopping.get(processRef);
    if (existing !== undefined) return existing;
    if (!running.has(processRef)) {
      throw new Error("Cannot stop a process owned by another smoke fixture");
    }
    const pending = stopProcess(processRef, options).then(() => {
      running.delete(processRef);
    });
    stopping.set(processRef, pending);
    return pending;
  }

  async function stopAllManagedProcesses(options = {}) {
    const results = await Promise.allSettled(
      [...running].map((processRef) => stopManagedProcess(processRef, options)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Smoke process teardown could not be proved");
    }
  }

  async function cleanupTemporaryRoot(options = {}) {
    try {
      await stopAllManagedProcesses(options);
    } catch (error) {
      throw new Error(`Smoke teardown unproved; retained owned temporary root ${cwd}`, {
        cause: error,
      });
    }
    await rm(cwd, { force: true, recursive: true });
  }

  return {
    spawnManagedProcess,
    stopManagedProcess,
    stopAllManagedProcesses,
    cleanupTemporaryRoot,
  };
}
