import { promises as fs } from 'fs';
import path from 'path';
import initSqlJs from './vendor/sql-wasm.js';

const DEFAULT_ALLOWED_PATH_PREFIXES = ['/files/', '/home/node/.n8n-files/'];
const FORBIDDEN_SQL_PATTERNS = [
	/\bINSERT\b/i,
	/\bUPDATE\b/i,
	/\bDELETE\b/i,
	/\bDROP\b/i,
	/\bALTER\b/i,
	/\bATTACH\b/i,
	/\bDETACH\b/i,
	/\bVACUUM\b/i,
	/\bREINDEX\b/i,
	/\bREPLACE\b/i,
	/\bTRUNCATE\b/i,
	/\bANALYZE\b/i,
	/\bLOAD_EXTENSION\b/i,
	/\.load/i,
];

export type SqliteInputMode = 'binary' | 'filePath';
export type SqliteReturnMode = 'items' | 'singleItem';

export interface SqliteQueryResult {
	rows: Array<Record<string, unknown>>;
	columns: string[];
	rowCount: number;
}

export interface SqliteOperationResult extends SqliteQueryResult {
	query: string;
}

let sqlJsPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | undefined;

export async function getSqlJs() {
	if (!sqlJsPromise) {
		sqlJsPromise = initSqlJs({
			locateFile: (file) => path.join(__dirname, 'vendor', file),
		});
	}

	return await sqlJsPromise;
}

export function getDefaultAllowedPathPrefixes() {
	return [...DEFAULT_ALLOWED_PATH_PREFIXES];
}

export function parseAllowedPathPrefixes(rawValue: string): string[] {
	const prefixes = rawValue
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean);

	return prefixes.length > 0 ? prefixes : getDefaultAllowedPathPrefixes();
}

export function parseQueryParameters(rawValue: string): unknown[] | Record<string, unknown> | undefined {
	const normalized = rawValue.trim();
	if (!normalized) {
		return undefined;
	}

	const parsed = JSON.parse(normalized) as unknown;
	if (Array.isArray(parsed)) {
		return parsed;
	}

	if (parsed !== null && typeof parsed === 'object') {
		return parsed as Record<string, unknown>;
	}

	throw new Error('Query parameters must be a JSON array or object.');
}

export function sanitizeSqlValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return {
			encoding: 'base64',
			length: value.length,
			data: Buffer.from(value).toString('base64'),
		};
	}

	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeSqlValue(entry));
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
				key,
				sanitizeSqlValue(entry),
			]),
		);
	}

	return value;
}

export async function readDatabaseBytesFromFile(
	databaseFilePath: string,
	allowedPrefixes: string[],
): Promise<{ bytes: Uint8Array; resolvedPath: string; fileName: string }> {
	const resolvedPath = await resolveSafeDatabaseFilePath(databaseFilePath, allowedPrefixes);
	const buffer = await fs.readFile(resolvedPath);

	return {
		bytes: new Uint8Array(buffer),
		resolvedPath,
		fileName: path.basename(resolvedPath),
	};
}

export function readDatabaseBytesFromBinary(
	buffer: Buffer | Uint8Array | undefined,
	propertyName: string,
	fileName?: string,
): { bytes: Uint8Array; fileName?: string } {
	if (!buffer) {
		throw new Error(`Binary property "${propertyName}" was not found.`);
	}

	return {
		bytes: buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
		fileName,
	};
}

export async function resolveSafeDatabaseFilePath(
	databaseFilePath: string,
	allowedPrefixes: string[],
): Promise<string> {
	if (!databaseFilePath.trim()) {
		throw new Error('Database file path is required.');
	}

	if (!path.isAbsolute(databaseFilePath)) {
		throw new Error('Database file path must be absolute.');
	}

	const segments = databaseFilePath.split(/[\\/]+/).filter(Boolean);
	if (segments.includes('..')) {
		throw new Error('Database file path may not contain ".." segments.');
	}

	const realFilePath = await fs.realpath(databaseFilePath);
	const normalizedPrefixes = await Promise.all(
		allowedPrefixes.map(async (prefix) => {
			const trimmed = prefix.trim();
			if (!trimmed) {
				return '';
			}

			try {
				return await fs.realpath(trimmed);
			} catch {
				return path.resolve(trimmed);
			}
		}),
	);

	const isAllowed = normalizedPrefixes
		.filter(Boolean)
		.some((prefix) => isPathWithinPrefix(realFilePath, prefix));

	if (!isAllowed) {
		throw new Error('Database file path is outside the allowed prefixes.');
	}

	return realFilePath;
}

export function validateReadOnlySql(rawSql: string): string {
	const sql = normalizeSql(rawSql);
	if (!sql) {
		throw new Error('SQL query must not be empty.');
	}

	if (containsMultipleStatements(sql)) {
		throw new Error('Only a single SQL statement is allowed.');
	}

	for (const pattern of FORBIDDEN_SQL_PATTERNS) {
		if (pattern.test(sql)) {
			throw new Error('The SQL statement is not allowed in read-only mode.');
		}
	}

	if (/^PRAGMA\b/i.test(sql)) {
		if (!/^PRAGMA\s+table_info\s*\(/i.test(sql)) {
			throw new Error('Only PRAGMA table_info(...) is allowed in read-only mode.');
		}

		return sql;
	}

	if (/^(SELECT|WITH)\b/i.test(sql)) {
		return sql;
	}

	throw new Error('Only SELECT, WITH ... SELECT, and PRAGMA table_info(...) are allowed.');
}

export async function runSqliteQuery(
	bytes: Uint8Array,
	rawSql: string,
	parameters?: unknown[] | Record<string, unknown>,
): Promise<SqliteOperationResult> {
	const sql = validateReadOnlySql(rawSql);
	const SQL = await getSqlJs();
	const db = new SQL.Database(bytes);

	try {
		const statement = db.prepare(sql);

		try {
			if (parameters) {
				statement.bind(parameters as never);
			}

			const columns = statement.getColumnNames();
			const rows: Array<Record<string, unknown>> = [];
			while (statement.step()) {
				rows.push(sanitizeSqlValue(statement.getAsObject()) as Record<string, unknown>);
			}

			return {
				query: sql,
				rows,
				columns,
				rowCount: rows.length,
			};
		} finally {
			statement.free();
		}
	} finally {
		db.close();
	}
}

export function buildListTablesQuery() {
	return `
SELECT name, type
FROM sqlite_master
WHERE type IN ('table', 'view')
ORDER BY type, name
`.trim();
}

export function buildDescribeTableQuery(tableName: string) {
	if (!tableName.trim()) {
		throw new Error('Table name is required.');
	}

	return `PRAGMA table_info(${quoteSqlIdentifier(tableName)});`;
}

function quoteSqlIdentifier(identifier: string) {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function containsMultipleStatements(sql: string) {
	const withoutTrailingSemicolon = sql.replace(/;\s*$/u, '');
	return withoutTrailingSemicolon.includes(';');
}

function normalizeSql(rawSql: string) {
	return stripSqlComments(rawSql).trim();
}

function stripSqlComments(sql: string) {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/--.*$/gm, ' ')
		.replace(/\s+/g, ' ');
}

function isPathWithinPrefix(targetPath: string, prefix: string) {
	const relative = path.relative(prefix, targetPath);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
