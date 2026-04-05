import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
	buildAnonymousConversationSeed,
	buildCodexPromptMetrics,
	buildCodexDeveloperInstructions,
	buildStableBridgeSessionId,
	buildThreadInvariantInput,
	collectRequestTextSegments,
	parseCodexBridgeDecision,
	resolveModelAlias,
	serializeAnthropicRequestToCodexPrompt,
} from '../anthropic/index.js'
import { AuthConfigurationError, requireCodexLocalAuthFile } from './auth.js'
import type { RouterConfig } from '../../server/config.js'
import type {
	AnthropicMessagesRequest,
	CodexTokenUsage,
	CodexTurnResult,
	CodexBridgeDecision,
	CodexPromptMetrics,
	CodexTurnMetadata,
	CodexThreadReuseReason,
	JsonValue,
} from '../../shared/index.js'

type JsonRpcResult = Record<string, unknown>
type JsonRpcNotification = {
	method?: string
	params?: Record<string, unknown>
}

type PendingRequest = {
	resolve: (value: JsonRpcResult) => void
	reject: (error: Error) => void
	timeout: Timer
}

type RetryClassification = 'retryable' | 'non_retryable'

type TimeoutStage =
	| 'session_initialize'
	| 'thread_start'
	| 'turn_start'
	| 'first_token'
	| 'turn_complete'

type SessionCloseReason =
	| 'closed'
	| 'process_exit'
	| 'stderr'
	| 'request_failed'
	| 'client_abort'
	| 'cache_evicted'

type CacheTtlPolicy = {
	idleTtlMs: number
	maxLifetimeMs: number
}

export interface CodexRequestContext {
	sessionId?: string | null
	routerRequestId?: string | null
	userAgent?: string | null
	abortSignal?: AbortSignal | null
}

export interface StreamLifecycleLogger {
	onSessionReady?: (metadata: CodexTurnMetadata & { model: string }) => void | Promise<void>
	onComplete?: (payload: {
		stopReason: 'end_turn' | 'tool_use'
		usage: CodexTokenUsage
		promptMetrics: CodexPromptMetrics
		finalText: string
		decision: CodexBridgeDecision | null
		metadata: CodexTurnMetadata & { model: string }
	}) => void | Promise<void>
	onError?: (payload: {
		error: unknown
		metadata?: Partial<CodexTurnMetadata & { model: string }>
	}) => void | Promise<void>
	onCancel?: (payload: {
		metadata?: Partial<CodexTurnMetadata & { model: string }>
	}) => void | Promise<void>
}

const ZERO_USAGE: CodexTokenUsage = {
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
	totalTokens: 0,
}

const THREAD_CACHE_LIMIT = 128
const SESSION_CACHE_IDLE_TTL_MS = 60 * 60 * 1000
const SESSION_CACHE_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000
const ANONYMOUS_THREAD_TTL_MS = 30 * 60 * 1000
const ANONYMOUS_THREAD_MAX_LIFETIME_MS = 90 * 60 * 1000
const EPHEMERAL_SESSION_TTL_MS = 30 * 60 * 1000
const TURN_FIRST_TOKEN_TIMEOUT_MS = 30 * 1000
const MAX_RETRY_ATTEMPTS = 3
const RETRY_BACKOFF_BASE_MS = 250
const RETRY_BACKOFF_MAX_MS = 2000

type ThreadCacheRecord = {
	session: CodexAppServerSession
	threadId: string
	model: string
	reasoningEffort: string | null
	fingerprint: string
	lastMessageCount: number
	transcriptHash: string
	createdAt: number
	lastUsedAt: number
	updatedAt: number
	failureCount: number
	busy: boolean
	waiters: Array<() => void>
	idleTimer: Timer | null
	ttlPolicy: CacheTtlPolicy
	closed: boolean
}

type EphemeralSessionRecord = {
	sessionId: string
	updatedAt: number
	idleTimer: Timer | null
}

type PreparedSession = {
	session: CodexAppServerSession
	threadId: string
	model: string
	reasoningEffort: string | null
	promptText: string
	promptMetrics: CodexPromptMetrics
	workspaceRoot: string
	metadata: CodexTurnMetadata
	requestContext: Required<CodexRequestContext>
	cacheRecord: ThreadCacheRecord | null
	cacheKey: string | null
	cleanup: () => Promise<void>
}

const threadCache = new Map<string, ThreadCacheRecord>()
const pendingThreadCacheCreates = new Map<string, Promise<ThreadCacheRecord>>()
const ephemeralSessionCache = new Map<string, EphemeralSessionRecord>()
const runtimeCounters = {
	retryableFailures: 0,
	nonRetryableFailures: 0,
	retries: 0,
}

export function getCodexBridgeRuntimeSnapshot() {
	return {
		activeSessionCount: threadCache.size,
		pendingSessionCreates: pendingThreadCacheCreates.size,
		queueDepth: Array.from(threadCache.values()).reduce(
			(total, record) => total + record.waiters.length + (record.busy ? 1 : 0),
			0,
		),
		recentRetryableFailures: runtimeCounters.retryableFailures,
		recentNonRetryableFailures: runtimeCounters.nonRetryableFailures,
		recentRetries: runtimeCounters.retries,
	}
}

function hashMessages(messages: AnthropicMessagesRequest['messages']): string {
	return createHash('sha1').update(JSON.stringify(messages)).digest('hex')
}

function updateThreadCacheProgress(
	cacheKey: string | null,
	record: ThreadCacheRecord | null,
	messages: AnthropicMessagesRequest['messages'],
) {
	if (!cacheKey || !record) {
		return
	}

	record.lastMessageCount = messages.length
	record.transcriptHash = hashMessages(messages)
	record.lastUsedAt = Date.now()
	record.updatedAt = Date.now()
	upsertThreadCache(cacheKey, record)
}

function normalizeRequestContext(context?: CodexRequestContext): Required<CodexRequestContext> {
	return {
		sessionId: context?.sessionId?.trim() || null,
		routerRequestId: context?.routerRequestId?.trim() || null,
		userAgent: context?.userAgent?.trim() || null,
		abortSignal: context?.abortSignal ?? null,
	}
}

export function buildThreadCacheKey(sessionId: string | null, workspaceRoot: string): string | null {
	return sessionId ? `${workspaceRoot}::${sessionId}` : null
}

export function buildAnonymousThreadCacheKey(
	userAgent: string | null,
	workspaceRoot: string,
	conversationSeed: string | null,
): string | null {
	return userAgent && conversationSeed
		? `anonymous::${workspaceRoot}::${userAgent.toLowerCase()}::${conversationSeed}`
		: null
}

function buildEphemeralSessionScopeKey(
	userAgent: string | null,
	workspaceRoot: string,
): string | null {
	return userAgent ? `ephemeral::${workspaceRoot}::${userAgent.toLowerCase()}` : null
}

