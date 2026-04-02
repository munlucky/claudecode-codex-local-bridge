import type { RouterConfig } from './config.js'
import {
	createCodexAnthropicStream,
	type StreamLifecycleLogger,
} from '../bridge/codex/index.js'
import type { AnthropicMessagesRequest } from '../shared/index.js'

export function createAnthropicStream(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	logger?: StreamLifecycleLogger,
): ReadableStream<Uint8Array> {
	return createCodexAnthropicStream(config, request, logger)
}
