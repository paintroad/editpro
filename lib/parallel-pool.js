/**
 * Run up to `concurrency` workers that claim indices via claimIndex()
 * until claimIndex returns a negative value.
 */
async function runPool({ concurrency, claimIndex, onIndex }) {
  const workerCount = Math.max(1, concurrency);

  async function worker() {
    while (true) {
      const index = claimIndex();
      if (index < 0) {
        break;
      }
      await onIndex(index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

module.exports = { runPool };