export function buildThreadFingerprint(
	targetModel: string,
	sandboxMode: RouterConfig['codexSandboxMode'],
	threadInvariantInput: string,
): string {
	return createHash('sha1')
		.update(targetModel)
		.update('\n')
		.update(sandboxMode)
		.update('\n')
		.update(threadInvariantInput)
		.digest('hex')
}

export function isCacheLifetimeExceeded(
	createdAt: number,
	lastUsedAt: number,
	policy: CacheTtlPolicy,
	now = Date.now(),
): boolean {
	return now - lastUsedAt > policy.idleTtlMs || now - createdAt > policy.maxLifetimeMs
}

export class CodexAbortError extends Error {
	constructor(message = '요청이 취소되었습니다.') {
		super(message)
		this.name = 'CodexAbortError'
	}
}

export class CodexTimeoutError extends Error {
	readonly stage: TimeoutStage

	constructor(stage: TimeoutStage, timeoutMs: number, operation: string) {
		super(`${operation} 작업이 ${timeoutMs}ms 내에 완료되지 않았습니다.`)
		this.name = 'CodexTimeoutError'
		this.stage = stage
	}
}

export class CodexProcessStartError extends Error {
	readonly classification: RetryClassification

	constructor(message: string, classification: RetryClassification = 'retryable') {
		super(message)
		this.name = 'CodexProcessStartError'
		this.classification = classification
	}
}

export function classifyCodexError(error: unknown): RetryClassification {
	if (error instanceof AuthConfigurationError || error instanceof CodexAbortError) {
		return 'non_retryable'
	}

	if (error instanceof FreshThreadRetryRequiredError || error instanceof CodexTimeoutError) {
		return 'retryable'
	}

	if (error instanceof CodexProcessStartError) {
		return error.classification
	}

	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
	if (
		message.includes('시간 초과') ||
		message.includes('timeout') ||
		message.includes('econnreset') ||
		message.includes('broken pipe') ||
		message.includes('프로세스가 종료') ||
		message.includes('stderr')
	) {
		return 'retryable'
	}

	return 'non_retryable'
}

function computeRetryDelay(attempt: number): number {
	const capped = Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * 2 ** attempt)
	return capped + Math.floor(Math.random() * 100)
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

function abortErrorFromSignal(signal: AbortSignal): CodexAbortError {
	return new CodexAbortError(signal.reason instanceof Error ? signal.reason.message : '요청이 취소되었습니다.')
}

function throwIfAborted(signal: AbortSignal | null | undefined) {
	if (signal?.aborted) {
		throw abortErrorFromSignal(signal)
	}
}

function createAbortPromise(signal: AbortSignal | null | undefined): Promise<never> {
	if (!signal) {
		return new Promise<never>(() => {})
	}

	if (signal.aborted) {
		return Promise.reject(abortErrorFromSignal(signal))
	}

	return new Promise<never>((_, reject) => {
		const handleAbort = () => {
			signal.removeEventListener('abort', handleAbort)
			reject(abortErrorFromSignal(signal))
		}
		signal.addEventListener('abort', handleAbort, { once: true })
	})
}

function upsertThreadCache(cacheKey: string, record: ThreadCacheRecord) {
	threadCache.delete(cacheKey)
	threadCache.set(cacheKey, record)

	if (threadCache.size <= THREAD_CACHE_LIMIT) {
		return
	}

	for (const [oldestKey, oldestRecord] of threadCache.entries()) {
		if (oldestKey === cacheKey || oldestRecord.busy) {
			continue
		}

		void closeThreadCacheRecord(oldestKey, oldestRecord)
		break
	}
}

function clearIdleTimer(record: ThreadCacheRecord) {
	if (!record.idleTimer) {
		return
	}

	clearTimeout(record.idleTimer)
	record.idleTimer = null
}

function clearEphemeralSessionIdleTimer(record: EphemeralSessionRecord) {
	if (!record.idleTimer) {
		return
	}

	clearTimeout(record.idleTimer)
	record.idleTimer = null
}

function scheduleEphemeralSessionEviction(scopeKey: string, record: EphemeralSessionRecord) {
	clearEphemeralSessionIdleTimer(record)
	record.idleTimer = setTimeout(() => {
		clearEphemeralSessionIdleTimer(record)
		if (ephemeralSessionCache.get(scopeKey) === record) {
			ephemeralSessionCache.delete(scopeKey)
		}
	}, EPHEMERAL_SESSION_TTL_MS)
}

function getOrCreateEphemeralSessionId(
	userAgent: string | null,
	workspaceRoot: string,
): string | null {
	const scopeKey = buildEphemeralSessionScopeKey(userAgent, workspaceRoot)
	if (!scopeKey) {
		return null
	}

	const now = Date.now()
	const cached = ephemeralSessionCache.get(scopeKey)
	if (cached && now - cached.updatedAt <= EPHEMERAL_SESSION_TTL_MS) {
		cached.updatedAt = now
		scheduleEphemeralSessionEviction(scopeKey, cached)
		return cached.sessionId
	}

	if (cached) {
		clearEphemeralSessionIdleTimer(cached)
		ephemeralSessionCache.delete(scopeKey)
	}

	const record: EphemeralSessionRecord = {
		sessionId: `bridge-ephemeral-${crypto.randomUUID()}`,
		updatedAt: now,
		idleTimer: null,
	}
	ephemeralSessionCache.set(scopeKey, record)
	scheduleEphemeralSessionEviction(scopeKey, record)
	return record.sessionId
}

async function closeThreadCacheRecord(cacheKey: string, record: ThreadCacheRecord) {
	if (record.closed) {
		return
	}
	record.closed = true
	clearIdleTimer(record)
	if (threadCache.get(cacheKey) === record) {
		threadCache.delete(cacheKey)
	}
	if (pendingThreadCacheCreates.get(cacheKey)) {
		pendingThreadCacheCreates.delete(cacheKey)
	}
	record.busy = false
	while (record.waiters.length > 0) {
		record.waiters.shift()?.()
	}
	record.session.close('cache_evicted')
}

function scheduleIdleEviction(cacheKey: string, record: ThreadCacheRecord) {
	clearIdleTimer(record)
	record.idleTimer = setTimeout(() => {
		void closeThreadCacheRecord(cacheKey, record)
	}, record.ttlPolicy.idleTtlMs)
}

async function waitForThreadCacheRecord(record: ThreadCacheRecord) {
	if (!record.busy) {
		return
	}

	await new Promise<void>((resolve) => {
		record.waiters.push(resolve)
	})
}

async function releaseThreadCacheRecord(cacheKey: string, record: ThreadCacheRecord) {
	if (record.closed) {
		return
	}
	record.updatedAt = Date.now()
	record.lastUsedAt = record.updatedAt
	record.busy = false
	const waiter = record.waiters.shift()
	if (waiter) {
		waiter()
		return
	}

	scheduleIdleEviction(cacheKey, record)
}

