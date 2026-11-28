import type { QueryResultRow } from "pg";

export interface SqlResult<Row extends QueryResultRow = QueryResultRow> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    values?: unknown[],
  ): Promise<SqlResult<Row>>;
}

export interface TransactionalSqlExecutor extends SqlExecutor {
  transaction<T>(operation: (connection: SqlExecutor) => Promise<T>): Promise<T>;
}

export type MigrationConnection = TransactionalSqlExecutor;

export interface MigrationDatabase {
  withAdvisoryLock<T>(
    lockKey: number,
    operation: (connection: MigrationConnection) => Promise<T>,
  ): Promise<T>;
}
