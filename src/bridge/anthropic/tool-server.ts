import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import type { AnthropicToolDefinition } from '../../shared/types.js'
import type { AnthropicToolBridgeSession } from './tool-bridge.js'

type JsonRpcMessage = {
	id?: number | string
	method?: string
	params?: Record<string, unknown>
}

type TextContent = {
	type: 'text'
	text: string
}

type ToolCallResult = {
	content: TextContent[]
	isError: boolean
}

const sessionFilePath = process.argv[2]

if (!sessionFilePath) {
	throw new Error('session file path is required')
}

const rawSession = await readFile(sessionFilePath, 'utf8')
const session = JSON.parse(rawSession) as AnthropicToolBridgeSession
const toolCatalog = new Map(
	session.tools.map((tool) => [normalizeToolName(tool.name), tool] as const),
)

function send(message: Record<string, unknown>) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase()
}

function toAbsolutePath(inputPath: string | undefined): string {
	const raw = inputPath?.trim()
	if (!raw) {
		return session.workspaceRoot
	}

	return isAbsolute(raw) ? resolve(raw) : resolve(session.workspaceRoot, raw)
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}
}

function asString(value: unknown): string | null {
	return typeof value === 'string' ? value : null
}

function summarizeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function ok(text: string): ToolCallResult {
	return {
		content: [{ type: 'text', text }],
		isError: false,
	}
}

function fail(text: string): ToolCallResult {
	return {
		content: [{ type: 'text', text }],
		isError: true,
	}
}

async function walkFiles(rootPath: string): Promise<string[]> {
	const entries = await readdir(rootPath, { withFileTypes: true })
	const collected: string[] = []

	for (const entry of entries) {
		const fullPath = resolve(rootPath, entry.name)
		if (entry.isDirectory()) {
			collected.push(...(await walkFiles(fullPath)))
			continue
		}

		if (entry.isFile()) {
			collected.push(fullPath)
		}
	}

	return collected
}

async function globFiles(pattern: string, basePath?: string): Promise<string[]> {
	const cwd = toAbsolutePath(basePath)
	const glob = new Bun.Glob(pattern)
	const matches: string[] = []

	for await (const relativePath of glob.scan({ cwd, dot: true })) {
		const absolutePath = resolve(cwd, relativePath)
		const entryStat = await stat(absolutePath).catch(() => null)
		if (entryStat?.isFile()) {
			matches.push(absolutePath)
		}
	}

	return matches.sort((left, right) => left.localeCompare(right))
}

function withLineNumbers(content: string, offset = 0, limit?: number): string {
	const lines = content.split(/\r?\n/)
	const start = Math.max(0, offset)
	const end = typeof limit === 'number' ? Math.min(lines.length, start + limit) : lines.length

	return lines
		.slice(start, end)
		.map((line, index) => `${start + index + 1}\t${line}`)
		.join('\n')
}

async function handleRead(argumentsObject: Record<string, unknown>): Promise<ToolCallResult> {
	const filePath = asString(argumentsObject.file_path)
	if (!filePath) {
		return fail('Read 도구는 file_path 가 필요하다.')
	}

	const absolutePath = toAbsolutePath(filePath)
	const targetStat = await stat(absolutePath).catch(() => null)
	if (!targetStat) {
		return fail(`파일을 찾을 수 없다: ${absolutePath}`)
	}
	if (!targetStat.isFile()) {
		return fail(`디렉터리는 Read 로 읽을 수 없다: ${absolutePath}`)
	}

	if (extname(absolutePath).toLowerCase() === '.pdf') {
		return fail('PDF pages 파라미터 기반 읽기는 아직 브리지 MCP 서버에서 지원하지 않는다.')
	}

	const content = await readFile(absolutePath, 'utf8').catch((error: unknown) => {
		throw new Error(error instanceof Error ? error.message : String(error))
	})

	const offset = typeof argumentsObject.offset === 'number' ? argumentsObject.offset : 0
	const limit = typeof argumentsObject.limit === 'number' ? argumentsObject.limit : undefined
	const numbered = withLineNumbers(content, offset, limit)

	return ok(numbered || '[empty file]')
}

async function handleGlob(argumentsObject: Record<string, unknown>): Promise<ToolCallResult> {
	const pattern = asString(argumentsObject.pattern)
	if (!pattern) {
		return fail('Glob 도구는 pattern 이 필요하다.')
	}

	const basePath = asString(argumentsObject.path) ?? session.workspaceRoot
	const matches = await globFiles(pattern, basePath)
	return ok(matches.length ? matches.join('\n') : '[no matches]')
}

function buildRegex(argumentsObject: Record<string, unknown>): RegExp {
	const pattern = asString(argumentsObject.pattern) ?? ''
	const insensitive = argumentsObject['-i'] === true ? 'i' : ''
	const multiline = argumentsObject.multiline === true ? 'ms' : 'm'
	return new RegExp(pattern, `${insensitive}${multiline}`)
}

