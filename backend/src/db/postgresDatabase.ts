import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  MigrationConnection,
  MigrationDatabase,
  SqlExecutor,
  SqlResult,
  TransactionalSqlExecutor,
} from "./contracts.js";

class PostgresConnection implements MigrationConnection {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    values?: unknown[],
  ): Promise<SqlResult<Row>> {
    const result = await this.client.query<Row>(statement, values);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async transaction<T>(
    operation: (connection: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    await this.client.query("BEGIN");
    try {
      const result = await operation(this);
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "The database transaction failed and could not be rolled back.",
        );
      }
      throw error;
    }
  }
}

export class PostgresDatabase
  implements TransactionalSqlExecutor, MigrationDatabase
{
  private readonly pool: Pool;

  constructor(databaseUrl: string, ssl: boolean) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: ssl ? { rejectUnauthorized: true } : undefined,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      application_name: "bonobos-backend",
    });
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    values?: unknown[],
  ): Promise<SqlResult<Row>> {
    const result = await this.pool.query<Row>(statement, values);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async transaction<T>(
    operation: (connection: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await new PostgresConnection(client).transaction(operation);
    } finally {
      client.release();
    }
  }

  async withAdvisoryLock<T>(
    lockKey: number,
    operation: (connection: MigrationConnection) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const connection = new PostgresConnection(client);
    let lockAcquired = false;
    let discardClient = false;
    try {
      await connection.query("SELECT pg_advisory_lock($1)", [lockKey]);
      lockAcquired = true;
      return await operation(connection);
    } finally {
      try {
        if (lockAcquired) {
          try {
            await connection.query("SELECT pg_advisory_unlock($1)", [lockKey]);
          } catch (error) {
            discardClient = true;
            throw error;
          }
        }
      } finally {
        client.release(discardClient);
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
