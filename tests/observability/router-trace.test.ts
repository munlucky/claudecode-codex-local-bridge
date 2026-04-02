import { describe, expect, test } from 'bun:test'
import { buildRouterTraceContext } from '../../src/observability/index.js'

describe('buildRouterTraceContext', () => {
	test('uses upstream request id when present', () => {
		const headers = new Headers({
			'x-request-id': 'req-upstream-123',
			'x-claude-code-session-id': 'session-1',
		})

		const context = buildRouterTraceContext({
			method: 'POST',
			path: '/v1/messages',
			headers,
			request: {
				model: 'claude-opus-4-6',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hello' }],
				stream: true,
				tools: [
					{
						name: 'Read',
						input_schema: {},
					},
				],
			},
		})

		expect(context.router_request_id).toBe('req-upstream-123')
		expect(context.headers.x_claude_code_session_id).toBe('session-1')
		expect(context.tool_names).toEqual(['Read'])
	})

	test('preserves existing router request id on rebuild', () => {
		const headers = new Headers()

		const initial = buildRouterTraceContext({
			method: 'POST',
			path: '/v1/messages',
			headers,
		})

		const rebuilt = buildRouterTraceContext({
			method: 'POST',
			path: '/v1/messages',
			headers,
			routerRequestId: initial.router_request_id,
			request: {
				model: 'claude-opus-4-6',
				max_tokens: 64,
				messages: [{ role: 'user', content: 'hi' }],
			},
		})

		expect(rebuilt.router_request_id).toBe(initial.router_request_id)
		expect(rebuilt.message_count).toBe(1)
	})
})