function logBridgeThreadEvent(
	event: string,
	input: {
		requestContext: Required<CodexRequestContext>
		metadata: CodexTurnMetadata
		model: string
		extra?: Record<string, string | null | undefined>
	},
) {
	const pairs = [
		`request_id=${input.requestContext.routerRequestId ?? 'none'}`,
		`session_id=${input.requestContext.sessionId ?? 'none'}`,
		`conversation_id=${input.metadata.threadId}`,
		`workspace_root=${JSON.stringify(input.metadata.workspaceRoot)}`,
		`model=${input.model}`,
		`thread_mode=${input.metadata.threadMode}`,
		`thread_reuse_reason=${input.metadata.threadReuseReason}`,
		`thread_cache_key=${input.metadata.threadCacheKey ?? 'none'}`,
		`thread_fingerprint=${input.metadata.threadFingerprint}`,
	]

	for (const [key, value] of Object.entries(input.extra ?? {})) {
		if (value !== undefined) {
			pairs.push(`${key}=${value ?? 'null'}`)
		}
	}

	process.stdout.write(`[router] ${new Date().toISOString()} ${event} ${pairs.join(' ')}\n`)
}

function createDeferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
	let called = false
	return async () => {
		if (called) {
			return
		}
		called = true
		await action()
	}
}

function getObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function getString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizeUsage(value: unknown): CodexTokenUsage {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { ...ZERO_USAGE }
	}

	const usage = value as Record<string, unknown>
	return {
		inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
		cachedInputTokens:
			typeof usage.cachedInputTokens === 'number' ? usage.cachedInputTokens : 0,
		outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
		reasoningOutputTokens:
			typeof usage.reasoningOutputTokens === 'number' ? usage.reasoningOutputTokens : 0,
		totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : 0,
	}
}

function getTurnUsage(params: Record<string, unknown> | undefined): CodexTokenUsage | null {
	const tokenUsage = getObject(params?.tokenUsage)
	if (!tokenUsage) {
		return null
	}

	const last = getObject(tokenUsage.last)
	return last ? normalizeUsage(last) : null
}

function getItemText(item: Record<string, unknown> | null): string | null {
	const direct = getString(item?.text)
	if (direct) {
		return direct
	}

	const content = Array.isArray(item?.content) ? item.content : null
	if (!content) {
		return null
	}

	const text = content
		.map((part) => {
			const block = getObject(part)
			return getString(block?.text)
		})
		.filter((value): value is string => Boolean(value))
		.join('')

	return text.length > 0 ? text : null
}

function formatSse(event: string, payload: unknown): Uint8Array {
	return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function formatSseComment(comment: string): Uint8Array {
	return new TextEncoder().encode(`: ${comment}\n\n`)
}

function getReadableStream(
	stream: ReturnType<typeof Bun.spawn>['stdout'] | ReturnType<typeof Bun.spawn>['stderr'],
	label: string,
): ReadableStream<Uint8Array> {
	if (stream instanceof ReadableStream) {
		return stream
	}

	throw new Error(`${label} 스트림을 읽을 수 없습니다.`)
}

function getWritableStdin(stream: ReturnType<typeof Bun.spawn>['stdin']) {
	if (stream && typeof stream === 'object' && 'write' in stream) {
		return stream
	}

	throw new Error('codex app-server stdin 에 쓸 수 없습니다.')
}

function normalizeWorkspaceCandidate(rawPath: string): string | null {
	const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, '')
	if (!trimmed) {
		return null
	}

	try {
		const resolved = resolve(trimmed)
		if (!existsSync(resolved)) {
			return null
		}

		const stats = lstatSync(resolved)
		return stats.isDirectory() ? resolved : dirname(resolved)
	} catch {
		return null
	}
}

