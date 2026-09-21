import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

export interface D1UsageBucket {
  rowsRead: number;
  rowsWritten: number;
  changes: number;
  durationMs: number;
}

export interface D1Usage extends D1UsageBucket {
  stages: Record<string, D1UsageBucket>;
}

export interface D1MetaLike {
  rows_read?: number;
  rows_written?: number;
  changes?: number;
  duration?: number;
}

export interface D1Meter {
  record(stage: string, meta: D1MetaLike | undefined): void;
  snapshot(): D1Usage;
  reset(): void;
}

const emptyBucket = (): D1UsageBucket => ({ rowsRead: 0, rowsWritten: 0, changes: 0, durationMs: 0 });

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createD1Meter(): D1Meter {
  let usage: D1Usage = { ...emptyBucket(), stages: {} };

  return {
    record(stage, meta) {
      const next: D1UsageBucket = {
        rowsRead: finite(meta?.rows_read),
        rowsWritten: finite(meta?.rows_written),
        changes: finite(meta?.changes),
        durationMs: finite(meta?.duration),
      };
      const bucket = usage.stages[stage] ??= emptyBucket();
      usage.rowsRead += next.rowsRead;
      usage.rowsWritten += next.rowsWritten;
      usage.changes += next.changes;
      usage.durationMs += next.durationMs;
      bucket.rowsRead += next.rowsRead;
      bucket.rowsWritten += next.rowsWritten;
      bucket.changes += next.changes;
      bucket.durationMs += next.durationMs;
    },
    snapshot() {
      return {
        rowsRead: usage.rowsRead,
        rowsWritten: usage.rowsWritten,
        changes: usage.changes,
        durationMs: usage.durationMs,
        stages: Object.fromEntries(Object.entries(usage.stages).map(([stage, bucket]) => [stage, { ...bucket }])),
      };
    },
    reset() {
      usage = { ...emptyBucket(), stages: {} };
    },
  };
}

function stageForSql(sql: string): string {
  const normalized = sql.toLocaleLowerCase();
  if (normalized.includes('upload_batches')) return 'upload_batch';
  if (normalized.includes('market_sources')) return 'source';
  if (normalized.includes('listing_events')) return 'listing_event';
  if (normalized.includes('listing_options')) return 'listing_options';
  if (normalized.includes('listings')) return normalized.trimStart().startsWith('select') || normalized.trimStart().startsWith('with') ? 'listing_read' : 'listing_write';
  if (normalized.includes('shops')) return 'shop_state';
  if (normalized.includes('catalog')) return 'catalog';
  return 'other';
}

interface D1ResultLike {
  meta?: D1MetaLike;
}

export function createMeteredD1Database(database: D1Database, meter: D1Meter): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const stages = new WeakMap<object, string>();

  const wrapStatement = (statement: D1PreparedStatement, stage: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement as object, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrapStatement((statement.bind as (...args: unknown[]) => D1PreparedStatement)(...values), stage);
        }
        if (property === 'all') {
          return async <T>() => {
            const result = await statement.all<T>();
            meter.record(stage, result.meta);
            return result;
          };
        }
        if (property === 'run') {
          return async () => {
            const result = await statement.run();
            meter.record(stage, result.meta);
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
    originals.set(wrapped as object, statement);
    stages.set(statement as object, stage);
    stages.set(wrapped as object, stage);
    return wrapped;
  };

  return new Proxy(database as object, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => wrapStatement(database.prepare(sql), stageForSql(sql));
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const unwrapped = statements.map((statement) => originals.get(statement as object) ?? statement);
          const results = await database.batch(unwrapped);
          results.forEach((result: D1ResultLike, index: number) => {
            const original = unwrapped[index];
            const wrapped = statements[index];
            meter.record((wrapped && stages.get(wrapped as object)) ?? (original && stages.get(original as object)) ?? 'other', result.meta);
          });
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}
