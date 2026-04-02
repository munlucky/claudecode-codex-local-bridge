export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
	[key: string]: JsonValue
}

export interface AnthropicTextBlock {
	type: 'text'
	text: string
}

export interface AnthropicThinkingBlock {
	type: 'thinking'
	thinking: string
	signature?: string
}

export interface AnthropicToolUseBlock {
	type: 'tool_use'
	id: string
	name: string
	input: JsonValue
}

export interface AnthropicToolResultBlock {
	type: 'tool_result'
	tool_use_id: string
	content: string | AnthropicInputContentBlock[]
}

export interface AnthropicImageBlock {
	type: 'image'
	source: {
		type: 'base64'
		media_type: string
		data: string
	}
}

export type AnthropicInputContentBlock =
	| AnthropicTextBlock
	| AnthropicThinkingBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicImageBlock

export interface AnthropicMessage {
	role: 'user' | 'assistant'
	content: string | AnthropicInputContentBlock[]
}

export interface AnthropicThinkingConfig {
	type: 'enabled'
	budget_tokens: number
}

export interface AnthropicToolDefinition {
	name: string
	description?: string
	input_schema: JsonObject
}

export type AnthropicToolChoice =
	| 'auto'
	| 'any'
	| 'none'
	| {
			type: 'tool'
			name: string
	  }
	| {
			type: 'none'
	  }

export interface AnthropicMessagesRequest {
	model: string
	max_tokens: number
	messages: AnthropicMessage[]
	system?: string | AnthropicInputContentBlock[]
	stream?: boolean
	tools?: AnthropicToolDefinition[]
	tool_choice?: AnthropicToolChoice
	thinking?: AnthropicThinkingConfig
	temperature?: number
	top_p?: number
	top_k?: number
}

export interface AnthropicUsage {
	input_tokens: number
	output_tokens: number
}

export type AnthropicResponseContentBlock =
	| AnthropicTextBlock
	| AnthropicThinkingBlock
	| AnthropicToolUseBlock

export interface AnthropicMessagesResponse {
	id: string
	type: 'message'
	role: 'assistant'
	model: string
	content: AnthropicResponseContentBlock[]
	stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
	stop_sequence: string | null
	usage: AnthropicUsage
}

export interface CodexBridgeAssistantDecision {
	kind: 'assistant'
	text: string
}

export interface CodexBridgeToolUseDecision {
	kind: 'tool_use'
	name: string
	input: JsonObject
	preamble?: string
}

export type CodexBridgeDecision =
	| CodexBridgeAssistantDecision
	| CodexBridgeToolUseDecision

export interface CodexTokenUsage {
	inputTokens: number
	cachedInputTokens: number
	outputTokens: number
	reasoningOutputTokens: number
	totalTokens: number
}

export interface CodexTurnResult {
	id: string
	model: string
	text: string
	usage: CodexTokenUsage
	decision?: CodexBridgeDecision | null
}

export interface RouterHealthResponse {
	status: 'ok'
	backend: 'codex_app_server'
	auth_mode: 'api_key' | 'local_auth_json' | 'disabled'
	codex_command: string
	codex_runtime_cwd: string
	codex_auth_file: string
	has_local_auth_file: boolean
}