function inferWorkspaceRoot(config: RouterConfig, request: AnthropicMessagesRequest): string {
	const pathRegex = /([A-Za-z]:\\[^<>:"|?*\r\n]+(?:\.[^\\/\s'"]+)?)|([A-Za-z]:\/[^\r\n'"]+)/g
	const segments = collectRequestTextSegments(request)

	for (const segment of segments) {
		const matches = segment.match(pathRegex) ?? []
		for (const match of matches) {
			const workspace = normalizeWorkspaceCandidate(match)
			if (workspace) {
				return workspace
			}
		}
	}

	return config.codexRuntimeCwd
}

function buildSandboxPolicy(
	sandboxMode: RouterConfig['codexSandboxMode'],
): 'read-only' | 'workspace-write' | 'danger-full-access' {
	return sandboxMode
}

function buildTurnSandboxPolicy(
	sandboxMode: RouterConfig['codexSandboxMode'],
):
	| { type: 'readOnly' }
	| {
			type: 'workspaceWrite'
			networkAccess: boolean
			excludeTmpdirEnvVar: boolean
			excludeSlashTmp: boolean
	  }
	| { type: 'dangerFullAccess' } {
	switch (sandboxMode) {
		case 'read-only':
			return { type: 'readOnly' }
		case 'danger-full-access':
			return { type: 'dangerFullAccess' }
		default:
			return {
				type: 'workspaceWrite',
				networkAccess: true,
				excludeTmpdirEnvVar: false,
				excludeSlashTmp: false,
			}
	}
}

const ALLOWED_AUTH_METHODS = ['chatgpt', 'chatgptAuthTokens', 'chatgpt_auth_tokens'] as const

class CodexAppServerSession {
	private readonly process: ReturnType<typeof Bun.spawn>
	private readonly encoder = new TextEncoder()
	private readonly decoder = new TextDecoder()
	private readonly pending = new Map<number, PendingRequest>()
	private readonly listeners = new Set<(notification: JsonRpcNotification) => void>()
	private readonly closeListeners = new Set<(reason: SessionCloseReason, detail?: string) => void>()
	private nextId = 1
	private buffer = ''
	private closed = false
	private closeDetail: string | null = null
	private lastExitCode: number | null = null

	private constructor(config: RouterConfig) {
		const executable = Bun.which(config.codexCommand) ?? config.codexCommand
		const env = { ...process.env }
		if (config.codexOpenAiApiKey) {
			env.OPENAI_API_KEY = config.codexOpenAiApiKey
		}

		this.process = Bun.spawn([executable, 'app-server'], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		})
		this.processStdout()
		this.processStderr()
		void this.process.exited.then((code) => {
			this.lastExitCode = typeof code === 'number' ? code : null
			this.failAll(
				new CodexProcessStartError(
					`codex app-server 프로세스가 종료되었습니다.${this.lastExitCode !== null ? ` (exit=${this.lastExitCode})` : ''}`,
				),
				'process_exit',
				this.lastExitCode !== null ? `exit=${this.lastExitCode}` : undefined,
			)
		})
	}

	static async create(config: RouterConfig): Promise<CodexAppServerSession> {
		const session = new CodexAppServerSession(config)
		try {
			await session.request(
				'initialize',
				{
					clientInfo: {
						name: 'claudecode-codex-local-bridge',
						version: '2.0.0',
					},
				},
				config.codexInitTimeoutMs,
				'session_initialize',
			)
			session.notify('initialized', {})
			return session
		} catch (error) {
			session.close('request_failed')
			throw error
		}
	}

	private processStdout() {
		void (async () => {
			const reader = getReadableStream(this.process.stdout, 'stdout').getReader()
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) {
						break
					}

					this.buffer += this.decoder.decode(value, { stream: true })
					while (true) {
						const newlineIndex = this.buffer.indexOf('\n')
						if (newlineIndex < 0) {
							break
						}

						const line = this.buffer.slice(0, newlineIndex).trim()
						this.buffer = this.buffer.slice(newlineIndex + 1)
						if (!line) {
							continue
						}

						this.handleLine(line)
					}
				}
			} finally {
				reader.releaseLock()
			}
		})()
	}

	private processStderr() {
		void (async () => {
			const text = (await new Response(getReadableStream(this.process.stderr, 'stderr')).text()).trim()
			if (text && !this.closed) {
				this.failAll(new CodexProcessStartError(text), 'stderr', text)
			}
		})()
	}

	private handleLine(line: string) {
		let message: Record<string, unknown>
		try {
			message = JSON.parse(line) as Record<string, unknown>
		} catch {
			return
		}

		if (typeof message.id === 'number') {
			const pending = this.pending.get(message.id)
			if (!pending) {
				return
			}

			clearTimeout(pending.timeout)
			this.pending.delete(message.id)
			if (message.error && typeof message.error === 'object') {
				const errorObject = message.error as Record<string, unknown>
				pending.reject(new Error(getString(errorObject.message) ?? 'codex app-server 오류'))
				return
			}

			pending.resolve(getObject(message.result) ?? {})
			return
		}

		const notification: JsonRpcNotification = {
			method: getString(message.method) ?? undefined,
			params: getObject(message.params) ?? undefined,
		}
		for (const listener of this.listeners) {
			listener(notification)
		}
	}

	notify(method: string, params: Record<string, unknown>) {
		if (this.closed) {
			throw new Error('codex app-server 세션이 닫혔습니다.')
		}

		getWritableStdin(this.process.stdin).write(
			this.encoder.encode(`${JSON.stringify({ method, params })}\n`),
		)
	}

	private failAll(
		error: Error,
		reason: SessionCloseReason = 'closed',
		detail?: string,
	) {
		if (this.closed) {
			return
		}
		this.closed = true
		this.closeDetail = detail ?? null
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout)
			pending.reject(error)
		}
		this.pending.clear()
		for (const listener of this.closeListeners) {
			listener(reason, this.closeDetail ?? undefined)
		}
		this.closeListeners.clear()
	}

	addListener(listener: (notification: JsonRpcNotification) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number,
		stage: TimeoutStage = 'turn_complete',
	): Promise<JsonRpcResult> {
		if (this.closed) {
			return Promise.reject(new Error('codex app-server 세션이 닫혔습니다.'))
		}

		const id = this.nextId++
		const deferred = createDeferred<JsonRpcResult>()
		const timeout = setTimeout(() => {
			this.pending.delete(id)
			deferred.reject(new CodexTimeoutError(stage, timeoutMs, method))
		}, timeoutMs)

		this.pending.set(id, {
			resolve: deferred.resolve,
			reject: deferred.reject,
			timeout,
		})
		getWritableStdin(this.process.stdin).write(
			this.encoder.encode(`${JSON.stringify({ id, method, params })}\n`),
		)
		return deferred.promise
	}

	close(reason: SessionCloseReason = 'closed') {
		if (this.closed) {
			return
		}

		this.failAll(new Error('codex app-server 세션이 종료되었습니다.'), reason)
		this.process.kill()
	}

	isClosed() {
		return this.closed
	}

	getLastExitCode() {
		return this.lastExitCode
	}

	addCloseListener(listener: (reason: SessionCloseReason, detail?: string) => void): () => void {
		this.closeListeners.add(listener)
		return () => {
			this.closeListeners.delete(listener)
		}
	}
}

function isLegacyAuthMethodAllowed(value: unknown): value is (typeof ALLOWED_AUTH_METHODS)[number] {
	const authMethod = getString(value)
	return authMethod !== null && ALLOWED_AUTH_METHODS.includes(authMethod as (typeof ALLOWED_AUTH_METHODS)[number])
}

function hasAccountIdentity(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false
	}

	const object = value as Record<string, unknown>
	if (getString(object.account_id) || getString(object.id) || getString(object.email)) {
		return true
	}

	const account = getObject(object.account)
	if (!account) {
		return Object.keys(object).length > 0
	}

	return Boolean(getString(account.account_id) || getString(account.id) || getString(account.email))
}

async function hasAccountSession(session: CodexAppServerSession, timeoutMs: number): Promise<boolean> {
	try {
		const accountRead = await session.request('account/read', {}, timeoutMs, 'session_initialize')
		return hasAccountIdentity(accountRead.account) || hasAccountIdentity(accountRead)
	} catch {
		return false
	}
}

async function hasLegacySession(session: CodexAppServerSession, timeoutMs: number): Promise<boolean> {
	try {
		const authStatus = await session.request(
			'getAuthStatus',
			{
				includeToken: false,
				refreshToken: true,
			},
			timeoutMs,
			'session_initialize',
		)
		const authMethod = authStatus.authMethod
		return isLegacyAuthMethodAllowed(authMethod)
	} catch {
		return false
	}
}

export async function checkCodexAuthDependency(
	config: RouterConfig,
	timeoutMs = 1500,
): Promise<boolean> {
	let session: CodexAppServerSession | null = null
	try {
		session = await CodexAppServerSession.create(config)
		const accountResult = await hasAccountSession(session, timeoutMs)
		if (accountResult) {
			return true
		}

		return await hasLegacySession(session, timeoutMs)
	} catch {
		return false
	} finally {
		session?.close()
	}
}

function buildAuthErrorMessage(config: RouterConfig): string {
	switch (config.codexAuthMode) {
		case 'api_key':
			return 'CODEX_OPENAI_API_KEY(또는 OPENAI_API_KEY)가 필요합니다.'
		case 'account':
			return 'Codex account 인증이 필요합니다. account/read/login 흐름을 확인하세요.'
		case 'local_auth_json':
			return 'Codex local auth 상태가 활성화되어 있지 않습니다.'
		default:
			return 'Codex 인증 정보가 충분하지 않습니다.'
	}
}

async function requireCodexAuthReady(
	session: CodexAppServerSession,
	config: RouterConfig,
): Promise<void> {
	const needsOpenAiApiKey = config.codexAuthMode === 'api_key'
	const needsLocalFile = config.codexAuthMode === 'local_auth_json'

	if (needsLocalFile) {
		await requireCodexLocalAuthFile(config.codexAuthFile)
	}

	if (needsOpenAiApiKey) {
		if (!config.codexOpenAiApiKey) {
			throw new AuthConfigurationError(buildAuthErrorMessage(config))
		}
		return
	}

	if (config.codexAuthMode === 'disabled') {
		return
	}

	const hasAccount = await hasAccountSession(session, config.codexInitTimeoutMs)
	if (hasAccount) {
		return
	}

	const hasLegacy = await hasLegacySession(session, config.codexInitTimeoutMs)
	if (hasLegacy) {
		return
	}

	throw new AuthConfigurationError(buildAuthErrorMessage(config))
}

