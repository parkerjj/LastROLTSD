import { MysqlDatabaseError } from './mysql-client';

/**
 * Log fields for a database failure. `MysqlDatabaseError` already strips SQL text and
 * driver messages, so these fixed categories are safe to emit.
 */
export function mysqlErrorContext(error: unknown): Record<string, unknown> {
  if (!(error instanceof MysqlDatabaseError)) return {};
  return {
    mysql_code: error.code, mysql_errno: error.errno, mysql_sql_state: error.sqlState,
    mysql_operation: error.operation, mysql_cause_type: error.causeType,
    mysql_client_reason: error.clientReason, mysql_cause_frames: error.causeFrames,
  };
}
