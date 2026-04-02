import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RouterConfig } from '../server/index.js'
import type {
	AnthropicMessagesRequest,
	CodexBridgeDecision,
} from '../shared/index.js'

export interface RouterTraceContext {
	router_request_id: string
	method: string
	path: string
	started_at: string
	headers: {
		user_agent: string | null
		anthropic_beta: string | null
		x_claude_code_session_id: string | null
		x_request_id: string | null
	}
	model: string | null
	stream: boolean | null
	message_count: number | null
	tool_count: number
	tool_names: string[]
}

export interface RouterResponseTrace {
	status: number
	duration_ms: number
	stop_reason?: string | null
	error_type?: string
	error_message?: string
	codex_model?: string | null
	usage_output_tokens?: number | null
	conversation_id?: string | null
	stream_end_reason?: string | null
	decision_kind?: CodexBridgeDecision['kind'] | null
	tool_use_name?: string | null
}

function getHeader(headers: Headers, key: string): string | null {
	const value = headers.get(key)
	return value && value.trim() ? value.trim() : null
}

export function buildRouterTraceContext(input: {
	method: string
	path: string
	headers: Headers
	request?: AnthropicMessagesRequest
	routerRequestId?: string
}): RouterTraceContext {
	const request = input.request
	const tools = Array.isArray(request?.tools) ? request.tools : []
	const upstreamRequestId = getHeader(input.headers, 'x-request-id')

	return {
		router_request_id:
			input.routerRequestId || upstreamRequestId || `routerreq_${crypto.randomUUID()}`,
		method: input.method,
		path: input.path,
		started_at: new Date().toISOString(),
		headers: {
			user_agent: getHeader(input.headers, 'user-agent'),
			anthropic_beta: getHeader(input.headers, 'anthropic-beta'),
			x_claude_code_session_id: getHeader(input.headers, 'x-claude-code-session-id'),
			x_request_id: upstreamRequestId,
		},
		model: typeof request?.model === 'string' ? request.model : null,
		stream: typeof request?.stream === 'boolean' ? request.stream : null,
		message_count: Array.isArray(request?.messages) ? request.messages.length : null,
		tool_count: tools.length,
		tool_names: tools
			.map((tool) => (typeof tool?.name === 'string' ? tool.name : null))
			.filter((name): name is string => Boolean(name)),
	}
}

async function appendJsonLine(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true })
	await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

export function logRouterLine(message: string) {
	console.log(`[router] ${new Date().toISOString()} ${message}`)
}

export async function captureRouterResponse(
	config: RouterConfig,
	context: RouterTraceContext,
	response: RouterResponseTrace,
) {
	if (!config.captureResponses) {
		return
	}

	await appendJsonLine(config.captureResponsesPath, {
		timestamp: new Date().toISOString(),
		type: 'response',
		...context,
		...response,
	})
}

export async function captureRouterStreamEvent(
	config: RouterConfig,
	context: RouterTraceContext,
	event: {
		stream_phase: 'opened' | 'completed' | 'failed' | 'cancelled'
		duration_ms: number
		status: number
		stream_end_reason?: string | null
		error_message?: string
		codex_model?: string | null
		conversation_id?: string | null
		usage_output_tokens?: number | null
		decision_kind?: CodexBridgeDecision['kind'] | null
		tool_use_name?: string | null
	},
) {
	if (!config.captureResponses) {
		return
	}

	await appendJsonLine(config.captureResponsesPath, {
		timestamp: new Date().toISOString(),
		type: 'stream',
		...context,
		...event,
	})
}