async function startThread(
	session: CodexAppServerSession,
	config: RouterConfig,
	input: {
		workspaceRoot: string
		targetModel: string
		developerInstructions: string
	},
) {
	const threadStart = await session.request(
		'thread/start',
		{
			model: input.targetModel,
			cwd: input.workspaceRoot,
			approvalPolicy: 'never',
			sandbox: buildSandboxPolicy(config.codexSandboxMode),
			baseInstructions:
				'You are serving as an Anthropic-compatible backend through a local bridge.',
			developerInstructions: input.developerInstructions,
		},
		config.codexInitTimeoutMs,
		'thread_start',
	)

	const thread = getObject(threadStart.thread)
	const threadId = getString(thread?.id)
	if (!threadId) {
		throw new Error('thread/start 응답에 thread.id 가 없습니다.')
	}

	return {
		threadId,
		model: getString(threadStart.model) ?? input.targetModel,
		reasoningEffort: getString(threadStart.reasoningEffort),
	}
}

async function createCachedSession(
	config: RouterConfig,
): Promise<CodexAppServerSession> {
	const session = await CodexAppServerSession.create(config)
	await requireCodexAuthReady(session, config)
	return session
}


async function createThreadCacheRecord(
	config: RouterConfig,
	input: {
		cacheKey: string
		workspaceRoot: string
		targetModel: string
		developerInstructions: string
		threadFingerprint: string
		lastMessageCount: number
		transcriptHash: string
		ttlMs: CacheTtlPolicy
	},
): Promise<ThreadCacheRecord> {
	const session = await createCachedSession(config)
	try {
		const started = await startThread(session, config, {
			workspaceRoot: input.workspaceRoot,
			targetModel: input.targetModel,
			developerInstructions: input.developerInstructions,
		})
		const record: ThreadCacheRecord = {
			session,
			threadId: started.threadId,
			model: started.model,
			reasoningEffort: started.reasoningEffort,
			fingerprint: input.threadFingerprint,
			lastMessageCount: input.lastMessageCount,
			transcriptHash: input.transcriptHash,
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
			updatedAt: Date.now(),
			failureCount: 0,
			busy: true,
			waiters: [],
			idleTimer: null,
			ttlPolicy: input.ttlMs,
			closed: false,
		}
		session.addCloseListener(() => {
			void closeThreadCacheRecord(input.cacheKey, record)
		})
		upsertThreadCache(input.cacheKey, record)
		return record
	} catch (error) {
		session.close('request_failed')
		throw error
	}
}

async function acquireOrCreateThreadCacheRecord(
	config: RouterConfig,
	input: {
		cacheKey: string
		workspaceRoot: string
		targetModel: string
		developerInstructions: string
		threadFingerprint: string
		lastMessageCount: number
		transcriptHash: string
		ttlMs: CacheTtlPolicy
	},
): Promise<{ record: ThreadCacheRecord; reuseReason: CodexThreadReuseReason }> {
	let sawExpired = false
	while (true) {
		const cached = threadCache.get(input.cacheKey) ?? null
		if (cached) {
			const expired = isCacheLifetimeExceeded(
				cached.createdAt,
				cached.lastUsedAt,
				cached.ttlPolicy,
			)
			if (cached.session.isClosed() || expired) {
				sawExpired ||= expired
				await closeThreadCacheRecord(input.cacheKey, cached)
			} else if (cached.busy) {
				await waitForThreadCacheRecord(cached)
			} else {
				clearIdleTimer(cached)
				cached.busy = true
				cached.lastUsedAt = Date.now()
				cached.updatedAt = Date.now()
				upsertThreadCache(input.cacheKey, cached)
				return {
					record: cached,
					reuseReason: sawExpired ? 'cache_expired' : 'cache_hit',
				}
			}
			continue
		}

		const pending = pendingThreadCacheCreates.get(input.cacheKey)
		if (pending) {
			const record = await pending
			if (record.busy) {
				await waitForThreadCacheRecord(record)
				continue
			}
			clearIdleTimer(record)
			record.busy = true
			record.lastUsedAt = Date.now()
			record.updatedAt = Date.now()
			upsertThreadCache(input.cacheKey, record)
			return {
				record,
				reuseReason: 'cache_hit',
			}
		}

		const createPromise = createThreadCacheRecord(config, input)
		pendingThreadCacheCreates.set(input.cacheKey, createPromise)
		try {
			const record = await createPromise
			return {
				record,
				reuseReason: sawExpired ? 'cache_expired' : 'cache_miss',
			}
		} finally {
			if (pendingThreadCacheCreates.get(input.cacheKey) === createPromise) {
				pendingThreadCacheCreates.delete(input.cacheKey)
			}
		}
	}
}