function applySlice<T>(items: T[], offset: number, headLimit: number): T[] {
	const start = Math.max(0, offset)
	if (headLimit === 0) {
		return items.slice(start)
	}
	return items.slice(start, start + headLimit)
}

async function handleGrep(argumentsObject: Record<string, unknown>): Promise<ToolCallResult> {
	const regex = buildRegex(argumentsObject)
	const basePath = asString(argumentsObject.path) ?? session.workspaceRoot
	const globPattern = asString(argumentsObject.glob)
	const outputMode = asString(argumentsObject.output_mode) ?? 'files_with_matches'
	const headLimit = typeof argumentsObject.head_limit === 'number' ? argumentsObject.head_limit : 250
	const offset = typeof argumentsObject.offset === 'number' ? argumentsObject.offset : 0

	const candidateFiles = globPattern
		? await globFiles(globPattern, basePath)
		: await walkFiles(toAbsolutePath(basePath))

	const fileMatches: Array<{ filePath: string; matches: string[]; count: number }> = []

	for (const filePath of candidateFiles) {
		const content = await readFile(filePath, 'utf8').catch(() => null)
		if (content === null) {
			continue
		}

		const lines = content.split(/\r?\n/)
		const lineMatches = lines
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => regex.test(line))
			.map(({ line, index }) => `${index + 1}:${line}`)

		if (argumentsObject.multiline === true && lineMatches.length === 0 && regex.test(content)) {
			fileMatches.push({ filePath, matches: [content], count: 1 })
			continue
		}

		if (lineMatches.length) {
			fileMatches.push({
				filePath,
				matches: lineMatches,
				count: lineMatches.length,
			})
		}
	}

	if (outputMode === 'count') {
		const rows = applySlice(
			fileMatches.map((entry) => `${entry.filePath}:${entry.count}`),
			offset,
			headLimit,
		)
		return ok(rows.length ? rows.join('\n') : '[no matches]')
	}

	if (outputMode === 'content') {
		const rows = applySlice(
			fileMatches.flatMap((entry) => entry.matches.map((match) => `${entry.filePath}:${match}`)),
			offset,
			headLimit,
		)
		return ok(rows.length ? rows.join('\n') : '[no matches]')
	}

	const rows = applySlice(
		fileMatches.map((entry) => entry.filePath),
		offset,
		headLimit,
	)
	return ok(rows.length ? rows.join('\n') : '[no matches]')
}

async function runShellCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const processHandle = Bun.spawn(['powershell', '-NoLogo', '-NoProfile', '-Command', command], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	})

	const timeout = setTimeout(() => {
		processHandle.kill()
	}, timeoutMs)

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]).finally(() => {
		clearTimeout(timeout)
	})

	return {
		stdout: stdout.trim(),
		stderr: stderr.trim(),
		exitCode,
	}
}

async function handleBash(argumentsObject: Record<string, unknown>): Promise<ToolCallResult> {
	const command = asString(argumentsObject.command)
	if (!command) {
		return fail('Bash 도구는 command 가 필요하다.')
	}

	const timeoutMs = typeof argumentsObject.timeout === 'number' ? argumentsObject.timeout : 120000
	const cwd = session.workspaceRoot
	const result = await runShellCommand(command, cwd, timeoutMs)

	const lines = [
		`exit_code: ${result.exitCode}`,
		'stdout:',
		result.stdout || '[empty]',
	]

	if (result.stderr) {
		lines.push('stderr:', result.stderr)
	}

	return result.exitCode === 0 ? ok(lines.join('\n')) : fail(lines.join('\n'))
}

async function handleEdit(argumentsObject: Record<string, unknown>): Promise<ToolCallResult> {
	const filePath = asString(argumentsObject.file_path)
	const oldString = asString(argumentsObject.old_string)
	const newString = asString(argumentsObject.new_string)
	const replaceAll = argumentsObject.replace_all === true

	if (!filePath || oldString === null || newString === null) {
		return fail('Edit 도구는 file_path, old_string, new_string 이 필요하다.')
	}

	const absolutePath = toAbsolutePath(filePath)
	const content = await readFile(absolutePath, 'utf8').catch(() => null)
	if (content === null) {
		return fail(`편집할 파일을 읽을 수 없다: ${absolutePath}`)
	}

	const occurrences = content.split(oldString).length - 1
	if (occurrences === 0) {
		return fail('old_string 이 파일에 존재하지 않는다.')
	}

	if (!replaceAll && occurrences > 1) {
		return fail('old_string 이 여러 번 등장한다. 더 구체적인 문자열이나 replace_all 이 필요하다.')
	}

	const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
	await writeFile(absolutePath, updated, 'utf8')

	return ok(`updated: ${absolutePath}\nreplacements: ${replaceAll ? occurrences : 1}`)
}

