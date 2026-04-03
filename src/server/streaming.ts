import type { RouterConfig } from './config.js'
import {
	createCodexAnthropicStream,
	type CodexRequestContext,
	type StreamLifecycleLogger,
} from '../bridge/codex/index.js'
import type { AnthropicMessagesRequest } from '../shared/index.js'

export function createAnthropicStream(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	context?: CodexRequestContext,
	logger?: StreamLifecycleLogger,
): ReadableStream<Uint8Array> {
	return createCodexAnthropicStream(config, request, context, logger)
}
