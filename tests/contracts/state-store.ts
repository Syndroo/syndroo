import { describe, expect, it } from 'vitest';
import type * as T from '../../packages/core/src/domain/records.js';
export type StateFixture = {
    state: T.StateStore;
    credentials: T.CredentialStore;
};
export function stateStoreContract(name: string, factory: () => Promise<StateFixture>): void {
    const now = '2026-10-08T00:00:00.000Z';
    const principalId = 'owner';
    const account = {
        provider: 'fake', accountId: 'alice', origin: 'https://social.example'
    };
    const implementation = {
        provider: 'fake', packageName: 'fake', version: '0.7.0-rc.1', apiVersion: 1 as const, artifactFingerprint: 'artifact', schemaFingerprint: 'schema'
    };
    async function connected(f: StateFixture, suffix = 'one'): Promise<T.ConnectionRecord> {
        const sessionId = 'cs_' + suffix;
        const connectionId = 'conn_' + suffix;
        const session: T.ConnectSession = {
            sessionId, principalId, provider: 'fake', implementation, stepRevision: 0, expiresAt: '2026-10-08T00:15:00.000Z', connectionId, baselineRevision: null, status: 'awaiting'
        };
        await f.state.reserveConnect({
            request: {
                principalId, family: 'connect', key: 'connect_' + suffix, digest: 'connect_' + suffix
            }, session, now
        });
        const claim = await f.state.claimConnectStep({
            sessionId, principalId, stepRevision: 0, inputDigest: 'input', claimId: 'step_' + suffix, now
        });
        if (claim.type !== 'claimed')
            throw Error('expected step');
        const staged = await f.credentials.put({
            creationId: 'credential_' + suffix, owner: {
                kind: 'credential', ownerId: connectionId, version: 1
            }, value: {
                token: 'fixture-only'
            }
        });
        const connection: T.ConnectionRecord = {
            connectionId, account: {
                ...account, accountId: suffix === 'one' ? 'alice' : 'bob'
            }, active: true, isDefault: suffix === 'one', revision: 1, bindingRevision: 1, credentialRevision: 1, secretRef: staged.ref, observations: []
        };
        const result = await f.state.commitConnection({
            claim: claim.claim, expectedConnectionRevision: null, connection, stagedCredential: staged, now
        });
        expect(result.type).toBe('applied');
        return connection;
    }
    async function admitted(f: StateFixture, second = false) {
        const connection = await connected(f);
        const secondConnection = second ? await connected(f, 'two') : null;
        const canonical: T.PrepareRequest = {
            type: 'prepare', content: {
                text: 'hello'
            }, targets: [connection, ...(secondConnection ? [secondConnection] : [])].map(c => ({
                provider: 'fake', connection: c.connectionId
            }))
        };
        const request: T.RequestIdentity = {
            principalId, family: 'publish', key: 'publish', digest: 'same'
        };
        const reservation = await f.state.reservePreparation({
            request, canonical, operationId: 'op_one', ownerId: 'owner', now
        });
        if (reservation.type !== 'owned')
            throw Error('expected ownership');
        const secret = await f.credentials.put({
            creationId: 'approval', owner: {
                kind: 'approval', ownerId: 'op_one', version: 0
            }, value: {
                approvalToken: 'fixture'
            }
        });
        const target: T.FrozenTarget = {
            deliveryId: 'delivery_one', binding: {
                connectionId: connection.connectionId, account, bindingRevision: 1
            }, implementation, canonicalContent: {
                text: 'hello'
            }, canonicalOptions: {}, frozen: {
                payloadVersion: 1, payload: {
                    text: 'hello'
                }, effectiveContent: {
                    text: 'hello'
                }, effectiveOptions: {}, preview: {
                    content: {
                        text: 'hello'
                    }, fields: []
                }
            }
        };
        const intent: T.FrozenIntent = {
            format: 'syndroo-runtime-v1', operationId: 'op_one', executionRevision: 0, principalId, request, canonicalRequest: canonical, targets: secondConnection ? [target, {
                    ...target, deliveryId: 'delivery_two', binding: {
                        connectionId: secondConnection.connectionId, account: secondConnection.account, bindingRevision: secondConnection.bindingRevision
                    }
                }] : [target], createdAt: now, expiresAt: '2026-10-08T00:15:00.000Z', approvalDigest: 'approval', approvalSecretRef: secret.ref, intentDigest: 'intent'
        };
        const save = await f.state.savePreparedIntent({
            ticket: reservation.ticket, intent, now
        });
        expect(save.type).toBe('applied');
        const op = (await f.state.getOperation('op_one', principalId))!;
        const inputs = {
            principalId, approvalDigest: 'approval', intentDigest: 'intent', expectedVersion: op.version, bindings: intent.targets.map(t => t.binding), now
        };
        return {
            inputs, intent, op
        };
    }
    describe(name + ' atomic business ports', () => {
        it('concurrent same-key reserve returns one ownership and rejects conflicting digest', async () => {
            const f = await factory();
            const input = {
                request: {
                    principalId, family: 'publish' as const, key: 'one', digest: 'same'
                }, canonical: {
                    type: 'prepare' as const, content: {
                        text: 'hello'
                    }, targets: [{
                            provider: 'fake'
                        }]
                }, operationId: 'op_one', ownerId: 'a', now
            };
            const results = await Promise.all([f.state.reservePreparation(input), f.state.reservePreparation({
                    ...input, operationId: 'op_two', ownerId: 'b'
                })]);
            expect(results.filter(x => x.type === 'owned')).toHaveLength(1);
            await expect(f.state.reservePreparation({
                ...input, request: {
                    ...input.request, digest: 'different'
                }
            })).rejects.toMatchObject({
                code: 'IDEMPOTENCY_CONFLICT'
            });
        });
        it('concurrent admission commits one pending round and replays after TTL', async () => {
            const f = await factory();
            const { inputs } = await admitted(f);
            const results = await Promise.all([f.state.admitExecution(inputs), f.state.admitExecution(inputs)]);
            expect(results.filter(x => x.type === 'applied')).toHaveLength(1);
            expect(results.filter(x => x.type === 'replay')).toHaveLength(1);
            expect((await f.state.admitExecution({
                ...inputs, now: '2026-10-09T00:00:00.000Z'
            })).type).toBe('replay');
            expect((await f.state.getOperation('op_one', principalId))?.work.pending).toBe(true);
        });
        it('blocks every next target while any target is in flight', async () => {
            const f = await factory();
            const { inputs } = await admitted(f, true);
            await f.state.admitExecution(inputs);
            const op = (await f.state.getOperation('op_one', principalId))!;
            const first = await f.state.claimDelivery({
                work: {
                    operationId: 'op_one', executionRevision: 0
                }, deliveryId: 'delivery_one', expectedVersion: op.version, claimId: 'claim_one', ownerId: 'first', submissionId: 'submit_one', now
            });
            expect(first).not.toBeNull();
            const latest = (await f.state.getOperation('op_one', principalId))!;
            expect(await f.state.claimDelivery({
                work: {
                    operationId: 'op_one', executionRevision: 0
                }, deliveryId: 'delivery_two', expectedVersion: latest.version, claimId: 'claim_two', ownerId: 'second', submissionId: 'submit_two', now
            })).toBeNull();
        });
        it('fences delayed outcome after expired claim recovery and never reclaims', async () => {
            const f = await factory();
            const { inputs } = await admitted(f);
            await f.state.admitExecution(inputs);
            const work = {
                operationId: 'op_one', executionRevision: 0
            };
            const op = (await f.state.getOperation('op_one', principalId))!;
            const claim = await f.state.claimDelivery({
                work, deliveryId: 'delivery_one', expectedVersion: op.version, claimId: 'claim_one', ownerId: 'old', submissionId: 'submit', now
            });
            const latest = (await f.state.getOperation('op_one', principalId))!;
            expect((await f.state.recordOutcome({
                claim: claim!, outcome: {
                    status: 'succeeded'
                }, now: '2026-10-08T00:16:00.000Z'
            })).type).toBe('conflict');
            const recovered = await f.state.recoverInterrupted({
                work, expectedVersion: latest.version, now: '2026-10-08T00:16:00.000Z'
            });
            expect(recovered.type).toBe('applied');
            expect((await f.state.recordOutcome({
                claim: claim!, outcome: {
                    status: 'succeeded'
                }, now: '2026-10-08T00:17:00.000Z'
            })).type).toBe('conflict');
            expect((await f.state.getOperation('op_one', principalId))?.status).toBe('unknown');
        });
        it('notification retry keeps admitted work and never increments content attempts', async () => {
            const f = await factory();
            const { inputs } = await admitted(f);
            await f.state.admitExecution(inputs);
            const first = await f.state.claimNotifications({
                ownerId: 'a', now, limit: 100
            });
            expect(first).toHaveLength(1);
            await f.state.recordNotification({
                claim: first[0]!, sent: false, now
            });
            expect(await f.state.claimNotifications({
                ownerId: 'b', now, limit: 100
            })).toHaveLength(0);
            expect(await f.state.claimNotifications({
                ownerId: 'b', now: '2026-10-08T00:01:00.000Z', limit: 100
            })).toHaveLength(1);
            expect((await f.state.getOperation('op_one', principalId))?.deliveries[0]?.attempts).toBe(0);
        });
    });
}
