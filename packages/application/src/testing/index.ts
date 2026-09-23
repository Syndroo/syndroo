/**
 * Test-double entry point (`@syndroo/application/testing`).
 *
 * Kept on a separate subpath so a production Worker entry can import the
 * public `@syndroo/application` surface without pulling the fake; the bundle
 * tree-shaking claim still needs verification during integration.
 */

export {
  createSnapshotFake,
  createSnapshotFakeHarness,
  type FakeFaultController,
  type FakeFaultInjection,
  type FakeSnapshot,
  type SnapshotFake,
  type SnapshotFakeClock,
  type SnapshotFakeOptions,
  type StoreHarness,
} from "./snapshot-fake.js";
export { createTestCipher } from "./fake-cipher.js";
export {
  runStoreContractScenarios,
  storeContractScenarios,
  type ContractReport,
  type ContractScenario,
  type ContractScenarioResult,
} from "./contract-suite.js";
export {
  assertDeepEqual,
  assertEqual,
  assertKind,
  assertTrue,
  ContractViolationError,
  fail,
} from "./assertions.js";
export {
  FIXTURE_NOW,
  createTransaction,
  instant,
  testEnvelope,
  type CreateFixtureOptions,
} from "./fixtures.js";