async function createPreparedSession(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	context?: CodexRequestContext,
	options?: {
		forceFreshThread?: boolean
	},
): Promise<PreparedSession> {
	await mkdir(config.codexRuntimeCwd, { recursive: true })
	const workspaceRoot = inferWorkspaceRoot(config, request)
	const requestContext = normalizeRequestContext(context)
	const targetModel = resolveModelAlias(config, request.model)
	const developerInstructions = buildCodexDeveloperInstructions(request)
	const threadInvariantInput = buildThreadInvariantInput(request)
	const threadFingerprint = buildThreadFingerprint(
		targetModel,
		config.codexSandboxMode,
		threadInvariantInput,
	)
	const conversationSeed = buildAnonymousConversationSeed(request)
	const explicitSessionId = requestContext.sessionId
	const ephemeralSessionId =
		explicitSessionId
			? null
			: buildStableBridgeSessionId(requestContext.userAgent, workspaceRoot, conversationSeed) ??
				getOrCreateEphemeralSessionId(requestContext.userAgent, workspaceRoot)
	const effectiveSessionId = explicitSessionId ?? ephemeralSessionId
	const effectiveRequestContext = {
		...requestContext,
		sessionId: effectiveSessionId,
	}
	const threadCacheKey =
		buildThreadCacheKey(effectiveSessionId, workspaceRoot) ??
		buildAnonymousThreadCacheKey(
			requestContext.userAgent,
			workspaceRoot,
			conversationSeed,
		)
	const cacheTtlMs: CacheTtlPolicy = explicitSessionId
		? {
				idleTtlMs: SESSION_CACHE_IDLE_TTL_MS,
				maxLifetimeMs: SESSION_CACHE_MAX_LIFETIME_MS,
			}
		: {
				idleTtlMs: ANONYMOUS_THREAD_TTL_MS,
				maxLifetimeMs: ANONYMOUS_THREAD_MAX_LIFETIME_MS,
			}
	const transcriptHash = hashMessages(request.messages)
	if (!threadCacheKey) {
		throwIfAborted(requestContext.abortSignal)
		const promptText = serializeAnthropicRequestToCodexPrompt(request)
		const promptMetrics = buildCodexPromptMetrics(request, developerInstructions, promptText)
		const session = await createCachedSession(config)
		try {
			const started = await startThread(session, config, {
				workspaceRoot,
				targetModel,
				developerInstructions,
			})
			const metadata: CodexTurnMetadata = {
				threadId: started.threadId,
				workspaceRoot,
				sessionId: effectiveSessionId,
				threadMode: 'new',
				threadReuseReason: 'no_session',
				threadCacheKey: null,
				threadFingerprint,
			}
			logBridgeThreadEvent('thread_started', {
				requestContext: effectiveRequestContext,
				metadata,
				model: started.model,
			})
			return {
				session,
				threadId: started.threadId,
				model: started.model,
				reasoningEffort: started.reasoningEffort,
				promptText,
				promptMetrics,
				workspaceRoot,
				metadata,
				requestContext: effectiveRequestContext,
				cacheRecord: null,
				cacheKey: null,
				cleanup: onceAsync(async () => {
					session.close('closed')
				}),
			}
		} catch (error) {
			session.close('request_failed')
			throw error
		}
	}

	const { record, reuseReason } = await acquireOrCreateThreadCacheRecord(config, {
		cacheKey: threadCacheKey,
		workspaceRoot,
		targetModel,
		developerInstructions,
		threadFingerprint,
		lastMessageCount: request.messages.length,
		transcriptHash,
		ttlMs: cacheTtlMs,
	})

	const canReplayDelta =
		record.lastMessageCount > 0 &&
		request.messages.length >= record.lastMessageCount &&
		hashMessages(request.messages.slice(0, record.lastMessageCount)) === record.transcriptHash
	const shouldReuseThread =
		!options?.forceFreshThread && record.fingerprint === threadFingerprint
	const replayFromMessageIndex = shouldReuseThread && canReplayDelta ? record.lastMessageCount : 0
	const promptMode = replayFromMessageIndex > 0 ? 'delta' : 'full'
	const promptText = serializeAnthropicRequestToCodexPrompt(request, {
		mode: promptMode,
		replayFromMessageIndex,
	})
	const promptMetrics = buildCodexPromptMetrics(request, developerInstructions, promptText, {
		promptMode,
		replayFromMessageIndex,
	})

	if (shouldReuseThread) {
		const metadata: CodexTurnMetadata = {
			threadId: record.threadId,
			workspaceRoot,
			sessionId: effectiveSessionId,
			threadMode: reuseReason === 'cache_hit' ? 'reused' : 'new',
			threadReuseReason: reuseReason,
			threadCacheKey,
			threadFingerprint,
		}
		logBridgeThreadEvent(
			metadata.threadMode === 'reused' ? 'thread_reused' : 'thread_started',
			{
				requestContext: effectiveRequestContext,
				metadata,
				model: record.model,
			},
		)
		return {
			session: record.session,
			threadId: record.threadId,
			model: record.model,
			reasoningEffort: record.reasoningEffort,
			promptText,
			promptMetrics,
			workspaceRoot,
			metadata,
			requestContext: effectiveRequestContext,
			cacheRecord: record,
			cacheKey: threadCacheKey,
			cleanup: onceAsync(async () => {
				await releaseThreadCacheRecord(threadCacheKey, record)
			}),
		}
	}

	const replacedThreadId = record.threadId
	try {
		throwIfAborted(requestContext.abortSignal)
		const started = await startThread(record.session, config, {
			workspaceRoot,
			targetModel,
			developerInstructions,
		})
		record.threadId = started.threadId
		record.model = started.model
		record.reasoningEffort = started.reasoningEffort
		record.fingerprint = threadFingerprint
		record.lastMessageCount = request.messages.length
		record.transcriptHash = transcriptHash
		record.lastUsedAt = Date.now()
		record.updatedAt = Date.now()
		record.failureCount = 0
		upsertThreadCache(threadCacheKey, record)

		const metadata: CodexTurnMetadata = {
			threadId: started.threadId,
			workspaceRoot,
			sessionId: effectiveSessionId,
			threadMode: options?.forceFreshThread ? 'recreated' : 'new',
			threadReuseReason: options?.forceFreshThread ? 'retry_after_error' : 'fingerprint_mismatch',
			threadCacheKey,
			threadFingerprint,
		}
		logBridgeThreadEvent(
			metadata.threadMode === 'recreated' ? 'thread_recreated' : 'thread_started',
			{
				requestContext: effectiveRequestContext,
				metadata,
				model: started.model,
				extra: {
					replaced_thread_id: replacedThreadId,
				},
			},
		)
		return {
			session: record.session,
			threadId: started.threadId,
			model: started.model,
			reasoningEffort: started.reasoningEffort,
			promptText,
			promptMetrics: buildCodexPromptMetrics(request, developerInstructions, promptText, {
				promptMode,
				replayFromMessageIndex,
			}),
			workspaceRoot,
			metadata,
			requestContext: effectiveRequestContext,
			cacheRecord: record,
			cacheKey: threadCacheKey,
			cleanup: onceAsync(async () => {
				await releaseThreadCacheRecord(threadCacheKey, record)
			}),
		}
	} catch (error) {
		await closeThreadCacheRecord(threadCacheKey, record)
		throw error
	}
}

function normalizeEffort(value: string | null): string {
	switch (value) {
		case 'none':
		case 'low':
		case 'medium':
		case 'high':
		case 'xhigh':
			return value
		default:
			return 'low'
	}
}

class FreshThreadRetryRequiredError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'FreshThreadRetryRequiredError'
	}
}

function shouldRetryWithFreshThread(prepared: PreparedSession): boolean {
	return prepared.metadata.threadMode === 'reused'
}

function createRetryError(prepared: PreparedSession, error: unknown): FreshThreadRetryRequiredError {
	const message = error instanceof Error ? error.message : String(error)
	if (prepared.cacheRecord) {
		prepared.cacheRecord.failureCount += 1
	}
	logBridgeThreadEvent('thread_reuse_failed', {
		requestContext: prepared.requestContext,
		metadata: prepared.metadata,
		model: prepared.model,
		extra: {
			error: JSON.stringify(message),
		},
	})
	return new FreshThreadRetryRequiredError(message)
}

async function abortPreparedTurn(prepared: PreparedSession | null) {
	if (!prepared) {
		return
	}

	try {
		await prepared.session.request(
			'turn/cancel',
			{
				threadId: prepared.threadId,
			},
			1000,
			'turn_complete',
		)
	} catch {}

	if (prepared.cacheKey && prepared.cacheRecord) {
		await closeThreadCacheRecord(prepared.cacheKey, prepared.cacheRecord)
		return
	}

	prepared.session.close('client_abort')
}

