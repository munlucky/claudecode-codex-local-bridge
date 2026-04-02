import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
	readCodexAuthFile,
	requireCodexLocalAuthFile,
} from '../../../src/bridge/codex/index.js'

const createdDirs: string[] = []

describe('Codex auth helpers', () => {
	afterEach(async () => {
		await Promise.all(
			createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
		)
	})

	test('local auth json is parsed', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'codex-auth-test-'))
		createdDirs.push(dir)
		const filePath = join(dir, 'auth.json')
		await writeFile(
			filePath,
			JSON.stringify({
				tokens: {
					access_token: 'access',
					refresh_token: 'refresh',
				},
			}),
			'utf8',
		)

		const parsed = await readCodexAuthFile(filePath)
		expect(parsed?.tokens.access_token).toBe('access')
		expect(parsed?.tokens.refresh_token).toBe('refresh')
	})

	test('missing auth file throws configuration error', async () => {
		await expect(requireCodexLocalAuthFile('C:\\does-not-exist\\auth.json')).rejects.toThrow(
			'Codex local auth 파일을 읽을 수 없습니다',
		)
	})
})
