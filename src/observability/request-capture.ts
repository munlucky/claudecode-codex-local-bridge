import { buildAnonymousConversationSeed } from '../bridge/anthropic/index.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
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
		headers: context.headers,
		model: context.model,
		stream: context.stream,
		message_count: context.message_count,
		tool_count: context.tool_count,
		tool_names: toolNames.length ? toolNames : context.tool_names,
		tool_choice: payload.tool_choice ?? null,
		tools,
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
	await mkdir(dirname(config.captureRequestsPath), { recursive: true })
	await appendFile(
		config.captureRequestsPath,
		`${JSON.stringify(record)}\n`,
		'utf8',
	)

	if ((body as { tools?: unknown[] }).tools?.length) {
		console.log(
			`[router] ${new Date().toISOString()} captured request_id=${record.router_request_id} tools=${JSON.stringify(record.tool_names)} path=${config.captureRequestsPath}`,
		)
	}
}