function buildTurnStartParams(
	threadId: string,
	reasoningEffort: string | null,
	config: RouterConfig,
	promptText: string,
): Record<string, unknown> {
	return {
		threadId,
		input: [
			{
				type: 'text',
				text: promptText,
			},
		],
		approvalPolicy: 'never',
		sandboxPolicy: buildTurnSandboxPolicy(config.codexSandboxMode),
		effort: normalizeEffort(reasoningEffort),
		outputSchema: null as JsonValue | null,
	}
}

function createResult(
	model: string,
	text: string,
	usage: CodexTokenUsage,
	decision: CodexBridgeDecision | null,
	metadata: CodexTurnMetadata,
	promptMetrics: CodexPromptMetrics,
): CodexTurnResult {
	return {
		id: `msg_${crypto.randomUUID()}`,
		model,
		text,
		usage,
		promptMetrics,
		decision,
		metadata: {
			...metadata,
			model,
		},
	}
}

async function executePreparedTurn(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	prepared: PreparedSession,
): Promise<CodexTurnResult> {
	let finalText = ''
	const usage = { ...ZERO_USAGE }
	const structuredToolLoop = Boolean(request.tools?.length)
	const abortSignal = prepared.requestContext.abortSignal
	throwIfAborted(abortSignal)

	try {
		const completed = createDeferred<CodexTurnResult>()
		const firstToken = createDeferred<void>()
		const unsubscribe = prepared.session.addListener((notification) => {
			const method = notification.method
			const params = notification.params

			if (method === 'item/agentMessage/delta') {
				finalText += getString(params?.delta) ?? ''
				firstToken.resolve()
				return
			}

			if (method === 'item/completed') {
				const item = getObject(params?.item)
				if (item?.type === 'agentMessage') {
					finalText = getItemText(item) ?? finalText
					firstToken.resolve()
				}
				return
			}

			if (method === 'thread/tokenUsage/updated') {
				Object.assign(usage, getTurnUsage(params) ?? {})
				return
			}

			if (method === 'turn/completed') {
				unsubscribe()
				const decision = parseCodexBridgeDecision(finalText, request)
				updateThreadCacheProgress(prepared.cacheKey, prepared.cacheRecord, request.messages)
				completed.resolve(
					createResult(
						prepared.model,
						finalText,
						usage,
						structuredToolLoop ? decision : null,
						prepared.metadata,
						prepared.promptMetrics,
					),
				)
			}
		})

		try {
			await prepared.session.request(
				'turn/start',
				buildTurnStartParams(
					prepared.threadId,
					prepared.reasoningEffort,
					config,
					prepared.promptText,
				),
				config.codexTurnRequestTimeoutMs,
				'turn_start',
			)
		} catch (error) {
			unsubscribe()
			if (shouldRetryWithFreshThread(prepared)) {
				throw createRetryError(prepared, error)
			}
			throw error
		}

		await Promise.race([
			firstToken.promise,
			new Promise<void>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new CodexTimeoutError('first_token', TURN_FIRST_TOKEN_TIMEOUT_MS, 'turn/first-token'),
						),
					TURN_FIRST_TOKEN_TIMEOUT_MS,
				),
			),
			completed.promise.then(() => undefined),
			createAbortPromise(abortSignal),
		])

		return await Promise.race([
			completed.promise,
			new Promise<CodexTurnResult>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new CodexTimeoutError('turn_complete', config.codexTurnTimeoutMs, 'turn/complete'),
						),
					config.codexTurnTimeoutMs,
				),
			),
			createAbortPromise(abortSignal),
		])
	} finally {
		if (abortSignal?.aborted) {
			await abortPreparedTurn(prepared)
		}
		await prepared.cleanup()
	}
}

export async function executeCodexTurn(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	context?: CodexRequestContext,
): Promise<CodexTurnResult> {
	let forceFreshThread = false
	let lastError: unknown = null

	for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
		try {
			const prepared = await createPreparedSession(config, request, context, {
				forceFreshThread,
			})
			return await executePreparedTurn(config, request, prepared)
		} catch (error) {
			lastError = error
			const classification = classifyCodexError(error)
			if (classification === 'retryable') {
				runtimeCounters.retryableFailures += 1
			} else {
				runtimeCounters.nonRetryableFailures += 1
			}
			if (error instanceof FreshThreadRetryRequiredError) {
				forceFreshThread = true
			}

			if (attempt === MAX_RETRY_ATTEMPTS - 1 || classification !== 'retryable') {
				throw error
			}

			runtimeCounters.retries += 1
			await sleep(computeRetryDelay(attempt))
		}
	}

	throw lastError instanceof Error ? lastError : new Error('Codex turn 실행에 실패했습니다.')
}

