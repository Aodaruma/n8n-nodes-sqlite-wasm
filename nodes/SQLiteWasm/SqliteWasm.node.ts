import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	buildDescribeTableQuery,
	buildListTablesQuery,
	getDefaultAllowedPathPrefixes,
	parseAllowedPathPrefixes,
	parseQueryParameters,
	readDatabaseBytesFromBinary,
	readDatabaseBytesFromFile,
	runSqliteQuery,
} from './sqliteWasm.utils';

type SqliteOperation = 'queryDatabase' | 'listTables' | 'describeTable';
type SqliteInputMode = 'binary' | 'filePath';
type SqliteReturnMode = 'items' | 'singleItem';

interface SqliteDatabaseInput {
	inputMode: SqliteInputMode;
	bytes: Uint8Array;
	fileName?: string;
	resolvedPath?: string;
	allowedPathPrefixes?: string[];
}

export class SqliteWasm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SQLite WASM',
		name: 'sqliteWasm',
		icon: { light: 'file:sqliteWasm.svg', dark: 'file:sqliteWasm.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Query SQLite databases in read-only mode via sql.js (WASM)',
		defaults: {
			name: 'SQLite WASM',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Describe Table',
						value: 'describeTable',
					},
					{
						name: 'List Tables',
						value: 'listTables',
					},
					{
						name: 'Query Database',
						value: 'queryDatabase',
					},
				],
				default: 'queryDatabase',
			},
			{
				displayName: 'Input Mode',
				name: 'inputMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Binary',
						value: 'binary',
					},
					{
						name: 'File Path',
						value: 'filePath',
					},
				],
				default: 'binary',
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: {
					show: {
						inputMode: ['binary'],
					},
				},
			},
			{
				displayName: 'Database File Path',
				name: 'databaseFilePath',
				type: 'string',
				default: '',
				placeholder: '/files/example.db',
				displayOptions: {
					show: {
						inputMode: ['filePath'],
					},
				},
			},
			{
				displayName: 'Allowed Path Prefixes',
				name: 'allowedPathPrefixes',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: getDefaultAllowedPathPrefixes().join('\n'),
				description: 'Absolute prefixes allowed in file path mode, one per line',
				displayOptions: {
					show: {
						inputMode: ['filePath'],
					},
				},
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: 'SELECT name FROM sqlite_master ORDER BY name;',
				displayOptions: {
					show: {
						operation: ['queryDatabase'],
					},
				},
			},
			{
				displayName: 'Query Parameters',
				name: 'queryParameters',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				placeholder: '["value"] or {"name":"value"}',
				description: 'Optional JSON array or object passed to the prepared statement',
				displayOptions: {
					show: {
						operation: ['queryDatabase'],
					},
				},
			},
			{
				displayName: 'Table Name',
				name: 'tableName',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['describeTable'],
					},
				},
			},
			{
				displayName: 'Return Mode',
				name: 'returnMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Items',
						value: 'items',
						description: 'Return one n8n item per row',
					},
					{
						name: 'Single Item',
						value: 'singleItem',
						description: 'Return one item containing rows and metadata',
					},
				],
				default: 'items',
			},
			{
				displayName: 'Fail On Error',
				name: 'failOnError',
				type: 'boolean',
				default: false,
				description: 'Whether to throw instead of returning a structured error payload',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const failOnError = this.getNodeParameter('failOnError', itemIndex, false) as boolean;

			try {
				const operation = this.getNodeParameter('operation', itemIndex) as SqliteOperation;
				const returnMode = this.getNodeParameter('returnMode', itemIndex, 'items') as SqliteReturnMode;
				const database = await getDatabaseInput.call(this, itemIndex);
				const result = await executeOperation.call(this, itemIndex, operation, database.bytes);

				if (returnMode === 'singleItem') {
					returnData.push({
						json: {
							ok: true,
							source: 'sqliteWasm',
							operation,
							inputMode: database.inputMode,
							fileName: database.fileName ?? null,
							resolvedPath: database.resolvedPath ?? null,
							allowedPathPrefixes: database.allowedPathPrefixes ?? null,
							...result,
						} as IDataObject,
						pairedItem: itemIndex,
					});
					continue;
				}

				for (const row of result.rows) {
					returnData.push({
						json: row as IDataObject,
						pairedItem: itemIndex,
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown SQLite error';

				if (failOnError && !this.continueOnFail()) {
					throw new NodeOperationError(this.getNode(), message, { itemIndex });
				}

				returnData.push({
					json: {
						ok: false,
						source: 'sqliteWasm',
						error: {
							message,
						},
						rows: [],
						columns: [],
						rowCount: 0,
					} as IDataObject,
					pairedItem: itemIndex,
				});
			}
		}

		return [returnData];
	}
}

async function getDatabaseInput(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<SqliteDatabaseInput> {
	const inputMode = this.getNodeParameter('inputMode', itemIndex) as SqliteInputMode;

	if (inputMode === 'binary') {
		const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;
		const binaryData = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
		const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
		const input = readDatabaseBytesFromBinary(buffer, binaryPropertyName, binaryData.fileName);

		return {
			inputMode,
			bytes: input.bytes,
			fileName: input.fileName,
		};
	}

	const databaseFilePath = this.getNodeParameter('databaseFilePath', itemIndex) as string;
	const rawAllowedPathPrefixes = this.getNodeParameter('allowedPathPrefixes', itemIndex) as string;
	const allowedPathPrefixes = parseAllowedPathPrefixes(rawAllowedPathPrefixes);
	const input = await readDatabaseBytesFromFile(databaseFilePath, allowedPathPrefixes);

	return {
		inputMode,
		bytes: input.bytes,
		fileName: input.fileName,
		resolvedPath: input.resolvedPath,
		allowedPathPrefixes,
	};
}

async function executeOperation(
	this: IExecuteFunctions,
	itemIndex: number,
	operation: SqliteOperation,
	bytes: Uint8Array,
) {
	if (operation === 'listTables') {
		return await runSqliteQuery(bytes, buildListTablesQuery());
	}

	if (operation === 'describeTable') {
		const tableName = this.getNodeParameter('tableName', itemIndex) as string;
		return await runSqliteQuery(bytes, buildDescribeTableQuery(tableName));
	}

	const query = this.getNodeParameter('query', itemIndex) as string;
	const queryParameters = this.getNodeParameter('queryParameters', itemIndex, '') as string;
	const parameters = parseQueryParameters(queryParameters);

	return await runSqliteQuery(bytes, query, parameters);
}
