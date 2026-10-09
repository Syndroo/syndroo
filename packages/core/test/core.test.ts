import { stateStoreContract } from '../../../tests/contracts/state-store.js';
import { MemoryState, MemoryCredentials } from '../../../tests/fixtures/state/memory.js';
stateStoreContract('memory', async () => {
    const state = new MemoryState();
    return {
        state, credentials: new MemoryCredentials(state)
    };
});
