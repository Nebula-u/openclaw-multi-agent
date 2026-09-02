import { DatabaseSync } from 'node:sqlite';

export const CURRENT_KERNEL_SCHEMA_VERSION = 1;
const LEGACY_RUN_COLUMN = 'langgraph_thread_id';

function tableNames(sqlite) {
  return sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
}

function tableColumns(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all()
    .map(({ name, type, notnull, dflt_value: defaultValue, pk }) => ({ name, type, notnull, defaultValue, pk }));
}

function expectedSchema(schemaSql) {
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(schemaSql);
    return Object.fromEntries(tableNames(expected).map((table) => [table, tableColumns(expected, table)]));
  } finally { expected.close(); }
}

function expectedTableSql(schemaSql, table, replacement) {
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(schemaSql);
    const sql = expected.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
    if (!sql) throw new Error(`canonical schema does not define table ${table}`);
    return sql.replace(new RegExp(`^CREATE TABLE ${table}\\b`, 'u'), `CREATE TABLE ${replacement}`);
  } finally { expected.close(); }
}

function sameColumns(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export function inspectKernelSchema(sqlite, schemaSql) {
  const target = expectedSchema(schemaSql);
  const expectedTables = Object.keys(target);
  const actualTables = tableNames(sqlite);
  const currentVersion = Number(sqlite.prepare('PRAGMA user_version').get().user_version);
  const issues = [];
  let knownLegacyRunColumn = false;

  if (currentVersion > CURRENT_KERNEL_SCHEMA_VERSION) {
    issues.push({ code: 'KERNEL_SCHEMA_VERSION_NEWER', current_version: currentVersion, target_version: CURRENT_KERNEL_SCHEMA_VERSION });
  }
  if (!sameColumns(actualTables, expectedTables)) {
    issues.push({ code: 'KERNEL_SCHEMA_TABLES_MISMATCH', expected: expectedTables, actual: actualTables });
  }
  for (const table of expectedTables.filter((name) => actualTables.includes(name))) {
    const expectedColumns = target[table];
    const actualColumns = tableColumns(sqlite, table);
    if (table === 'runs') {
      const withoutLegacy = actualColumns.filter((column) => column.name !== LEGACY_RUN_COLUMN);
      knownLegacyRunColumn = actualColumns.length === expectedColumns.length + 1
        && actualColumns.some((column) => column.name === LEGACY_RUN_COLUMN)
        && sameColumns(withoutLegacy, expectedColumns);
      if (knownLegacyRunColumn) continue;
    }
    if (!sameColumns(actualColumns, expectedColumns)) {
      issues.push({ code: 'KERNEL_SCHEMA_COLUMNS_MISMATCH', table, expected: expectedColumns, actual: actualColumns });
    }
  }

  return {
    currentVersion,
    targetVersion: CURRENT_KERNEL_SCHEMA_VERSION,
    issues,
    knownLegacyRunColumn,
    migrationRequired: currentVersion < CURRENT_KERNEL_SCHEMA_VERSION || knownLegacyRunColumn,
  };
}

export function migrateKernelSchema(sqlite, schemaSql) {
  const before = inspectKernelSchema(sqlite, schemaSql);
  if (before.issues.length) {
    throw Object.assign(new Error('Control Kernel schema differs from every supported layout'), {
      code: 'KERNEL_SCHEMA_UNSUPPORTED', details: before,
    });
  }
  if (!before.migrationRequired) return before;

  const foreignKeysEnabled = Number(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys) === 1;
  if (before.knownLegacyRunColumn && foreignKeysEnabled) sqlite.exec('PRAGMA foreign_keys=OFF');
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    if (before.knownLegacyRunColumn) {
      const replacement = 'runs_kernel_v1';
      const runColumns = expectedSchema(schemaSql).runs.map((column) => column.name);
      const columnList = runColumns.map((name) => `"${name}"`).join(', ');
      sqlite.exec(expectedTableSql(schemaSql, 'runs', replacement));
      sqlite.exec(`INSERT INTO ${replacement} (${columnList}) SELECT ${columnList} FROM runs`);
      sqlite.exec('DROP TABLE runs');
      sqlite.exec(`ALTER TABLE ${replacement} RENAME TO runs`);
      sqlite.exec(schemaSql);
      const violations = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw Object.assign(new Error('Control Kernel migration would violate foreign keys'), {
          code: 'KERNEL_SCHEMA_MIGRATION_FOREIGN_KEY_FAILED', details: { violations },
        });
      }
    }
    sqlite.exec(`PRAGMA user_version=${CURRENT_KERNEL_SCHEMA_VERSION}`);
    sqlite.exec('COMMIT');
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  } finally {
    if (before.knownLegacyRunColumn && foreignKeysEnabled) sqlite.exec('PRAGMA foreign_keys=ON');
  }
  return inspectKernelSchema(sqlite, schemaSql);
}
