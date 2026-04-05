import { buildAnonymousConversationSeed } from '../bridge/anthropic/index.js'
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RouterConfig } from '../server/index.js'
import type { AnthropicMessagesRequest } from '../shared/index.js'
import type { RouterTraceContext } from './router-trace.js'

type CapturedAnthropicRequest = {
	timestamp: string
	router_request_id: string
	method: string
	path: string
	started_at: string
	header_names: string[]
	headers: RouterTraceContext['headers']
	model: string | null
	stream: boolean | null
	message_count: number | null
	tool_count: number
	tool_names: string[]
	tool_choice: unknown
	tools: unknown
	anonymous_conversation_seed: string | null
	body_parse_error?: string
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|authorization|password|secret|cookie)/i
const ABSOLUTE_PATH_PATTERN =
	/([A-Za-z]:\\[^"'`\s]+|\/(?:Users|home|tmp|var|opt|etc|mnt|srv)\/[^"'`\s]+)/g

export function redactSensitiveValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return value
			.replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED_TOKEN]')
			.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED_TOKEN]')
			.replace(ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]')
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactSensitiveValue(item))
	}

	if (!value || typeof value !== 'object') {
		return value
	}

	const object = value as Record<string, unknown>
	return Object.fromEntries(
		Object.entries(object).map(([key, entryValue]) => [
			key,
			SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSensitiveValue(entryValue),
		]),
	)
}

async function enforceCapturePolicy(path: string, maxFileBytes: number, retentionDays: number) {
	await mkdir(dirname(path), { recursive: true })
	const existing = await stat(path).catch(() => null)
	if (existing && maxFileBytes > 0 && existing.size >= maxFileBytes) {
		const rotatedPath = join(
			dirname(path),
			`${basename(path, '.jsonl')}.${Date.now()}.jsonl`,
		)
		await rename(path, rotatedPath).catch(() => undefined)
	}

	if (retentionDays <= 0) {
		return
	}

	const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
	const directoryEntries = await readdir(dirname(path), { withFileTypes: true }).catch(() => [])
	for (const entry of directoryEntries) {
		if (!entry.isFile() || !entry.name.startsWith(basename(path, '.jsonl'))) {
			continue
		}

		const entryPath = join(dirname(path), entry.name)
		const entryStat = await stat(entryPath).catch(() => null)
		if (entryStat && entryStat.mtimeMs < cutoffMs) {
			await unlink(entryPath).catch(() => undefined)
		}
	}
}

function toCapturedRecord(
	context: RouterTraceContext,
	body: unknown,
	parseError?: string,
): CapturedAnthropicRequest {
	const payload =
		body && typeof body === 'object' && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: {}

	const tools = Array.isArray(payload.tools) ? payload.tools : []
	const typedRequest =
		body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(payload.messages)
			? (body as AnthropicMessagesRequest)
			: null
	const toolNames = tools
		.map((tool) =>
			tool && typeof tool === 'object' && !Array.isArray(tool) && typeof tool.name === 'string'
				? tool.name
				: null,
		)
		.filter((name): name is string => Boolean(name))

	return {
		timestamp: new Date().toISOString(),
		router_request_id: context.router_request_id,
		method: context.method,
		path: context.path,
		started_at: context.started_at,
		header_names: context.header_names,
		headers: redactSensitiveValue(context.headers) as RouterTraceContext['headers'],
		model: context.model,
		stream: context.stream,
		message_count: context.message_count,
		tool_count: context.tool_count,
		tool_names: toolNames.length ? toolNames : context.tool_names,
		tool_choice: redactSensitiveValue(payload.tool_choice ?? null),
		tools: redactSensitiveValue(tools),
		anonymous_conversation_seed: typedRequest
			? buildAnonymousConversationSeed(typedRequest)
			: null,
		...(parseError ? { body_parse_error: parseError } : {}),
	}
}

export async function captureAnthropicRequest(
	config: RouterConfig,
	input: {
		traceContext: RouterTraceContext
		rawBody: string
		parsedRequest?: AnthropicMessagesRequest
		parseError?: string
	},
) {
	if (!config.captureRequests) {
		return
	}

	let body: unknown = input.parsedRequest
	let parseError = input.parseError

	if (!body) {
		try {
			body = JSON.parse(input.rawBody) as unknown
		} catch (error) {
			parseError =
				parseError ?? (error instanceof Error ? error.message : 'JSON parse failed')
			body = {}
		}
	}

	const record = toCapturedRecord(input.traceContext, body, parseError)
	await enforceCapturePolicy(
		config.captureRequestsPath,
		config.captureMaxFileBytes,
		config.captureRetentionDays,
	)
	await appendFile(
		config.captureRequestsPath,
		`${JSON.stringify(redactSensitiveValue(record))}\n`,
		'utf8',
	)

	if ((body as { tools?: unknown[] }).tools?.length) {
		process.stdout.write(
			`[router] ${new Date().toISOString()} captured request_id=${record.router_request_id} tools=${JSON.stringify(record.tool_names)} path=${config.captureRequestsPath}\n`,
		)
	}
}
