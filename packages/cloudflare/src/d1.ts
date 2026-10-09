/** Narrow subset of the installed Workers D1 API. No Node types in runtime code. */
export type D1Value = string | number | null | ArrayBuffer | ArrayBufferView;
export type D1Result<Row = Record<string, unknown>> = {
  success: boolean;
  results: Row[];
  meta: { changes?: number; [key: string]: unknown };
};
export interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  first<Row = Record<string, unknown>>(column?: string): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
  run<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
  batch<Row = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<Row>[]>;
  /** When supported, each business action starts at the primary. */
  withSession?(constraint: 'first-primary'): D1Database;
}
export function primary(db: D1Database): D1Database {
  return db.withSession ? db.withSession('first-primary') : db;
}
