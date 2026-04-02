import { describe, expect, test } from 'bun:test'
import { createAnthropicToolBridge } from '../../../src/bridge/anthropic/index.js'

describe('createAnthropicToolBridge', () => {
	test('creates MCP config override when Anthropic tools are present', async () => {
		const bridge = await createAnthropicToolBridge(
			{
				model: 'claude-sonnet-4-5-20250929',
				max_tokens: 256,
				messages: [{ role: 'user', content: 'hello' }],
				tools: [
					{
						name: 'Read',
						description: 'Read a file',
						input_schema: {
							type: 'object',
							properties: {
								file_path: { type: 'string' },
							},
						},
					},
				],
			},
			'C:\\dev\\not-claude-code-emulator',
		)

		expect(bridge).not.toBeNull()
		expect(bridge?.serverName).toBe('anthropic_bridge')
		expect(bridge?.configOverride).toHaveProperty('mcp_servers')

		await bridge?.cleanup()
	})
})
