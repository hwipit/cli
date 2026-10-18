import type { SubscriberTrust } from '../../src/subscriber-trust.js';

/**
 * A trust store that takes every key. For tests of what a listener does once a
 * subscriber's key has checked out — the checking itself is
 * subscriber-trust.test.ts and hostile-relay.test.ts.
 */
export const trustEveryKey: SubscriberTrust = {
    admit: async ({ publicKey }) => (publicKey ? { kind: 'seal', publicKey } : { kind: 'plain' }),
    sealedOnly: () => false,
    acceptCommand: () => true,
};

/**
 * Let a pending admission land. It resolves over a few promise hops and no
 * timer, so this works under fake timers too.
 */
export const admissionSettled = async (): Promise<void> => {
    for (let hop = 0; hop < 10; hop++) await Promise.resolve();
};
