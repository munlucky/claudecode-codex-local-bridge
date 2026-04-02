import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../../src/server/index.js'

describe('loadConfig', () => {
	test('defaults auth mode to local auth json for this bridge', () => {
		delete process.env.CODEX_AUTH_MODE
		delete process.env.API_TIMEOUT_MS
		delete process.env.CODEX_TURN_TIMEOUT_MS

		const config = loadConfig()

		expect(config.codexAuthMode).toBe('local_auth_json')
		expect(config.codexTurnTimeoutMs).toBe(180000)
	})

	test('caps idle timeout to Bun maximum', () => {
		process.env.API_TIMEOUT_MS = '3000000'
		delete process.env.CODEX_TURN_TIMEOUT_MS
		delete process.env.ROUTER_IDLE_TIMEOUT_SEC

		const config = loadConfig()

		expect(config.codexTurnTimeoutMs).toBe(3000000)
		expect(config.serverIdleTimeoutSec).toBe(255)
	})

	test('enables request capture by default', () => {
		delete process.env.ROUTER_CAPTURE_REQUESTS
		delete process.env.ROUTER_CAPTURE_REQUESTS_PATH
		delete process.env.ROUTER_CAPTURE_RESPONSES
		delete process.env.ROUTER_CAPTURE_RESPONSES_PATH

		const config = loadConfig()

		expect(config.captureRequests).toBe(true)
		expect(config.captureRequestsPath.endsWith('anthropic-requests.jsonl')).toBe(true)
		expect(config.captureResponses).toBe(true)
		expect(config.captureResponsesPath.endsWith('anthropic-responses.jsonl')).toBe(true)
	})

	test('allows explicit disabled auth mode override', () => {
		process.env.CODEX_AUTH_MODE = 'disabled'

		const config = loadConfig()

		expect(config.codexAuthMode).toBe('disabled')
	})
})
