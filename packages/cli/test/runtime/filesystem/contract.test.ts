import { stateStoreContract } from "../../../../../tests/contracts/state-store.js";
import { fixtureAt, makeRoot } from "./support.js";

/**
 * The shared storage contract, run against the filesystem adapter.
 *
 * Every test gets a fresh private root, so the contract exercises real
 * generation commits, the writer lock and the record index instead of an
 * in-memory stand-in.
 */
stateStoreContract("filesystem", async () => {
  const fixture = fixtureAt(await makeRoot());

  return { state: fixture.state, credentials: fixture.credentials };
});