export function createCodexAnthropicStream(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	context?: CodexRequestContext,
	logger?: StreamLifecycleLogger,
): ReadableStream<Uint8Array> {
	let prepared: PreparedSession | null = null
	let unsubscribe: (() => void) | null = null
	let streamClosed = false
	let keepAliveTimer: Timer | null = null

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let usage = { ...ZERO_USAGE }
			let textStarted = false
			let streamedText = ''
			let finalText = ''
			const structuredToolLoop = Boolean(request.tools?.length)
			const abortSignal = context?.abortSignal ?? null

			const safeEnqueue = (payload: Uint8Array): boolean => {
				if (streamClosed) {
					return false
				}

				try {
					controller.enqueue(payload)
					return true
				} catch {
					streamClosed = true
					return false
				}
			}

			const safeClose = () => {
				if (streamClosed) {
					return
				}

				streamClosed = true
				try {
					controller.close()
				} catch {}
			}

			try {
				safeEnqueue(formatSseComment('stream-open'))
				keepAliveTimer = setInterval(() => {
					safeEnqueue(formatSseComment('keepalive'))
				}, 5000)

				for (const forceFreshThread of [false, true]) {
					usage = { ...ZERO_USAGE }
					textStarted = false
					streamedText = ''
					finalText = ''

					try {
						prepared = await createPreparedSession(
							config,
							request,
							context,
							forceFreshThread ? { forceFreshThread: true } : undefined,
						)
						await logger?.onSessionReady?.({
							...prepared.metadata,
							model: prepared.model,
						})

						const completed = createDeferred<void>()
						unsubscribe = prepared.session.addListener((notification) => {
							const method = notification.method
							const params = notification.params

							if (method === 'item/agentMessage/delta') {
								const delta = getString(params?.delta) ?? ''
								if (!delta) {
									return
								}

								if (structuredToolLoop) {
									streamedText += delta
									finalText = streamedText
									return
								}

								if (!textStarted) {
									textStarted = true
									if (
										!safeEnqueue(
											formatSse('content_block_start', {
												type: 'content_block_start',
												index: 0,
												content_block: {
													type: 'text',
													text: '',
												},
											}),
										)
									) {
										return
									}
								}

								streamedText += delta
								finalText = streamedText
								safeEnqueue(
									formatSse('content_block_delta', {
										type: 'content_block_delta',
										index: 0,
										delta: {
											type: 'text_delta',
											text: delta,
										},
									}),
								)
								return
							}

							if (method === 'item/completed') {
								const item = getObject(params?.item)
								if (item?.type === 'agentMessage') {
									finalText = getItemText(item) ?? finalText
								}
								return
							}

							if (method === 'thread/tokenUsage/updated') {
								usage = getTurnUsage(params) ?? usage
								return
							}

							if (method === 'turn/completed') {
								const activePrepared = prepared
								if (!activePrepared) {
									unsubscribe?.()
									completed.resolve()
									return
								}
								const decision = structuredToolLoop
									? parseCodexBridgeDecision(finalText, request)
									: null
								updateThreadCacheProgress(
									activePrepared.cacheKey,
									activePrepared.cacheRecord,
									request.messages,
								)

								if (structuredToolLoop) {
									if (decision?.kind === 'tool_use') {
										let blockIndex = 0
										if (decision.preamble?.trim()) {
											safeEnqueue(
												formatSse('content_block_start', {
													type: 'content_block_start',
													index: blockIndex,
													content_block: {
														type: 'text',
														text: '',
													},
												}),
											)
											safeEnqueue(
												formatSse('content_block_delta', {
													type: 'content_block_delta',
													index: blockIndex,
													delta: {
														type: 'text_delta',
														text: decision.preamble,
													},
												}),
											)
											safeEnqueue(
												formatSse('content_block_stop', {
													type: 'content_block_stop',
													index: blockIndex,
												}),
											)
											blockIndex += 1
										}

										const toolUseId = `toolu_${crypto.randomUUID()}`
										safeEnqueue(
											formatSse('content_block_start', {
												type: 'content_block_start',
												index: blockIndex,
												content_block: {
													type: 'tool_use',
													id: toolUseId,
													name: decision.name,
													input: {},
												},
											}),
										)
										safeEnqueue(
											formatSse('content_block_delta', {
												type: 'content_block_delta',
												index: blockIndex,
												delta: {
													type: 'input_json_delta',
													partial_json: JSON.stringify(decision.input),
												},
											}),
										)
										safeEnqueue(
											formatSse('content_block_stop', {
												type: 'content_block_stop',
												index: blockIndex,
											}),
										)
										safeEnqueue(
											formatSse('message_delta', {
												type: 'message_delta',
												delta: {
													stop_reason: 'tool_use',
													stop_sequence: null,
												},
												usage: {
													output_tokens: usage.outputTokens,
												},
											}),
										)
										safeEnqueue(
											formatSse('message_stop', {
												type: 'message_stop',
											}),
										)
										void logger?.onComplete?.({
											stopReason: 'tool_use',
											usage,
											promptMetrics: activePrepared.promptMetrics,
											finalText,
											decision,
											metadata: {
												...activePrepared.metadata,
												model: activePrepared.model,
											},
										})
										unsubscribe?.()
										completed.resolve()
										return
									}

									if (decision?.kind === 'assistant') {
										finalText = decision.text
									}
								}

								if (!textStarted && finalText) {
									textStarted = true
									if (
										!safeEnqueue(
											formatSse('content_block_start', {
												type: 'content_block_start',
												index: 0,
												content_block: {
													type: 'text',
													text: '',
												},
											}),
										)
									) {
										unsubscribe?.()
										completed.resolve()
										return
									}
									safeEnqueue(
										formatSse('content_block_delta', {
											type: 'content_block_delta',
											index: 0,
											delta: {
												type: 'text_delta',
												text: finalText,
											},
										}),
									)
								}

								if (textStarted) {
									safeEnqueue(
										formatSse('content_block_stop', {
											type: 'content_block_stop',
											index: 0,
										}),
									)
								}

								safeEnqueue(
									formatSse('message_delta', {
										type: 'message_delta',
										delta: {
											stop_reason: 'end_turn',
											stop_sequence: null,
										},
										usage: {
											output_tokens: usage.outputTokens,
										},
									}),
								)
								safeEnqueue(
									formatSse('message_stop', {
										type: 'message_stop',
									}),
								)
								void logger?.onComplete?.({
									stopReason: 'end_turn',
									usage,
									promptMetrics: activePrepared.promptMetrics,
									finalText,
									decision,
									metadata: {
										...activePrepared.metadata,
										model: activePrepared.model,
									},
								})
								unsubscribe?.()
								completed.resolve()
							}
						})

						try {
							await prepared.session.request(
								'turn/start',
								buildTurnStartParams(
									prepared.threadId,
									prepared.reasoningEffort,
									config,
									prepared.promptText,
								),
								config.codexTurnRequestTimeoutMs,
								'turn_start',
							)
						} catch (error) {
							unsubscribe?.()
							unsubscribe = null
							if (!forceFreshThread && shouldRetryWithFreshThread(prepared)) {
								throw createRetryError(prepared, error)
							}
							throw error
						}

						if (
							!safeEnqueue(
								formatSse('message_start', {
									type: 'message_start',
									message: {
										id: `msg_${crypto.randomUUID()}`,
										type: 'message',
										role: 'assistant',
										model: prepared.model,
										content: [],
										stop_reason: null,
										stop_sequence: null,
										usage: {
											input_tokens: 0,
											output_tokens: 0,
										},
									},
								}),
							)
						) {
							return
						}

						await Promise.race([
							completed.promise,
							new Promise<void>((_, reject) =>
								setTimeout(
									() =>
										reject(
											new CodexTimeoutError(
												'turn_complete',
												config.codexTurnTimeoutMs,
												'stream/complete',
											),
										),
									config.codexTurnTimeoutMs,
								),
							),
							createAbortPromise(abortSignal),
						])
						safeClose()
						return
					} catch (error) {
						if (!forceFreshThread && error instanceof FreshThreadRetryRequiredError) {
							await prepared?.cleanup()
							prepared = null
							continue
						}
						throw error
					}
				}
			} catch (error) {
				void logger?.onError?.({
					error,
					metadata: prepared
						? {
								...prepared.metadata,
								model: prepared.model,
							}
						: undefined,
				})
				safeEnqueue(
					formatSse('error', {
						type: 'error',
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					}),
				)
				safeClose()
			} finally {
				if (keepAliveTimer) {
					clearInterval(keepAliveTimer)
				}
				unsubscribe?.()
				if (abortSignal?.aborted || streamClosed) {
					await abortPreparedTurn(prepared)
				}
				await prepared?.cleanup()
			}
		},
		cancel() {
			streamClosed = true
			if (keepAliveTimer) {
				clearInterval(keepAliveTimer)
			}
			void logger?.onCancel?.({
				metadata: prepared
					? {
							...prepared.metadata,
							model: prepared.model,
						}
					: undefined,
			})
			unsubscribe?.()
			void abortPreparedTurn(prepared)
			void prepared?.cleanup()
		},
	})
}
