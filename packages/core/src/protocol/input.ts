import { validateWire } from './generated/validators.js';
import { fail } from './validation.js';
export { parseStrictJson, parseStrictResponseJson, canonicalJson, ProtocolError } from './validation.js';
export function validateRequest(family: 'connect' | 'publish' | 'status', input: unknown): void {
    validateWire(family === 'connect' ? 'ConnectRequest' : family === 'publish' ? 'PublishRequest' : 'StatusRequest', input);
    const r = input as {
        type: string;
        limit?: number;
        cursor?: string;
        label?: string;
        changes?: Record<string, unknown>;
    };
    if (family === 'status' && r.type === 'operations' && ((r.limit !== undefined && (!Number.isInteger(r.limit) || r.limit < 1 || r.limit > 100)) || (r.cursor !== undefined && r.cursor.length > 1024)))
        fail('INVALID_INPUT');
    if (family === 'connect' && r.label !== undefined && (!r.label.length || [...r.label].length > 64 || /^conn_|[\x00-\x1f\x7f]/.test(r.label)))
        fail('INVALID_INPUT');
    if (family === 'connect' && r.type === 'update' && !Object.keys(r.changes!).length)
        fail('INVALID_INPUT');
}
