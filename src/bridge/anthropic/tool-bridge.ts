import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
	AnthropicMessagesRequest,
	AnthropicToolDefinition,
} from '../../shared/types.js'

export interface AnthropicToolBridgeSession {
	workspaceRoot: string
	tools: AnthropicToolDefinition[]
}

export interface AnthropicToolBridgeHandle {
	configOverride: Record<string, unknown>
	serverName: string
	cleanup: () => Promise<void>
}

const TOOL_SERVER_NAME = 'anthropic_bridge'
const TOOL_SERVER_SCRIPT_PATH = fileURLToPath(
	new URL('./tool-server.ts', import.meta.url),
)

export async function createAnthropicToolBridge(
	request: AnthropicMessagesRequest,
	workspaceRoot: string,
): Promise<AnthropicToolBridgeHandle | null> {
	if (!request.tools?.length) {
		return null
	}

	const sessionDir = await mkdtemp(join(tmpdir(), 'anthropic-tools-'))
	const sessionFilePath = join(sessionDir, 'session.json')
	const bunCommand = Bun.which('bun') ?? 'bun'
	const session: AnthropicToolBridgeSession = {
		workspaceRoot,
		tools: request.tools,
	}

	await writeFile(sessionFilePath, JSON.stringify(session, null, 2), 'utf8')

	return {
		serverName: TOOL_SERVER_NAME,
		configOverride: {
			mcp_servers: {
				[TOOL_SERVER_NAME]: {
					command: bunCommand,
					args: ['run', TOOL_SERVER_SCRIPT_PATH, sessionFilePath],
				},
			},
		},
		cleanup: async () => {
			await rm(sessionDir, { recursive: true, force: true })
		},
	}
}
