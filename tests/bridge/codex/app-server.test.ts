import { describe, expect, test } from 'bun:test'
import {
	buildAnonymousThreadCacheKey,
	buildThreadCacheKey,
	buildThreadFingerprint,
} from '../../../src/bridge/codex/app-server.js'

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
