function createEnqueue(queues) {
  return function enqueue(queueKey, fn) {
    const enqueuedAt = Date.now();
    const prev = queues.get(queueKey) || Promise.resolve();
    const next = prev
      .then(async () => {
        const queueWaitMs = Date.now() - enqueuedAt;
        console.info(`queue_start key=${queueKey} queue_wait_ms=${queueWaitMs}`);
        return fn();
      })
      .catch((err) => {
        console.error('Queue error', err);
      });
    queues.set(queueKey, next);
    next.finally(() => {
      if (queues.get(queueKey) === next) {
        queues.delete(queueKey);
      }
    });
    return next;
  };
}

module.exports = {
  createEnqueue,
};
