'use strict';

function createUpstreamState(ttlMs, now = () => Date.now()) {
  let status = 'unknown';
  let observedAt = 0;
  let generation = 0;
  const observe = (nextStatus) => {
    if (status !== nextStatus) generation += 1;
    status = nextStatus;
    observedAt = now();
  };
  return {
    available() { observe('available'); },
    unavailable() { observe('unavailable'); },
    snapshot() {
      if (observedAt === 0 || now() - observedAt > ttlMs) {
        return { status: 'unknown', generation };
      }
      return { status, generation };
    },
  };
}

module.exports = { createUpstreamState };
