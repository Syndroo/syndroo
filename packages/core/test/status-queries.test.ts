import { describe, expect, it } from 'vitest';
import { harness } from '../../../tests/fixtures/state/harness.js';
import type { PreparedResult, PrepareRequest, StatusRequest } from '../src/domain/records.js';

/**
 * SCH-02 of the architecture-v1 acceptance map: `status` exposes exactly five
 * query types, pagination is bounded and stable, a malformed or foreign cursor
 * is refused, and a concurrent insertion neither duplicates nor skips an item.
 *
 * Assertions are exact codes and exact id lists, so losing a guarantee fails
 * the test instead of passing quietly.
 */

const request: PrepareRequest = {
    type: 'prepare', content: {
        text: 'Hello'
    }, targets: [{
            provider: 'fake'
        }]
};

/** Create `count` operations and return their ids in creation order. */
async function operations(h: ReturnType<typeof harness>, count: number, key = 'k'): Promise<string[]> {
    const ids: string[] = [];

    for (let index = 0; index < count; index += 1) {
        const prepared = await h.runtime().core.publish(request, h.ctx(`${key}${index}`)) as PreparedResult;
        ids.push(prepared.operationId);
    }

    return ids;
}

describe('SCH-02 status queries and pagination', () => {
    it('answers exactly five query types and refuses any other', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const prepared = await core.publish(request, h.ctx('one')) as PreparedResult;
        const accepted: StatusRequest[] = [
            {
                type: 'provider', provider: 'fake'
            },
            {
                type: 'connections'
            },
            {
                type: 'operation', operationId: prepared.operationId
            },
            {
                type: 'operations'
            },
            {
                type: 'overview'
            },
        ];
        const answered: string[] = [];

        for (const query of accepted) {
            answered.push((await core.status(query, h.ctx()) as { type: string }).type);
        }

        expect(answered).toEqual(['provider', 'connections', 'operation', 'operations', 'overview']);

        for (const bogus of ['everything', 'queue', 'executions', 'publications']) {
            await expect(core.status({ type: bogus } as unknown as StatusRequest, h.ctx()))
                .rejects.toMatchObject({
                    code: 'INVALID_INPUT'
                });
        }
    });

    it('bounds the page size and refuses an out-of-range limit', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;

        await operations(h, 5);

        expect((await core.status({
            type: 'operations', limit: 2
        }, h.ctx())).operations).toHaveLength(2);
        expect((await core.status({
            type: 'operations', limit: 100
        }, h.ctx())).operations).toHaveLength(5);
        // The default page size is bounded too.
        expect((await core.status({
            type: 'operations'
        }, h.ctx())).operations).toHaveLength(5);

        for (const limit of [0, -1, 101, 1_000, 1.5, Number.NaN]) {
            await expect(core.status({
                type: 'operations', limit
            }, h.ctx())).rejects.toMatchObject({
                code: 'INVALID_INPUT'
            });
        }
    });

    it('refuses a malformed, tampered or foreign cursor', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;

        await operations(h, 3);

        const first = await core.status({
            type: 'operations', limit: 2
        }, h.ctx());
        const cursor = first.nextCursor as string;

        expect(typeof cursor).toBe('string');

        const malformed = [
            'not-a-cursor',
            'a.b.c',
            cursor.slice(0, -1),
            `${cursor}x`,
            'x'.repeat(1025),
        ];

        for (const bad of malformed) {
            await expect(core.status({
                type: 'operations', cursor: bad
            }, h.ctx())).rejects.toMatchObject({
                code: 'INVALID_INPUT'
            });
        }

        // A cursor minted by another store is refused even when the scope name
        // matches: the signature key belongs to the store instance.
        const other = harness({
            scope: 'local'
        });
        await other.seed();
        await operations(other, 3);
        const otherCursor = (await other.runtime().core.status({
            type: 'operations', limit: 2
        }, other.ctx())).nextCursor as string;

        await expect(core.status({
            type: 'operations', cursor: otherCursor
        }, h.ctx())).rejects.toMatchObject({
            code: 'INVALID_INPUT'
        });

        // A cursor minted for another principal is refused as well.
        const foreignPrincipal = {
            ...h.ctx('other-a'), principalId: 'other'
        };

        await core.publish(request, foreignPrincipal);
        await core.publish(request, {
            ...h.ctx('other-b'), principalId: 'other'
        });
        const principalCursor = (await core.status({
            type: 'operations', limit: 1
        }, foreignPrincipal)).nextCursor as string;

        await expect(core.status({
            type: 'operations', cursor: principalCursor
        }, h.ctx())).rejects.toMatchObject({
            code: 'INVALID_INPUT'
        });
    });

    it('tie-breaks a same-timestamp page deterministically and repeats it verbatim', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const ids = await operations(h, 3);
        const created = ids.map((id) => h.state.operations.get(id)?.createdAt);

        // The fixture holds the clock still, so the tie-break is the only order.
        expect(new Set(created).size).toBe(1);

        const pages: string[] = [];
        let cursor: string | undefined;

        for (let index = 0; index < 3; index += 1) {
            const page = await core.status({
                type: 'operations', limit: 1, ...(cursor === undefined ? {} : {
                    cursor
                })
            }, h.ctx());

            pages.push(page.operations[0]?.operationId as string);
            cursor = page.nextCursor;
        }

        expect(pages).toEqual([...ids].sort().reverse());
        expect(new Set(pages).size).toBe(3);

        const pageOne = await core.status({
            type: 'operations', limit: 1
        }, h.ctx());
        const pageTwo = await core.status({
            type: 'operations', limit: 1, cursor: pageOne.nextCursor as string
        }, h.ctx());
        const pageTwoAgain = await core.status({
            type: 'operations', limit: 1, cursor: pageOne.nextCursor as string
        }, h.ctx());

        expect(pageTwoAgain.operations).toEqual(pageTwo.operations);
    });

    it('neither duplicates nor skips while another request inserts concurrently', async () => {
        const h = harness();
        await h.seed();
        const core = h.runtime().core;
        const base = await operations(h, 3);

        const first = await core.status({
            type: 'operations', limit: 2
        }, h.ctx());

        expect(first.operations).toHaveLength(2);
        expect(typeof first.nextCursor).toBe('string');

        // The insertion runs concurrently with the next page of the traversal.
        const [second, inserted] = await Promise.all([
            core.status({
                type: 'operations', limit: 2, cursor: first.nextCursor as string
            }, h.ctx()),
            core.publish(request, h.ctx('inserted')) as Promise<PreparedResult>,
        ]);
        const traversed = [...first.operations, ...second.operations].map((entry) => entry.operationId);

        // No duplicates, and every pre-existing operation exactly once.
        expect(new Set(traversed).size).toBe(traversed.length);
        expect([...traversed].sort()).toEqual([...base].sort());
        // The traversal is bounded: the concurrent insertion is not part of it.
        expect(traversed).not.toContain(inserted.operationId);
        // ...but it is visible to a fresh query, so it was not lost.
        const fresh = await core.status({
            type: 'operations', limit: 100
        }, h.ctx());

        expect(fresh.operations.map((entry) => entry.operationId)).toContain(inserted.operationId);
        expect(fresh.operations).toHaveLength(4);
    });
});
