import { compileProviderSchema } from '../../../packages/core/src/protocol/compiler.js';
import * as api from '../../../packages/core/src/index.js';
import type * as T from '../../../packages/core/src/domain/records.js';
import { canonicalJson } from '../../../packages/core/src/protocol/validation.js';
import { MemoryState, MemoryCredentials } from './memory.js';
export function harness(options: {
    fault?: (method: string, when: 'before' | 'after') => void;
    async?: boolean;
    scope?: string;
} = {}) {
    let sequence = 0;
    let time = '2026-10-08T00:00:00.000Z';
    const state = new MemoryState(options.scope ?? 'local', options.fault);
    const credentials = new MemoryCredentials(state);
    const writes: Pick<T.ProviderPublishInput, 'frozen' | 'account' | 'submissionId'>[] = [];
    let loads = 0, verifies = 0;
    let publish: (input: T.ProviderPublishInput) => Promise<T.ProviderWriteOutcome> = async () => ({
        status: 'succeeded', remoteId: 'remote'
    });
    const identity: T.AccountIdentity = {
        provider: 'fake', accountId: 'alice', origin: 'https://social.example'
    };
    const plugin: T.ProviderPlugin = {
        manifest: {
            id: 'fake', name: 'Fake', version: '0.7.0-rc.1', apiVersion: 1, declaredCapabilities: ['text'],
            egress: { fixedOrigins: ['https://social.example'] }, schemas: {
                connectOptions: {
                    type: 'object', additionalProperties: false
                }, credentialInput: {
                    type: 'object', properties: {
                        token: {
                            type: 'string'
                        }
                    }, required: ['token'], additionalProperties: false
                }, content: {
                    type: 'object', properties: {
                        text: {
                            type: 'string', minLength: 1
                        }
                    }, required: ['text'], additionalProperties: false
                }, publishOptions: {
                    type: 'object', additionalProperties: false
                }
            }
        },
        connect: {
            async run(input) {
                if (input.type === 'start')
                    return {
                        status: 'action_required', action: {
                            type: 'credential_input', fields: [{
                                    name: 'token', label: 'Token', secret: true
                                }]
                        }, privateState: {}
                    };
                return {
                    status: 'done', credentials: input.input.type === 'credentials' ? input.input.credentials : {
                        token: 'callback'
                    }, identity: {
                        account: identity, evidence: []
                    }
                };
            }, async verify() {
                verifies++;
                return {
                    account: identity, evidence: []
                };
            }
        },
        freeze(input) {
            return {
                payloadVersion: 1, payload: {
                    text: input.content.text!
                }, effectiveContent: input.content, effectiveOptions: input.options, preview: {
                    content: input.content, fields: []
                }
            };
        },
        async publish(input) {
            writes.push(structuredClone({
                frozen: input.frozen, account: input.account, submissionId: input.submissionId
            }));
            return publish(input);
        }
    };
    const implementation: T.Implementation = {
        provider: 'fake', packageName: '@syndroo/provider-fake', version: '0.7.0-rc.1', apiVersion: 1, artifactFingerprint: 'artifact-1', schemaFingerprint: 'schema-1'
    };
    const providers: T.ProviderRegistry = {
        async describe() {
            return {
                provider: 'fake', availability: 'available', provenance: 'official', implementation, manifest: plugin.manifest
            };
        }, async list() {
            return [{
                    provider: 'fake', availability: 'available', provenance: 'official', implementation
                }];
        }, async load() {
            loads++;
            return {
                plugin, implementation: structuredClone(implementation), validators: {
                    connectOptions: compileProviderSchema(plugin.manifest.schemas.connectOptions), credentialInput: compileProviderSchema(plugin.manifest.schemas.credentialInput), content: compileProviderSchema(plugin.manifest.schemas.content), publishOptions: compileProviderSchema(plugin.manifest.schemas.publishOptions)
                }
            };
        }
    };
    const ctx = (key?: string): T.CallContext => ({
        principalId: 'owner', ...(key ? {
            idempotencyKey: key
        } : {}), signal: new AbortController().signal
    });
    const digest = async (value: T.Json, keyed: boolean) => {
        const bytes = new TextEncoder().encode(canonicalJson(value));
        const bytesKey = new TextEncoder().encode('fixture-' + state.scope);
        const output = keyed ? await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', bytesKey, {
            name: 'HMAC', hash: 'SHA-256'
        }, false, ['sign']), bytes) : await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(output), b => b.toString(16).padStart(2, '0')).join('');
    };
    const deps: T.CoreDependencies = {
        state, credentials, providers, clock: {
            now: () => time
        }, entropy: {
            id: p => p + '_' + ++sequence, token: () => 'token_' + ++sequence
        }, digests: {
            canonical: x => digest(x, false), sensitive: x => digest(x, true)
        }, providerContext: () => ({
            now: time, signal: new AbortController().signal, transport: {
                async request() {
                    throw Error('no network');
                }
            }
        }), execution: options.async ? {
            type: 'durable_async', notifier: {
                async notify() {
                    throw Error('queue unavailable');
                }
            }
        } : {
            type: 'foreground'
        }
    };
    const runtime = () => api.createCore(deps);
    async function seed(id = 'conn_alice', account = 'alice') {
        const c: T.ConnectionRecord = {
            connectionId: id, account: {
                ...identity, accountId: account
            }, isDefault: state.connections.size === 0, active: true, revision: 1, bindingRevision: 1, credentialRevision: 1, secretRef: '', observations: []
        };
        const staged = await credentials.put({
            creationId: id, owner: {
                kind: 'credential', ownerId: id, version: 1
            }, value: {
                token: 'FAKE_SECRET_CANARY'
            }
        });
        c.secretRef = staged.ref;
        state.connections.set(id, c);
        return c;
    }
    return {
        state, credentials, plugin, implementation, providers, deps, runtime, ctx, seed, writes, setTime: (v: string) => {
            time = v;
        }, setPublish: (fn: typeof publish) => {
            publish = fn;
        }, metrics: () => ({
            loads, verifies
        })
    };
}
