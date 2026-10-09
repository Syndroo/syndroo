import type { AccountIdentity, DeliveryRecord, ExecutionResult, ExecutionStatus, OperationRecord, ProviderWriteOutcome } from './records.js';
import { canonicalJson } from '../protocol/validation.js';
export const accountKey = (a: AccountIdentity): string => canonicalJson(a);
export function aggregate(deliveries: readonly DeliveryRecord[]): ExecutionStatus {
    if (deliveries.some(d => d.outcome?.status === 'unknown'))
        return 'unknown';
    if (deliveries.some(d => d.state === 'in_flight'))
        return 'running';
    if (deliveries.some(d => d.state === 'ready'))
        return 'pending';
    if (deliveries.length && deliveries.every(d => d.outcome?.status === 'succeeded'))
        return 'succeeded';
    return deliveries.some(d => d.outcome?.status === 'succeeded') ? 'partial' : 'failed';
}
export function retryEligible(d: DeliveryRecord, now: string): boolean {
    if (d.state !== 'settled' || d.attempts >= 3 || !d.outcome)
        return false;
    const o = d.outcome;
    if (o.status === 'not_started')
        return ['cancelled_before_start', 'execution_interrupted', 'stale_binding', 'stale_implementation'].includes(o.reason);
    return o.status === 'failed' && o.disposition === 'not_applied' && o.retryable && ['network', 'rate_limited', 'provider_unavailable'].includes(o.reason) && (!o.retryAfter || Date.parse(o.retryAfter) <= Date.parse(now));
}
export function executionView(op: OperationRecord): ExecutionResult {
    return {
        phase: 'execution', operationId: op.operationId, status: op.status ?? aggregate(op.deliveries), deliveries: op.deliveries.map(d => ({
            deliveryId: d.deliveryId, connectionId: d.connectionId, account: d.account, attempts: d.attempts, outcome: d.outcome
        }))
    };
}
export const later = (now: string, ms: number): string => new Date(Date.parse(now) + ms).toISOString();
export const clone = <T>(v: T): T => structuredClone(v);
export function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const v of Object.values(value))
            deepFreeze(v);
        Object.freeze(value);
    }
    return value;
}
export const unknownOutcome = (): ProviderWriteOutcome => ({
    status: 'unknown', disposition: 'unknown', reason: 'unknown'
});
