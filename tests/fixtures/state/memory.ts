/** Test-only reference adapter. Each business action runs without suspension. */
import type * as T from '../../../packages/core/src/domain/records.js';
import { aggregate, accountKey, clone, later, retryEligible } from '../../../packages/core/src/domain/rules.js';
import { canonicalJson, fail } from '../../../packages/core/src/protocol/validation.js';
type RequestEntry = {
    digest: string;
    operationId?: string;
    sessionId?: string;
    result?: T.ConnectResult;
    error?: T.SafeError;
};
export class MemoryState implements T.StateStore {
    readonly operations = new Map<string, T.OperationRecord>();
    readonly intents = new Map<string, T.FrozenIntent>();
    readonly approvals = new Map<string, {
        work: T.WorkRef;
        admitted: boolean;
        principalId: string;
    }>();
    readonly connections = new Map<string, T.ConnectionRecord>();
    readonly sessions = new Map<string, T.ConnectSession>();
    readonly requests = new Map<string, RequestEntry>();
    readonly steps = new Map<string, {
        digest: string;
        claim?: T.StepClaim;
        result?: T.ConnectResult;
        error?: T.SafeError;
    }>();
    readonly retired = new Map<string, string>();
    readonly creationSequence = new Map<string, number>();
    readonly cursorKey = crypto.getRandomValues(new Uint8Array(32));
    #sequence = 0;
    #fence = 0;
    constructor(readonly scope = 'local', readonly fault: (method: string, when: 'before' | 'after') => void = () => {
    }) {
    }
    private key(r: T.RequestIdentity): string {
        return canonicalJson([this.scope, r.principalId, r.family, r.key]);
    }
    private entry(r: T.RequestIdentity): RequestEntry | undefined {
        const e = this.requests.get(this.key(r));
        if (e && e.digest !== r.digest)
            fail('IDEMPOTENCY_CONFLICT');
        if (e?.error)
            fail(e.error.code);
        return e;
    }
    private op(id: string): T.OperationRecord {
        const op = this.operations.get(id);
        if (!op)
            fail('NOT_FOUND');
        return op;
    }
    private intent(w: T.WorkRef): T.FrozenIntent {
        const i = this.intents.get(`${w.operationId}:${w.executionRevision}`);
        if (!i)
            fail('STALE_INTENT');
        return i;
    }
    private ticket(op: T.OperationRecord, r: T.RequestIdentity, ownerId: string, now: string, revision: number): T.PreparationTicket {
        const t = {
            operationId: op.operationId, executionRevision: revision, ownerId, fence: ++this.#fence, expectedVersion: op.version + 1, request: clone(r), expiresAt: later(now, 60000)
        };
        op.version++;
        op.pendingPreparation = t;
        return clone(t);
    }
    async reservePreparation(i: Parameters<T.OperationStore['reservePreparation']>[0]): Promise<T.Reservation> {
        this.fault('reservePreparation', 'before');
        const e = this.entry(i.request);
        if (e?.operationId) {
            const op = this.op(e.operationId);
            if (op.phase !== 'preparing') {
                return {
                    type: 'replay', operation: clone(op), intent: clone(this.intent({
                        operationId: op.operationId, executionRevision: op.executionRevision
                    }))
                };
            }
            if (op.pendingPreparation && op.pendingPreparation.expiresAt > i.now)
                return {
                    type: 'busy', retryAt: op.pendingPreparation.expiresAt
                };
            return {
                type: 'owned', ticket: this.ticket(op, i.request, i.ownerId, i.now, 0)
            };
        }
        const op: T.OperationRecord = {
            operationId: i.operationId, principalId: i.request.principalId, version: 0, createdAt: i.now, canonicalOriginal: clone(i.canonical), executionRevision: 0, phase: 'preparing', deliveries: [], work: {
                pending: false, nextWakeAt: i.now
            }
        };
        this.operations.set(op.operationId, op);
        this.creationSequence.set(op.operationId, ++this.#sequence);
        this.requests.set(this.key(i.request), {
            digest: i.request.digest, operationId: op.operationId
        });
        const ticket = this.ticket(op, i.request, i.ownerId, i.now, 0);
        this.fault('reservePreparation', 'after');
        return {
            type: 'owned', ticket
        };
    }
    async savePreparedIntent(i: Parameters<T.OperationStore['savePreparedIntent']>[0]): Promise<T.CasResult<T.FrozenIntent>> {
        this.fault('savePreparedIntent', 'before');
        const op = this.op(i.ticket.operationId);
        if (op.pendingPreparation?.fence !== i.ticket.fence || op.version !== i.ticket.expectedVersion || i.ticket.expiresAt <= i.now)
            return {
                type: 'conflict'
            };
        if (this.retired.has(i.intent.approvalSecretRef))
            fail('DURABILITY_ERROR');
        this.intents.set(`${op.operationId}:${i.ticket.executionRevision}`, clone(i.intent));
        this.approvals.set(i.intent.approvalDigest, {
            work: {
                operationId: op.operationId, executionRevision: i.ticket.executionRevision
            }, admitted: false, principalId: op.principalId
        });
        delete op.pendingPreparation;
        op.version++;
        if (op.phase === 'preparing') {
            op.phase = 'prepared';
            op.intentDigest = i.intent.intentDigest;
            op.deliveries = i.intent.targets.map(t => ({
                deliveryId: t.deliveryId, connectionId: t.binding.connectionId, account: clone(t.binding.account), attempts: 0, outcome: null, state: 'ready', history: []
            }));
        }
        else
            op.preparedRetry = {
                executionRevision: i.ticket.executionRevision, intentDigest: i.intent.intentDigest
            };
        this.fault('savePreparedIntent', 'after');
        return {
            type: 'applied', value: clone(i.intent)
        };
    }
    async failPreparation(i: Parameters<T.OperationStore['failPreparation']>[0]): Promise<void> {
        const op = this.op(i.ticket.operationId);
        if (op.pendingPreparation?.fence !== i.ticket.fence)
            return;
        const e = this.entry(i.ticket.request);
        if (e)
            e.error = clone(i.error);
        delete op.pendingPreparation;
        op.version++;
    }
    async prepareRetry(i: Parameters<T.OperationStore['prepareRetry']>[0]): Promise<T.Reservation> {
        const e = this.entry(i.request);
        if (e?.operationId) {
            const op = this.op(e.operationId);
            const intent = [...this.intents.values()].find(x => this.key(x.request) === this.key(i.request));
            if (intent)
                return {
                    type: 'replay', operation: clone(op), intent: clone(intent)
                };
            if (op.pendingPreparation?.request.key === i.request.key && op.pendingPreparation.expiresAt <= i.now)
                return {
                    type: 'owned', ticket: this.ticket(op, i.request, i.ownerId, i.now, op.executionRevision + 1)
                };
            return {
                type: 'busy', retryAt: op.pendingPreparation?.expiresAt ?? i.now
            };
        }
        const op = this.op(i.operationId);
        if (op.principalId !== i.request.principalId)
            fail('NOT_FOUND');
        if (op.version !== i.expectedVersion || op.phase !== 'execution' || op.deliveries.some(d => d.state !== 'settled'))
            fail('RETRY_INELIGIBLE');
        if (op.pendingPreparation && op.pendingPreparation.expiresAt > i.now)
            fail('REQUEST_IN_PROGRESS');
        if (op.preparedRetry) {
            const old = this.intent({
                operationId: op.operationId, executionRevision: op.preparedRetry.executionRevision
            });
            if (old.expiresAt > i.now)
                fail('REQUEST_IN_PROGRESS');
            delete op.preparedRetry;
        }
        if (!i.deliveryIds.length || new Set(i.deliveryIds).size !== i.deliveryIds.length || i.deliveryIds.some(id => !op.deliveries.some(d => d.deliveryId === id && retryEligible(d, i.now))))
            fail('RETRY_INELIGIBLE');
        this.requests.set(this.key(i.request), {
            digest: i.request.digest, operationId: op.operationId
        });
        return {
            type: 'owned', ticket: this.ticket(op, i.request, i.ownerId, i.now, Math.max(op.executionRevision, ...[...this.intents.values()].filter(x => x.operationId === op.operationId).map(x => x.executionRevision)) + 1)
        };
    }
    async readApproval(i: Parameters<T.OperationStore['readApproval']>[0]) {
        const a = this.approvals.get(i.approvalDigest);
        if (!a || a.principalId !== i.principalId)
            return null;
        return {
            intent: clone(this.intent(a.work)), admitted: a.admitted, operation: clone(this.op(a.work.operationId))
        };
    }
    async admitExecution(i: Parameters<T.OperationStore['admitExecution']>[0]): Promise<T.CasResult<T.OperationRecord>> {
        this.fault('admitExecution', 'before');
        const a = this.approvals.get(i.approvalDigest);
        if (!a || a.principalId !== i.principalId)
            fail('APPROVAL_INVALID');
        const op = this.op(a.work.operationId);
        if (a.admitted)
            return {
                type: 'replay', value: clone(op)
            };
        const intent = this.intent(a.work);
        if (intent.expiresAt <= i.now)
            fail('APPROVAL_EXPIRED');
        if (op.version !== i.expectedVersion || intent.intentDigest !== i.intentDigest)
            return {
                type: 'conflict'
            };
        if (a.work.executionRevision !== 0 && op.preparedRetry?.executionRevision !== a.work.executionRevision)
            fail('STALE_INTENT');
        for (const b of intent.targets.map(t => t.binding)) {
            const c = this.connections.get(b.connectionId);
            if (!c?.active || c.bindingRevision !== b.bindingRevision || accountKey(c.account) !== accountKey(b.account))
                fail('STALE_BINDING');
        }
        a.admitted = true;
        op.phase = 'execution';
        op.executionRevision = intent.executionRevision;
        op.intentDigest = intent.intentDigest;
        delete op.preparedRetry;
        op.version++;
        const ids = new Set(intent.targets.map(t => t.deliveryId));
        for (const d of op.deliveries)
            if (ids.has(d.deliveryId)) {
                d.state = 'ready';
                d.outcome = null;
                delete d.claim;
            }
        op.status = aggregate(op.deliveries);
        op.work = {
            pending: true, nextWakeAt: i.now
        };
        this.fault('admitExecution', 'after');
        return {
            type: 'applied', value: clone(op)
        };
    }
    async claimDelivery(i: Parameters<T.OperationStore['claimDelivery']>[0]): Promise<T.Claim | null> {
        this.fault('claimDelivery', 'before');
        const op = this.op(i.work.operationId);
        if (op.phase !== 'execution' || op.executionRevision !== i.work.executionRevision || op.version !== i.expectedVersion || op.deliveries.some(d => d.state === 'in_flight'))
            return null;
        const d = op.deliveries.find(d => d.state === 'ready');
        if (!d || d.deliveryId !== i.deliveryId || d.attempts >= 3)
            return null;
        const intent = this.intent(i.work);
        const t = intent.targets.find(t => t.deliveryId === d.deliveryId);
        const c = t && this.connections.get(t.binding.connectionId);
        if (!t || !c?.active || c.bindingRevision !== t.binding.bindingRevision || accountKey(c.account) !== accountKey(t.binding.account))
            fail('STALE_BINDING');
        const claim: T.Claim = {
            ...i.work, deliveryId: i.deliveryId, claimId: i.claimId, ownerId: i.ownerId, submissionId: i.submissionId, attempt: d.attempts + 1, claimedAt: i.now, expiresAt: later(i.now, 900000)
        };
        d.attempts++;
        d.state = 'in_flight';
        d.claim = claim;
        op.version++;
        op.status = aggregate(op.deliveries);
        this.fault('claimDelivery', 'after');
        return clone(claim);
    }
    async recordOutcome(i: Parameters<T.OperationStore['recordOutcome']>[0]): Promise<T.CasResult<T.OperationRecord>> {
        this.fault('recordOutcome', 'before');
        const op = this.op(i.claim.operationId);
        const d = op.deliveries.find(d => d.deliveryId === i.claim.deliveryId);
        if (!d || op.executionRevision !== i.claim.executionRevision)
            return {
                type: 'conflict'
            };
        if (d.state === 'settled') {
            const old = d.history.find(h => h.claim.claimId === i.claim.claimId);
            return old && canonicalJson(old.outcome) === canonicalJson(i.outcome) ? {
                type: 'replay', value: clone(op)
            } : {
                type: 'conflict'
            };
        }
        if (d.state !== 'in_flight' || d.claim?.claimId !== i.claim.claimId || d.claim.ownerId !== i.claim.ownerId || d.claim.expiresAt <= i.now)
            return {
                type: 'conflict'
            };
        d.outcome = clone(i.outcome);
        d.history = [...d.history, {
                claim: clone(i.claim), outcome: clone(i.outcome)
            }];
        d.state = 'settled';
        delete d.claim;
        op.version++;
        op.status = aggregate(op.deliveries);
        op.work.pending = op.deliveries.some(d => d.state !== 'settled');
        this.fault('recordOutcome', 'after');
        return {
            type: 'applied', value: clone(op)
        };
    }
    async stopUnstarted(i: Parameters<T.OperationStore['stopUnstarted']>[0]): Promise<T.CasResult<T.OperationRecord>> {
        const op = this.op(i.work.operationId);
        if (op.executionRevision !== i.work.executionRevision || op.version !== i.expectedVersion)
            return {
                type: 'conflict'
            };
        for (const d of op.deliveries)
            if (d.state === 'ready') {
                d.state = 'settled';
                d.outcome = clone(i.outcome);
            }
        op.version++;
        op.status = aggregate(op.deliveries);
        op.work.pending = op.deliveries.some(d => d.state === 'in_flight');
        return {
            type: 'applied', value: clone(op)
        };
    }
    async recoverInterrupted(i: Parameters<T.OperationStore['recoverInterrupted']>[0]): Promise<T.CasResult<T.OperationRecord>> {
        const op = this.op(i.work.operationId);
        if (op.version !== i.expectedVersion || op.executionRevision !== i.work.executionRevision)
            return {
                type: 'conflict'
            };
        const d = op.deliveries.find(d => d.state === 'in_flight' && d.claim!.expiresAt <= i.now);
        if (!d)
            return {
                type: 'conflict'
            };
        d.outcome = {
            status: 'unknown', disposition: 'unknown', reason: 'unknown'
        };
        d.history = [...d.history, {
                claim: clone(d.claim!), outcome: clone(d.outcome)
            }];
        d.state = 'settled';
        delete d.claim;
        for (const other of op.deliveries)
            if (other.state === 'ready') {
                other.state = 'settled';
                other.outcome = {
                    status: 'not_started', disposition: 'not_applied', reason: 'execution_interrupted'
                };
            }
        op.version++;
        op.status = 'unknown';
        op.work.pending = false;
        return {
            type: 'applied', value: clone(op)
        };
    }
    async getExecutionIntent(work: T.WorkRef) {
        return clone(this.intents.get(work.operationId + ':' + work.executionRevision) ?? null);
    }
    async readConnectRequest(r: T.RequestIdentity) {
        const e = this.entry(r);
        if (e?.result)
            return clone(e.result);
        if (e?.sessionId) {
            const step = this.steps.get(e.sessionId + ':0');
            if (step?.result)
                return clone(step.result);
        }
        return null;
    }
    async replayConnectStep(i: {
        sessionId: string;
        principalId: string;
        stepRevision: number;
        inputDigest: string;
    }) {
        const s = this.sessions.get(i.sessionId);
        if (!s || s.principalId !== i.principalId)
            fail('NOT_FOUND');
        const e = this.steps.get(i.sessionId + ':' + i.stepRevision);
        if (!e)
            return null;
        if (e.digest !== i.inputDigest)
            fail('CONNECT_STEP_CONFLICT');
        if (e.error)
            fail(e.error.code);
        return clone(e.result ?? null);
    }
    async getOperation(id: string, principal: string) {
        const op = this.operations.get(id);
        return op?.principalId === principal ? clone(op) : null;
    }
    async getIntent(w: T.WorkRef, p: string) {
        const op = this.operations.get(w.operationId);
        return op?.principalId === p ? clone(this.intents.get(`${w.operationId}:${w.executionRevision}`) ?? null) : null;
    }
    async listOperations(i: Parameters<T.OperationStore['listOperations']>[0]) {
        if (!Number.isInteger(i.limit) || i.limit < 1 || i.limit > 100)
            fail('INVALID_INPUT');
        let max = this.#sequence;
        let after = '';
        const key = await crypto.subtle.importKey('raw', this.cursorKey, {
            name: 'HMAC', hash: 'SHA-256'
        }, false, ['sign', 'verify']);
        const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const decode = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
        if (i.cursor) {
            try {
                if (i.cursor.length > 1024)
                    fail('INVALID_INPUT');
                const parts = i.cursor.split('.');
                if (parts.length !== 2)
                    fail('INVALID_INPUT');
                const payload = decode(parts[0]!);
                if (!await crypto.subtle.verify('HMAC', key, decode(parts[1]!), payload))
                    fail('INVALID_INPUT');
                const parsed: unknown = JSON.parse(new TextDecoder('utf-8', {
                    fatal: true
                }).decode(payload));
                if (!parsed || typeof parsed !== 'object')
                    fail('INVALID_INPUT');
                const c = parsed as Record<string, unknown>;
                if (c.scope !== this.scope || c.principal !== i.principalId || !Number.isSafeInteger(c.max) || typeof c.after !== 'string')
                    fail('INVALID_INPUT');
                max = c.max as number;
                after = c.after;
            }
            catch {
                fail('INVALID_INPUT');
            }
        }
        const sort = (o: T.OperationRecord) => o.createdAt + '\0' + o.operationId;
        const all = [...this.operations.values()].filter(o => o.principalId === i.principalId && o.phase !== 'preparing' && this.creationSequence.get(o.operationId)! <= max && (!after || sort(o) < after)).sort((a, b) => sort(a) > sort(b) ? -1 : 1);
        const page = all.slice(0, i.limit);
        if (all.length <= i.limit)
            return {
                operations: clone(page)
            };
        const payload = new TextEncoder().encode(JSON.stringify({
            scope: this.scope, principal: i.principalId, max, after: sort(page.at(-1)!)
        }));
        const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
        return {
            operations: clone(page), nextCursor: encode(payload) + '.' + encode(signature)
        };
    }
    async claimNotifications(i: Parameters<T.OperationStore['claimNotifications']>[0]) {
        const out: T.NotifyClaim[] = [];
        for (const op of this.operations.values()) {
            if (out.length >= i.limit)
                break;
            if (!op.work.pending || op.work.nextWakeAt > i.now || (op.work.notifyClaimUntil && op.work.notifyClaimUntil > i.now))
                continue;
            const claimId = `notify_${++this.#fence}`;
            op.work.notifyClaim = claimId;
            op.work.notifyClaimUntil = later(i.now, 30000);
            out.push({
                claimId, work: {
                    operationId: op.operationId, executionRevision: op.executionRevision
                }
            });
        }
        return out;
    }
    async recordNotification(i: Parameters<T.OperationStore['recordNotification']>[0]) {
        const op = this.op(i.claim.work.operationId);
        if (op.work.notifyClaim !== i.claim.claimId)
            return;
        op.work.nextWakeAt = later(i.now, i.sent ? 60000 : 30000);
        delete op.work.notifyClaim;
        delete op.work.notifyClaimUntil;
    }
    async listConnections(provider?: string) {
        return clone([...this.connections.values()].filter(c => !provider || c.account.provider === provider));
    }
    async getConnection(id: string) {
        return clone(this.connections.get(id) ?? null);
    }
    async reserveConnect(i: Parameters<T.ConnectionStore['reserveConnect']>[0]): Promise<T.CasResult<T.ConnectSession>> {
        const e = this.entry(i.request);
        if (e?.sessionId)
            return {
                type: 'replay', value: clone(this.sessions.get(e.sessionId)!)
            };
        this.requests.set(this.key(i.request), {
            digest: i.request.digest, sessionId: i.session.sessionId
        });
        this.sessions.set(i.session.sessionId, clone(i.session));
        return {
            type: 'applied', value: clone(i.session)
        };
    }
    async getConnectSession(id: string, p: string) {
        const s = this.sessions.get(id);
        return s?.principalId === p ? clone(s) : null;
    }
    async claimConnectStep(i: Parameters<T.ConnectionStore['claimConnectStep']>[0]) {
        const s = this.sessions.get(i.sessionId);
        if (!s || s.principalId !== i.principalId)
            fail('NOT_FOUND');
        const key = `${i.sessionId}:${i.stepRevision}`;
        const old = this.steps.get(key);
        if (old) {
            if (old.digest !== i.inputDigest)
                fail('CONNECT_STEP_CONFLICT');
            if (old.result)
                return {
                    type: 'replay' as const, result: clone(old.result)
                };
            if (old.error)
                fail(old.error.code);
            return {
                type: 'busy' as const
            };
        }
        if (s.expiresAt <= i.now)
            fail('CONNECT_SESSION_EXPIRED');
        if (s.stepRevision !== i.stepRevision || s.status === 'done' || s.status === 'indeterminate')
            fail('CONNECT_STEP_CONFLICT');
        const claim: T.StepClaim = {
            sessionId: i.sessionId, stepRevision: i.stepRevision, claimId: i.claimId, inputDigest: i.inputDigest
        };
        this.steps.set(key, {
            digest: i.inputDigest, claim
        });
        s.status = 'processing';
        return {
            type: 'claimed' as const, claim: clone(claim), session: clone(s)
        };
    }
    private step(c: T.StepClaim) {
        const s = this.sessions.get(c.sessionId);
        const entry = this.steps.get(`${c.sessionId}:${c.stepRevision}`);
        if (!s || entry?.claim?.claimId !== c.claimId || s.status !== 'processing')
            fail('CONNECT_STEP_CONFLICT');
        return {
            s, entry
        };
    }
    async saveConnectAction(i: Parameters<T.ConnectionStore['saveConnectAction']>[0]): Promise<T.CasResult<T.ConnectResult>> {
        const { s, entry } = this.step(i.claim);
        if (this.retired.has(i.privateState.ref))
            fail('DURABILITY_ERROR');
        s.stepRevision++;
        s.status = 'awaiting';
        s.action = clone(i.action);
        s.privateStateRef = i.privateState.ref;
        const result: T.ConnectResult = {
            status: 'action_required', connectSessionId: s.sessionId, stepRevision: s.stepRevision, expiresAt: s.expiresAt, action: clone(i.action)
        };
        entry.result = result;
        return {
            type: 'applied', value: clone(result)
        };
    }
    async acceptCallback(i: Parameters<T.ConnectionStore['acceptCallback']>[0]): Promise<T.CasResult<T.ConnectSession>> {
        const s = this.sessions.get(i.sessionId);
        if (!s || s.expiresAt <= i.now || s.stepRevision !== i.expectedStepRevision || s.status !== 'awaiting')
            fail('CONNECT_STEP_CONFLICT');
        const key = `callback:${i.sessionId}`;
        const old = this.requests.get(key);
        if (old) {
            if (old.digest !== i.callbackDigest)
                fail('CONNECT_STEP_CONFLICT');
            return {
                type: 'replay', value: clone(s)
            };
        }
        if (this.retired.has(i.evidence.ref))
            fail('DURABILITY_ERROR');
        s.callbackRef = i.evidence.ref;
        this.requests.set(key, {
            digest: i.callbackDigest
        });
        return {
            type: 'applied', value: clone(s)
        };
    }
    private view(c: T.ConnectionRecord): T.ConnectionView {
        return {
            connectionId: c.connectionId, account: clone(c.account), ...(c.label ? {
                label: c.label
            } : {}), isDefault: c.isDefault, active: c.active, observations: c.observations.map(o => ({
                ...clone(o), stale: false
            }))
        };
    }
    async commitConnection(i: Parameters<T.ConnectionStore['commitConnection']>[0]): Promise<T.CasResult<T.ConnectResult>> {
        this.fault('commitConnection', 'before');
        const { s, entry } = this.step(i.claim);
        const c = clone(i.connection);
        const old = this.connections.get(c.connectionId);
        if ((old?.revision ?? null) !== i.expectedConnectionRevision)
            return {
                type: 'conflict'
            };
        if (old && accountKey(old.account) !== accountKey(c.account))
            fail('CONNECTION_IDENTITY_CHANGED');
        if (this.retired.has(i.stagedCredential.ref) || c.secretRef !== i.stagedCredential.ref)
            fail('DURABILITY_ERROR');
        const others = [...this.connections.values()].filter(x => x.connectionId !== c.connectionId);
        if (!old && others.filter(x => x.active).length >= 100)
            fail('CONNECTION_CAPACITY');
        if (others.some(x => accountKey(x.account) === accountKey(c.account)))
            fail('CONNECTION_IDENTITY_CHANGED');
        if (c.label && others.some(x => x.account.provider === c.account.provider && (x.label === c.label || x.connectionId === c.label)))
            fail('INVALID_INPUT');
        if (!old && !others.some(x => x.active && x.account.provider === c.account.provider))
            c.isDefault = true;
        if (c.isDefault)
            for (const x of others)
                if (x.account.provider === c.account.provider && x.isDefault) {
                    x.isDefault = false;
                    x.revision++;
                }
        this.connections.set(c.connectionId, c);
        s.connectionId = c.connectionId;
        s.status = 'done';
        const result: T.ConnectResult = {
            status: 'done', connection: this.view(c)
        };
        entry.result = result;
        this.fault('commitConnection', 'after');
        return {
            type: 'applied', value: clone(result)
        };
    }
    async failConnectStep(i: Parameters<T.ConnectionStore['failConnectStep']>[0]) {
        const { s, entry } = this.step(i.claim);
        s.status = 'indeterminate';
        entry.error = clone(i.indeterminate ? {
            code: 'CONNECT_STEP_UNKNOWN', message: 'CONNECT_STEP_UNKNOWN'
        } : i.error);
    }
    async updateConnection(i: Parameters<T.ConnectionStore['updateConnection']>[0]): Promise<T.CasResult<T.ConnectResult>> {
        const e = this.entry(i.request);
        if (e?.result)
            return {
                type: 'replay', value: clone(e.result)
            };
        const c = this.connections.get(i.connectionId);
        if (!c)
            fail('NOT_FOUND');
        if (c.revision !== i.expectedRevision)
            return {
                type: 'conflict'
            };
        if (i.changes.label != null && [...this.connections.values()].some(x => x.connectionId !== c.connectionId && x.account.provider === c.account.provider && (x.label === i.changes.label || x.connectionId === i.changes.label)))
            fail('INVALID_INPUT');
        if (i.changes.label === null)
            delete c.label;
        else if (i.changes.label !== undefined)
            c.label = i.changes.label;
        if (i.changes.isDefault !== undefined) {
            if (i.changes.isDefault)
                for (const other of this.connections.values())
                    if (other.account.provider === c.account.provider && other.isDefault) {
                        other.isDefault = false;
                        other.revision++;
                    }
            c.isDefault = i.changes.isDefault;
        }
        c.revision++;
        const result: T.ConnectResult = {
            status: 'done', connection: this.view(c)
        };
        this.requests.set(this.key(i.request), {
            digest: i.request.digest, result
        });
        return {
            type: 'applied', value: clone(result)
        };
    }
    async disconnectConnection(i: Parameters<T.ConnectionStore['disconnectConnection']>[0]): Promise<T.CasResult<T.ConnectResult>> {
        const e = this.entry(i.request);
        if (e?.result)
            return {
                type: 'replay', value: clone(e.result)
            };
        const c = this.connections.get(i.connectionId);
        if (!c)
            fail('NOT_FOUND');
        if (c.revision !== i.expectedRevision)
            return {
                type: 'conflict'
            };
        c.active = false;
        c.isDefault = false;
        c.bindingRevision++;
        c.revision++;
        const result: T.ConnectResult = {
            status: 'done', connection: this.view(c)
        };
        this.requests.set(this.key(i.request), {
            digest: i.request.digest, result
        });
        return {
            type: 'applied', value: clone(result)
        };
    }
    async retireUnreferenced(stage: T.SecretStage) {
        if ([...this.connections.values()].some(c => c.secretRef === stage.ref) || [...this.sessions.values()].some(s => s.privateStateRef === stage.ref || s.callbackRef === stage.ref) || [...this.intents.values()].some(i => i.approvalSecretRef === stage.ref))
            return null;
        const proof = `proof_${++this.#fence}`;
        this.retired.set(stage.ref, proof);
        return {
            proof
        };
    }
}
export class MemoryCredentials implements T.CredentialStore {
    readonly blobs = new Map<string, {
        owner: T.SecretOwner;
        value: T.JsonObject;
        creationId: string;
    }>();
    reads = 0;
    constructor(readonly state: MemoryState) {
    }
    async put(i: Parameters<T.CredentialStore['put']>[0]) {
        const ref = `secret_${i.creationId}`;
        const old = this.blobs.get(ref);
        if (old && canonicalJson(old) !== canonicalJson(i))
            fail('DURABILITY_ERROR');
        this.blobs.set(ref, clone(i));
        return {
            ref, creationId: i.creationId, owner: clone(i.owner)
        };
    }
    async get(i: Parameters<T.CredentialStore['get']>[0]) {
        this.reads++;
        const b = this.blobs.get(i.ref);
        if (!b || canonicalJson(b.owner) !== canonicalJson(i.owner))
            fail('DURABILITY_ERROR');
        return clone(b.value);
    }
    async delete(i: Parameters<T.CredentialStore['delete']>[0]) {
        if (this.state.retired.get(i.stage.ref) !== i.unreferencedProof)
            fail('DURABILITY_ERROR');
        this.blobs.delete(i.stage.ref);
    }
}
