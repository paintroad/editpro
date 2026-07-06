const os = require("os");

const DEFAULTS = {
  memoryMinFreeMb: 1500,
  memoryResumeMinFreeMb: 2500,
  nodeHeapMaxMb: 512,
  nodeHeapResumeMb: 384,
  pauseDurationMs: 120000,
  maxPauseDurationMs: 600000,
};

function getMemoryStats() {
  const freeMb = os.freemem() / 1024 / 1024;
  const totalMb = os.totalmem() / 1024 / 1024;
  const nodeHeapMb = process.memoryUsage().heapUsed / 1024 / 1024;
  return { freeMb, totalMb, nodeHeapMb };
}

function checkOverload(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { freeMb, nodeHeapMb } = getMemoryStats();

  if (freeMb < opts.memoryMinFreeMb) {
    return {
      overloaded: true,
      reason: `low system memory (${Math.round(freeMb)} MB free)`,
      freeMb,
      nodeHeapMb,
    };
  }
  if (nodeHeapMb > opts.nodeHeapMaxMb) {
    return {
      overloaded: true,
      reason: `high Node heap (${Math.round(nodeHeapMb)} MB)`,
      freeMb,
      nodeHeapMb,
    };
  }
  return { overloaded: false, freeMb, nodeHeapMb };
}

function canResume(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { freeMb, nodeHeapMb } = getMemoryStats();
  if (freeMb < opts.memoryResumeMinFreeMb) {
    return { ready: false, reason: `waiting for memory (${Math.round(freeMb)} MB free)` };
  }
  if (nodeHeapMb > opts.nodeHeapResumeMb) {
    return { ready: false, reason: `waiting for heap (${Math.round(nodeHeapMb)} MB)` };
  }
  return { ready: true };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextPauseDuration(currentPauseMs, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const next = currentPauseMs || opts.pauseDurationMs;
  return Math.min(next * 1.5, opts.maxPauseDurationMs);
}

module.exports = {
  DEFAULTS,
  getMemoryStats,
  checkOverload,
  canResume,
  delay,
  nextPauseDuration,
};
