function createEnqueue(queues) {
  return function enqueue(queueKey, fn) {
    const prev = queues.get(queueKey) || Promise.resolve();
    const next = prev.then(fn).catch((err) => {
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
