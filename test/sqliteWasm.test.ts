import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteWasm } from '../nodes/SQLiteWasm/SqliteWasm.node';
import initSqlJs from '../nodes/SQLiteWasm/vendor/sql-wasm.js';
import {
	buildDescribeTableQuery,
	buildListTablesQuery,
	readDatabaseBytesFromBinary,
	readDatabaseBytesFromFile,
	runSqliteQuery,
} from '../nodes/SQLiteWasm/sqliteWasm.utils';

const tempDirs: string[] = [];

async function createSampleDatabase() {
	const SQL = await initSqlJs({
		locateFile: (file) => path.join(process.cwd(), 'nodes', 'SQLiteWasm', 'vendor', file),
	});
	const db = new SQL.Database();
	db.run('CREATE TABLE steps (date TEXT PRIMARY KEY, steps INTEGER);');
	db.run('INSERT INTO steps (date, steps) VALUES (?, ?), (?, ?);', [
		'2026-06-10',
		12345,
		'2026-06-11',
		9876,
	]);
	const bytes = db.export();
	db.close();
	return bytes;
}

describe('sqliteWasm.utils', () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
	});

	it('queries a sample database', async () => {
		const bytes = await createSampleDatabase();
		const result = await runSqliteQuery(
			bytes,
			'SELECT date, steps FROM steps ORDER BY date ASC;',
		);

		expect(result.rowCount).toBe(2);
		expect(result.columns).toEqual(['date', 'steps']);
		expect(result.rows[0]).toEqual({ date: '2026-06-10', steps: 12345 });
	});

	it('reads database bytes from binary input', async () => {
		const bytes = await createSampleDatabase();
		const binary = readDatabaseBytesFromBinary(Buffer.from(bytes), 'data', 'health_connect.db');
		const result = await runSqliteQuery(binary.bytes, buildListTablesQuery());

		expect(binary.fileName).toBe('health_connect.db');
		expect(result.rows).toEqual([{ name: 'steps', type: 'table' }]);
	});

	it('rejects forbidden SQL', async () => {
		const bytes = await createSampleDatabase();

		await expect(runSqliteQuery(bytes, 'DROP TABLE steps;')).rejects.toThrow(
			'read-only mode',
		);
	});

	it('rejects malformed SQL', async () => {
		const bytes = await createSampleDatabase();

		await expect(runSqliteQuery(bytes, 'SELECT FROM steps')).rejects.toThrow();
	});

	it('throws when binary data is missing', () => {
		expect(() => readDatabaseBytesFromBinary(undefined, 'data')).toThrow(
			'Binary property "data" was not found.',
		);
	});

	it('reads a database from an allowed file path', async () => {
		const bytes = await createSampleDatabase();
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-wasm-'));
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, 'sample.db');
		await writeFile(filePath, Buffer.from(bytes));

		const result = await readDatabaseBytesFromFile(filePath, [tempDir]);
		const describe = await runSqliteQuery(result.bytes, buildDescribeTableQuery('steps'));

		expect(result.fileName).toBe('sample.db');
		expect(describe.rowCount).toBe(2);
	});

	it('exports the node class name expected by the n8n loader', () => {
		expect(SqliteWasm.name).toBe('SqliteWasm');
	});
});