async function handleWrite(argumentsObject: Record<string, unknown>): Promise<ToolCallResult> {
	const filePath = asString(argumentsObject.file_path)
	const content = asString(argumentsObject.content)
	if (!filePath || content === null) {
		return fail('Write 도구는 file_path 와 content 가 필요하다.')
	}

	const absolutePath = toAbsolutePath(filePath)
	await mkdir(dirname(absolutePath), { recursive: true })
	await writeFile(absolutePath, content, 'utf8')

	return ok(`written: ${absolutePath}`)
}

function handleToolSearch(argumentsObject: Record<string, unknown>): ToolCallResult {
	const query = (asString(argumentsObject.query) ?? '').trim().toLowerCase()
	const maxResults = typeof argumentsObject.max_results === 'number' ? argumentsObject.max_results : 5

	const selected =
		query.startsWith('select:')
			? query
					.slice('select:'.length)
					.split(',')
					.map((name) => name.trim())
					.filter(Boolean)
			: []

	const tools = session.tools.filter((tool) => {
		if (selected.length) {
			return selected.includes(normalizeToolName(tool.name))
		}

		if (!query) {
			return true
		}

		return (
			normalizeToolName(tool.name).includes(query) ||
			(tool.description ?? '').toLowerCase().includes(query)
		)
	})

	return ok(
		tools
			.slice(0, maxResults)
			.map((tool) =>
				JSON.stringify(
					{
						name: tool.name,
						description: tool.description ?? '',
						input_schema: tool.input_schema,
					},
					null,
					2,
				),
			)
			.join('\n\n') || '[no matching tools]',
	)
}

function handleUnsupportedMetaTool(toolName: string, argumentsObject: Record<string, unknown>): ToolCallResult {
	return fail(
		`${toolName} meta tool은 bridge MCP 서버에서 완전한 실행기를 아직 제공하지 않는다.\narguments:\n${summarizeJson(argumentsObject)}`,
	)
}

function decorateDescription(tool: AnthropicToolDefinition): string {
	const normalizedName = normalizeToolName(tool.name)
	if (normalizedName === 'agent' || normalizedName === 'skill') {
		return `${tool.description ?? ''}\n\n[bridge note] meta tool support is limited in the local bridge runtime.`
	}

	return tool.description ?? ''
}

function listTools() {
	return session.tools.map((tool) => ({
		name: tool.name,
		description: decorateDescription(tool),
		inputSchema: tool.input_schema,
	}))
}

async function dispatchToolCall(toolName: string, argumentsObject: Record<string, unknown>): Promise<ToolCallResult> {
	switch (normalizeToolName(toolName)) {
		case 'read':
		case 'read_file':
			return handleRead(argumentsObject)
		case 'glob':
			return handleGlob(argumentsObject)
		case 'grep':
			return handleGrep(argumentsObject)
		case 'bash':
			return handleBash(argumentsObject)
		case 'edit':
			return handleEdit(argumentsObject)
		case 'write':
			return handleWrite(argumentsObject)
		case 'toolsearch':
			return handleToolSearch(argumentsObject)
		case 'agent':
		case 'skill':
			return handleUnsupportedMetaTool(toolName, argumentsObject)
		default: {
			const known = toolCatalog.get(normalizeToolName(toolName))
			return fail(
				known
					? `브리지에는 '${toolName}' schema 만 있고 실제 실행기는 없다.`
					: `알 수 없는 도구: ${toolName}`,
			)
		}
	}
}

process.stdin.setEncoding('utf8')
let stdinBuffer = ''

process.stdin.on('data', async (chunk: string) => {
	stdinBuffer += chunk

	while (true) {
		const newlineIndex = stdinBuffer.indexOf('\n')
		if (newlineIndex < 0) {
			break
		}

		const line = stdinBuffer.slice(0, newlineIndex).trim()
		stdinBuffer = stdinBuffer.slice(newlineIndex + 1)
		if (!line) {
			continue
		}

		let message: JsonRpcMessage
		try {
			message = JSON.parse(line) as JsonRpcMessage
		} catch {
			continue
		}

		try {
			if (message.method === 'initialize') {
				send({
					id: message.id,
					result: {
						protocolVersion: '2025-03-26',
						capabilities: { tools: {} },
						serverInfo: { name: 'anthropic-tools-mcp', version: '1.0.0' },
					},
				})
				continue
			}

			if (message.method === 'notifications/initialized') {
				continue
			}

			if (message.method === 'tools/list') {
				send({
					id: message.id,
					result: {
						tools: listTools(),
					},
				})
				continue
			}

			if (message.method === 'tools/call') {
				const params = asObject(message.params)
				const toolName = asString(params.name)
				if (!toolName) {
					send({
						id: message.id,
						result: fail('tools/call requires name'),
					})
					continue
				}

				send({
					id: message.id,
					result: await dispatchToolCall(toolName, asObject(params.arguments)),
				})
				continue
			}

			send({
				id: message.id,
				error: {
					code: -32601,
					message: `Unknown method: ${message.method ?? '[none]'}`,
				},
			})
		} catch (error) {
			send({
				id: message.id,
				result: fail(error instanceof Error ? error.message : String(error)),
			})
		}
	}
})
