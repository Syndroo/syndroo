import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1Result, D1Statement, D1Value } from '../src/d1.js';

class Statement implements D1Statement {
  readonly values: D1Value[];
  constructor(readonly owner: FakeD1, readonly sql: string, values: D1Value[] = []) {
    this.values = values;
  }
  bind(...values: D1Value[]): D1Statement { return new Statement(this.owner, this.sql, values); }
  async first<Row = Record<string, unknown>>(): Promise<Row | null> {
    return (await this.all<Row>()).results[0] ?? null;
  }
  async all<Row = Record<string, unknown>>(): Promise<D1Result<Row>> {
    return this.owner.execute<Row>(this);
  }
  async run<Row = Record<string, unknown>>(): Promise<D1Result<Row>> {
    return this.owner.execute<Row>(this);
  }
}

/** Executes D1's narrow batch contract against one in-memory SQLite database. */
export class FakeD1 implements D1Database {
  readonly sqlite = new DatabaseSync(':memory:');
  failAt: number | null = null;
  failAfterCommit = false;
  batches = 0;

  prepare(sql: string): D1Statement { return new Statement(this, sql); }
  withSession(): D1Database { return this; }

  execute<Row>(statement: Statement): D1Result<Row> {
    const compiled = this.sqlite.prepare(statement.sql);
    const values = statement.values.map(value => value instanceof ArrayBuffer
      ? new Uint8Array(value) : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value);
    if (compiled.columns().length) {
      return { success: true, results: compiled.all(...values) as Row[], meta: { changes: 0 } };
    }
    const result = compiled.run(...values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async batch<Row = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<Row>[]> {
    this.batches++;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement, index) => {
        if (index === this.failAt) throw new Error('injected batch failure');
        return this.execute<Row>(statement as Statement);
      });
      this.sqlite.exec('COMMIT');
      if (this.failAfterCommit) {
        this.failAfterCommit = false;
        throw new Error('injected lost commit acknowledgement');
      }
      return results;
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.sqlite.close(); }
}
