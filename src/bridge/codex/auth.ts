import { readFile } from 'node:fs/promises'

export interface CodexAuthTokens {
	access_token: string
	refresh_token?: string
	id_token?: string
	account_id?: string
}

export interface CodexAuthFile {
	OPENAI_API_KEY?: string | null
	tokens: CodexAuthTokens
	last_refresh?: string
}

export class AuthConfigurationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AuthConfigurationError'
	}
}

export async function readCodexAuthFile(filePath: string): Promise<CodexAuthFile | null> {
	try {
		const raw = await readFile(filePath, 'utf8')
		const parsed = JSON.parse(raw) as Partial<CodexAuthFile>
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			!parsed.tokens ||
			typeof parsed.tokens !== 'object' ||
			typeof parsed.tokens.access_token !== 'string'
		) {
			return null
		}

		return {
			OPENAI_API_KEY:
				typeof parsed.OPENAI_API_KEY === 'string' || parsed.OPENAI_API_KEY === null
					? parsed.OPENAI_API_KEY
					: null,
			last_refresh: typeof parsed.last_refresh === 'string' ? parsed.last_refresh : undefined,
			tokens: {
				access_token: parsed.tokens.access_token,
				refresh_token:
					typeof parsed.tokens.refresh_token === 'string'
						? parsed.tokens.refresh_token
						: undefined,
				id_token:
					typeof parsed.tokens.id_token === 'string' ? parsed.tokens.id_token : undefined,
				account_id:
					typeof parsed.tokens.account_id === 'string'
						? parsed.tokens.account_id
						: undefined,
			},
		}
	} catch {
		return null
	}
}

export async function requireCodexLocalAuthFile(filePath: string): Promise<CodexAuthFile> {
	const authFile = await readCodexAuthFile(filePath)
	if (!authFile?.tokens.access_token) {
		throw new AuthConfigurationError(
			`Codex local auth 파일을 읽을 수 없습니다: ${filePath}`,
		)
	}

	return authFile
}
