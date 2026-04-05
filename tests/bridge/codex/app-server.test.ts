import { describe, expect, test } from 'bun:test'
import {
	buildAnonymousThreadCacheKey,
	classifyCodexError,
	CodexAbortError,
	CodexTimeoutError,
	buildThreadCacheKey,
	buildThreadFingerprint,
	isCacheLifetimeExceeded,
} from '../../../src/bridge/codex/app-server.js'
import { AuthConfigurationError } from '../../../src/bridge/codex/auth.js'

describe('thread reuse helpers', () => {
	test('buildThreadCacheKey includes workspace and session id', () => {
		expect(buildThreadCacheKey('session-1', '/tmp/project')).toBe(
			'/tmp/project::session-1',
		)
		expect(buildThreadCacheKey(null, '/tmp/project')).toBeNull()
	})

	test('buildAnonymousThreadCacheKey uses workspace and user agent', () => {
		expect(
			buildAnonymousThreadCacheKey('Claude-CLI/2.1.81', '/tmp/project', 'abc123'),
		).toBe(
			'anonymous::/tmp/project::claude-cli/2.1.81::abc123',
		)
		expect(buildAnonymousThreadCacheKey(null, '/tmp/project', 'abc123')).toBeNull()
		expect(buildAnonymousThreadCacheKey('Claude-CLI/2.1.81', '/tmp/project', null)).toBeNull()
	})

	test('buildThreadFingerprint changes when reuse-relevant inputs change', () => {
		const baseline = buildThreadFingerprint(
			'gpt-5.4',
			'workspace-write',
			'developer instructions',
		)

		expect(
			buildThreadFingerprint('gpt-5.4-mini', 'workspace-write', 'developer instructions'),
		).not.toBe(baseline)
		expect(
			buildThreadFingerprint('gpt-5.4', 'read-only', 'developer instructions'),
		).not.toBe(baseline)
		expect(
			buildThreadFingerprint('gpt-5.4', 'workspace-write', 'different instructions'),
		).not.toBe(baseline)
	})
})

describe('cache lifetime helpers', () => {
	test('expires when idle ttl is exceeded', () => {
		expect(
			isCacheLifetimeExceeded(
				0,
				5_000,
				{ idleTtlMs: 1_000, maxLifetimeMs: 10_000 },
				7_000,
			),
		).toBe(true)
	})

	test('expires when max lifetime is exceeded even if recently used', () => {
		expect(
			isCacheLifetimeExceeded(
				0,
				9_500,
				{ idleTtlMs: 5_000, maxLifetimeMs: 10_000 },
				10_500,
			),
		).toBe(true)
	})

	test('stays valid while both lifetime budgets remain within bounds', () => {
		expect(
			isCacheLifetimeExceeded(
				0,
				8_000,
				{ idleTtlMs: 5_000, maxLifetimeMs: 10_000 },
				9_000,
			),
		).toBe(false)
	})
})

describe('retry classification', () => {
	test('treats abort and auth errors as non-retryable', () => {
		expect(classifyCodexError(new CodexAbortError())).toBe('non_retryable')
		expect(classifyCodexError(new AuthConfigurationError('auth'))).toBe('non_retryable')
	})

	test('treats timeout errors as retryable', () => {
		expect(classifyCodexError(new CodexTimeoutError('turn_start', 1000, 'turn/start'))).toBe(
			'retryable',
		)
	})
})
