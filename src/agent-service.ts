import { Notice, TFile } from 'obsidian';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, isAbsolute, join } from 'path';
import { StringDecoder } from 'string_decoder';
import MokAgyPlugin from './main';

export interface AgentRunResult {
	content: string;
	command: string;
	exitCode: number | null;
	durationMs: number;
	logPath?: string;
	agyLogPath?: string;
	contextStats?: AgentContextStats;
}

interface AgentLogRef {
	vaultPath: string;
	agyVaultPath: string;
	agyAbsolutePath: string;
}

export interface AgentContextStats {
	totalContextNotes: number;
	loadedExcerptNotes: number;
	contextChars: number;
	truncatedByBudget: boolean;
	loadedPaths: string[];
}

export class AgentService {
	private activeChild: ChildProcessWithoutNullStreams | null = null;
	private stopWasRequested = false;
	private lastContextStats: AgentContextStats | null = null;

	constructor(private plugin: MokAgyPlugin) {}

	stop() {
		if (!this.activeChild) return false;
		this.stopWasRequested = true;
		this.activeChild.kill();
		this.activeChild = null;
		return true;
	}

	async run(prompt: string, onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void): Promise<AgentRunResult> {
		const started = Date.now();
		const command = this.plugin.settings.agentCliPath.trim() || 'agy';
		const agentPrompt = await this.buildPrompt(prompt);
		const timeoutSeconds = Math.max(30, this.plugin.settings.agentTimeoutSeconds || 60);
		const resolvedCommand = this.resolveCommand(command);
		const logRef = await this.createAgentLog(prompt, resolvedCommand || command, timeoutSeconds);
		const args = this.buildArgs(agentPrompt, timeoutSeconds, logRef.agyAbsolutePath);
		await this.appendAgentLog(logRef.vaultPath, {
			event: 'command',
			command: resolvedCommand || command,
			args: this.redactArgsForLog(args),
			vaultPath: this.plugin.getVaultPath()
		});

		try {
			if (!resolvedCommand) {
				throw Object.assign(new Error(this.getMissingCommandMessage(command)), {
					code: 'ENOENT'
				});
			}
			const { stdout, stderr } = await this.exec(resolvedCommand, args, logRef.vaultPath, onChunk);
			const output = [stdout.trim(), stderr.trim() ? `\n\n---\n에이전트 stderr:\n${stderr.trim()}` : '']
				.join('')
				.trim();
			await this.appendAgentLog(logRef.vaultPath, {
				event: 'complete',
				exitCode: 0,
				durationMs: Date.now() - started
			});
			return {
				content: output || '에이전트가 텍스트 출력 없이 완료되었습니다.',
				command: `${resolvedCommand} --print`,
				exitCode: 0,
				durationMs: Date.now() - started,
				logPath: logRef.vaultPath,
				agyLogPath: logRef.agyVaultPath,
				contextStats: this.lastContextStats || undefined
			};
		} catch (error: any) {
			if (error?.code === 'EAGENTSTOPPED') {
				await this.appendAgentLog(logRef.vaultPath, {
					event: 'stopped',
					durationMs: Date.now() - started
				});
				return {
					content: '사용자가 에이전트 실행을 중지했습니다.',
					command: `${resolvedCommand || command} --print`,
					exitCode: null,
					durationMs: Date.now() - started,
					logPath: logRef.vaultPath,
					agyLogPath: logRef.agyVaultPath,
					contextStats: this.lastContextStats || undefined
				};
			}
			const stdout = String(error?.stdout || '').trim();
			const stderr = String(error?.stderr || '').trim();
			const message = stderr || stdout || error?.message || '알 수 없는 에이전트 오류';
			await this.appendAgentLog(logRef.vaultPath, {
				event: 'failed',
				errorCode: error?.code ?? null,
				message,
				durationMs: Date.now() - started
			});
			new Notice('에이전트 실행에 실패했습니다. 결과 카드를 확인하세요.');
			return {
				content: `에이전트 실행에 실패했습니다.\n\n${message}`,
				command: `${resolvedCommand || command} --print`,
				exitCode: typeof error?.code === 'number' ? error.code : null,
				durationMs: Date.now() - started,
				logPath: logRef.vaultPath,
				agyLogPath: logRef.agyVaultPath,
				contextStats: this.lastContextStats || undefined
			};
		}
	}

	private buildArgs(agentPrompt: string, timeoutSeconds: number, agyLogPath: string): string[] {
		const args = [
			'--add-dir',
			this.plugin.getVaultPath(),
			'--log-file',
			agyLogPath,
			'--print-timeout',
			`${timeoutSeconds}s`
		];

		if (this.plugin.settings.agentModel) {
			args.push('--model', this.plugin.settings.agentModel);
		}

		if (this.plugin.settings.agentPermissionMode === 'auto' ||
			this.plugin.settings.agentPermissionMode === 'yolo') {
			args.push('--dangerously-skip-permissions');
		}

		args.push('--print', agentPrompt);
		return args;
	}

	private async buildPrompt(prompt: string): Promise<string> {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		const workspaceFolder = this.plugin.settings.workspaceFolder;
		const agentOutputFolder = await this.plugin.ensureVaultFolder(this.plugin.settings.agentOutputFolder);
		const trustMode = this.plugin.settings.agentPermissionMode;
		const scope = this.plugin.settings.syncFolders.join(', ') || '선택된 문맥 폴더 없음';
		const webSearch = this.plugin.settings.agentWebSearchEnabled;
		const obsidianSkill = await this.getObsidianSkillContext();
		const contextNotes = await this.buildLocalNotesContext(prompt);
		this.lastContextStats = contextNotes.stats;
		let activeNoteContent = '';
		if (activeFile) {
			try {
				const content = await this.plugin.app.vault.read(activeFile);
				activeNoteContent = content.length > 6000
					? `${content.slice(0, 6000)}\n...[현재 노트 발췌 생략]`
					: content;
			} catch {
				activeNoteContent = '';
			}
		}

		return [
			'당신은 지식 마스터 AGY Obsidian 플러그인 안에서 실행되는 에이전트입니다.',
			'사용자가 읽는 모든 응답, 설명, 제목, 목록, 노트 본문은 한국어로 작성하세요.',
			'명령어, 파일명, 모델명, API명, vault 경로, 코드 식별자 같은 고유명사는 원문을 유지할 수 있지만, 일반 설명 문장에는 영어를 섞지 마세요.',
			'한글이 깨지지 않도록 UTF-8 기준의 정상 한국어 문장으로 출력하세요. 깨진 문자나 검은 물음표 모양 대체 문자가 보이면 같은 뜻의 자연스러운 한국어로 다시 작성하세요.',
			`Vault 작업공간 경로: ${this.plugin.getVaultPath()}.`,
			`신뢰 모드: ${trustMode}.`,
			`웹 검색 모드: ${webSearch ? '켜짐' : '꺼짐'}.`,
			`생성 산출물 작업공간 폴더: ${workspaceFolder}.`,
			`에이전트 생성 노트 폴더: ${agentOutputFolder}.`,
			'생성 파일은 반드시 현재 Obsidian vault 안에 두세요. 에이전트 결과 폴더는 외부 파일 시스템 경로가 아니라 vault 상대 경로로 취급합니다.',
			'노트 파일을 만들면 에이전트 결과 폴더 안에 저장하고, 응답에는 vault 상대 Markdown 링크를 포함하세요. 채팅에 초안만 작성했다면 파일을 저장했다고 말하지 마세요.',
			obsidianSkill,
			`선택된 지식 폴더: ${scope}.`,
			activeFile ? `현재 열린 노트 경로: ${activeFile.path}.` : '현재 열린 노트가 없습니다.',
			activeNoteContent ? `현재 노트 내용 발췌:\n${activeNoteContent}` : '',
			`선택된 폴더에서 사용 가능한 로컬 문맥 노트 수: ${contextNotes.stats.totalContextNotes}.`,
			`이번 프롬프트에 직접 포함된 발췌 노트 수: ${contextNotes.stats.loadedExcerptNotes}.`,
			'아래 발췌는 관련도 기준 작업 세트이며 전체 지식 베이스가 아닙니다. 전체 지식 베이스를 발췌 개수만으로 설명하지 마세요.',
			'먼저 포함된 발췌를 사용하고, 더 많은 노트 확인이 필요하면 vault 작업공간 경로와 선택된 지식 폴더를 활용하세요.',
			'이번 요청에 포함된 로컬 노트 발췌입니다. 근거로 사용하면 노트 경로를 표시하세요:',
			contextNotes.context,
			webSearch
				? '최신 외부 정보가 답변 품질을 높일 때 웹 검색을 사용하고, 웹 출처와 vault 출처를 명확히 구분한 Markdown으로 답하세요.'
				: '사용자가 명시적으로 요청하지 않는 한 웹 검색을 사용하지 말고, vault 근거를 우선하세요.',
			'가능하면 로컬 노트 문맥을 우선해 답하세요. 로컬 노트로 뒷받침되지 않으면 그 사실을 분명히 말하세요.',
			'사용자가 명시적으로 요청하지 않는 한 사용자 노트를 직접 수정하지 말고, 먼저 검토 가능한 결과를 제시하세요.',
			'',
			'사용자 요청:',
			prompt
		].join('\n');
	}

	private async getObsidianSkillContext(): Promise<string> {
		if (!this.plugin.settings.agentUseObsidianSkill) return '';
		const path = this.plugin.normalizeFolder(
			this.plugin.settings.agentObsidianSkillPath || '_omg/skills/obsidian-writing-skill.md',
			'_omg/skills/obsidian-writing-skill.md'
		);
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return [
				'Obsidian 작성 스킬이 켜져 있지만 스킬 파일은 아직 설치되지 않았습니다.',
				'기본 동작: 올바른 Obsidian Markdown을 작성하고, 생성 노트는 에이전트 결과 폴더에 저장하며, vault 상대 노트 링크를 반환하고, 실제 파일이 없으면 저장했다고 말하지 않습니다.'
			].join('\n');
		}
		try {
			const content = await this.plugin.app.vault.read(file);
			return [
				'Obsidian 작성 스킬을 불러왔습니다. 노트 작성 작업에서는 기본적으로 이 지시를 따르세요:',
				`--- ${path} ---`,
				content.length > 5000 ? `${content.slice(0, 5000)}\n...[스킬 발췌 생략]` : content
			].join('\n');
		} catch {
			return '';
		}
	}

	private async buildLocalNotesContext(prompt: string): Promise<{ context: string; stats: AgentContextStats }> {
		const contexts: string[] = [];
		let totalLength = 0;
		const maxTotalLength = 24000;
		const candidates = await this.getRankedContextFiles(prompt);
		let truncatedByBudget = false;

		for (const file of candidates) {
			try {
				const content = await this.plugin.app.vault.read(file);
				const truncated = content.length > 1800
					? `${content.slice(0, 1800)}...[발췌 생략]`
					: content;
				const block = `--- ${file.path} ---\n${truncated}\n`;
				if (totalLength + block.length > maxTotalLength) {
					truncatedByBudget = true;
					break;
				}
				contexts.push(block);
				totalLength += block.length;
			} catch (error) {
				console.warn(`에이전트 문맥용 로컬 노트를 읽지 못했습니다: ${file.path}`, error);
			}
		}

		const stats = {
			totalContextNotes: candidates.length,
			loadedExcerptNotes: contexts.length,
			contextChars: totalLength,
			truncatedByBudget,
			loadedPaths: contexts
				.map(block => block.match(/^--- (.+?) ---/)?.[1])
				.filter((path): path is string => !!path)
		};

		return {
			context: contexts.join('\n') || '선택된 문맥 폴더에서 사용할 수 있는 로컬 문맥 노트가 없습니다.',
			stats
		};
	}

	private async getRankedContextFiles(prompt: string): Promise<TFile[]> {
		const files = this.plugin.getKnowledgeMarkdownFiles();
		const tokens = this.tokenize(prompt);
		if (tokens.length === 0) return files;

		const scored: { file: TFile; score: number }[] = [];
		for (const file of files) {
			try {
				const content = await this.plugin.app.vault.read(file);
				const haystack = `${file.basename}\n${file.path}\n${content.slice(0, 4000)}`.toLowerCase();
				let score = 0;
				for (const token of tokens) {
					if (file.basename.toLowerCase().includes(token)) score += 10;
					if (file.path.toLowerCase().includes(token)) score += 6;
					score += Math.min(haystack.split(token).length - 1, 8);
				}
				scored.push({ file, score });
			} catch {
				scored.push({ file, score: 0 });
			}
		}

		return scored
			.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
			.map(item => item.file);
	}

	private tokenize(text: string): string[] {
		const stopTokens = new Set([
			'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your',
			'are', 'was', 'were', 'have', 'has', 'not', 'can', 'will',
			'대한', '관련', '작성', '내용', '노트', '활용', '사용자', '초안',
			'있습니다', '합니다', '위한', '에게', '에서', '으로', '그리고'
		]);
		const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
		const tokens = new Set<string>();
		for (const raw of normalized.split(/\s+/)) {
			const token = raw.trim();
			if (token.length < 2) continue;
			if (/^\d+$/.test(token)) continue;
			if (stopTokens.has(token)) continue;
			tokens.add(token);
			if (tokens.size >= 32) break;
		}
		return Array.from(tokens);
	}

	private exec(
		command: string,
		args: string[],
		logPath: string,
		onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void
	): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const maxBuffer = 1024 * 1024 * 8;
			const timeoutMs = Math.max(30_000, this.plugin.settings.agentTimeoutSeconds * 1000);
			const stdoutDecoder = new StringDecoder('utf8');
			const stderrDecoder = new StringDecoder('utf8');
			const child = spawn(command, args, {
				cwd: this.plugin.getVaultPath(),
				env: {
					...process.env,
					LANG: process.env.LANG || 'ko_KR.UTF-8',
					LC_ALL: process.env.LC_ALL || process.env.LANG || 'ko_KR.UTF-8',
					...this.parseEnv(this.plugin.settings.agentEnvironment)
				},
				shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
				windowsHide: true
			});
			this.activeChild = child;
			child.stdin.end();
			void this.appendAgentLog(logPath, {
				event: 'spawn',
				pid: child.pid ?? null,
				stdinClosed: true
			});

			const recordChunk = (chunk: string, stream: 'stdout' | 'stderr') => {
				if (!chunk) return;
				if (stream === 'stdout') stdout += chunk;
				else stderr += chunk;
				onChunk?.(chunk, stream);
				void this.appendAgentLog(logPath, { event: stream, chunk });
				if (stdout.length + stderr.length > maxBuffer) {
					void this.appendAgentLog(logPath, { event: 'max_buffer', maxBuffer });
					child.kill();
				}
			};

			const flushDecoders = () => {
				recordChunk(stdoutDecoder.end(), 'stdout');
				recordChunk(stderrDecoder.end(), 'stderr');
			};

			const timer = window.setTimeout(() => {
				settled = true;
				child.kill();
				flushDecoders();
				if (this.activeChild === child) this.activeChild = null;
				void this.appendAgentLog(logPath, {
					event: 'timeout',
					timeoutMs,
					stdoutLength: stdout.length,
					stderrLength: stderr.length
				});
				reject(Object.assign(new Error(`에이전트가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`), {
					code: 'ETIMEDOUT',
					stdout,
					stderr
				}));
			}, timeoutMs);

			child.stdout?.on('data', (data: Buffer) => {
				recordChunk(stdoutDecoder.write(data), 'stdout');
			});

			child.stderr?.on('data', (data: Buffer) => {
				recordChunk(stderrDecoder.write(data), 'stderr');
			});

			child.on('error', (error) => {
				if (settled) return;
				settled = true;
				flushDecoders();
				if (this.activeChild === child) this.activeChild = null;
				window.clearTimeout(timer);
				void this.appendAgentLog(logPath, {
					event: 'error',
					message: error.message,
					stdoutLength: stdout.length,
					stderrLength: stderr.length
				});
				if (this.stopWasRequested) {
					this.stopWasRequested = false;
					reject(Object.assign(new Error('사용자가 에이전트 실행을 중지했습니다.'), {
						code: 'EAGENTSTOPPED',
						stdout,
						stderr
					}));
					return;
				}
				reject(Object.assign(error, { stdout, stderr }));
			});

			child.on('close', (code) => {
				if (settled) return;
				settled = true;
				flushDecoders();
				if (this.activeChild === child) this.activeChild = null;
				window.clearTimeout(timer);
				void this.appendAgentLog(logPath, {
					event: 'close',
					exitCode: code,
					stdoutLength: stdout.length,
					stderrLength: stderr.length
				});
				if (this.stopWasRequested) {
					this.stopWasRequested = false;
					reject(Object.assign(new Error('사용자가 에이전트 실행을 중지했습니다.'), {
						code: 'EAGENTSTOPPED',
						stdout,
						stderr
					}));
					return;
				}
				if (code === 0) {
					resolve({ stdout, stderr });
					return;
				}
				reject(Object.assign(new Error(`에이전트가 종료 코드 ${code ?? '알 수 없음'}로 종료되었습니다.`), {
					code,
					stdout,
					stderr
				}));
			});
		});
	}

	private async createAgentLog(prompt: string, command: string, timeoutSeconds: number): Promise<AgentLogRef> {
		const folder = await this.plugin.ensureWorkspaceFolder('logs');
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const vaultPath = `${folder}/agent-${stamp}.jsonl`;
		const agyVaultPath = `${folder}/agent-${stamp}.agy.log`;
		const agyAbsolutePath = join(this.plugin.getVaultPath(), agyVaultPath);
		const initial = {
			event: 'start',
			timestamp: new Date().toISOString(),
			command,
			timeoutSeconds,
			permissionMode: this.plugin.settings.agentPermissionMode,
			webSearchEnabled: this.plugin.settings.agentWebSearchEnabled,
			syncFolders: this.plugin.settings.syncFolders,
			contextStats: this.lastContextStats,
			promptPreview: prompt.length > 500 ? `${prompt.slice(0, 500)}...[발췌 생략]` : prompt,
			agyLogPath: agyVaultPath
		};

		await this.plugin.app.vault.create(vaultPath, `${JSON.stringify(initial)}\n`);
		return { vaultPath, agyVaultPath, agyAbsolutePath };
	}

	private async appendAgentLog(path: string, event: Record<string, unknown>) {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			await this.plugin.app.vault.append(file, `${JSON.stringify({
				timestamp: new Date().toISOString(),
				...event
			})}\n`);
		} catch (error) {
			console.warn('에이전트 로그를 추가하지 못했습니다:', error);
		}
	}

	private redactArgsForLog(args: string[]): string[] {
		const redacted = [...args];
		const printIndex = redacted.findIndex(arg => arg === '--print' || arg === '-p' || arg === '--prompt');
		if (printIndex >= 0 && printIndex + 1 < redacted.length) {
			redacted[printIndex + 1] = `[prompt omitted: ${redacted[printIndex + 1].length} chars]`;
		}
		return redacted;
	}

	private parseEnv(raw: string): Record<string, string> {
		const env: Record<string, string> = {};
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const idx = trimmed.indexOf('=');
			if (idx <= 0) continue;
			env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
		}
		return env;
	}

	detectAgentCliPath(): string | null {
		return this.resolveCommand('agy');
	}

	private resolveCommand(command: string): string | null {
		if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
			return existsSync(command) ? command : null;
		}

		const paths = Array.from(new Set([
			...(process.env.PATH || '').split(delimiter),
			join(homedir(), '.local', 'bin'),
			join(homedir(), '.antigravity', 'antigravity', 'bin'),
			join(homedir(), '.antigravity-ide', 'antigravity-ide', 'bin'),
			join(homedir(), '.antigravity', 'bin'),
			join(homedir(), '.antigravity-ide', 'bin'),
			...(process.platform === 'win32' ? this.getWindowsAgentSearchPaths() : []),
			'/opt/homebrew/bin',
			'/usr/local/bin',
			'/usr/bin',
			'/bin'
		].filter(Boolean)));
		const extensions = process.platform === 'win32'
			? Array.from(new Set(['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')]))
				.map(ext => ext.toLowerCase())
			: [''];

		for (const dir of paths) {
			for (const ext of extensions) {
				const candidate = join(dir, `${command}${ext}`);
				if (existsSync(candidate)) return candidate;
			}
		}
		return null;
	}

	private getWindowsAgentSearchPaths(): string[] {
		const env = process.env;
		const roots = [
			env.LOCALAPPDATA,
			env.APPDATA,
			env.USERPROFILE,
			env.ProgramFiles,
			env['ProgramFiles(x86)']
		].filter((value): value is string => !!value);

		const suffixes = [
			['Programs', 'Antigravity', 'bin'],
			['Programs', 'Antigravity'],
			['Antigravity', 'bin'],
			['Antigravity'],
			['Google', 'Antigravity', 'bin'],
			['Google', 'Antigravity'],
			['.local', 'bin'],
			['AppData', 'Roaming', 'npm']
		];

		const paths: string[] = [];
		for (const root of roots) {
			for (const suffix of suffixes) {
				paths.push(join(root, ...suffix));
			}
		}
		return paths;
	}

	private getMissingCommandMessage(command: string): string {
		return [
			`에이전트 CLI 명령 "${command}"을 찾지 못했습니다.`,
			'Obsidian을 Finder, Dock, 시작 메뉴에서 열었다면 셸 PATH를 상속하지 못할 수 있습니다.',
			'설정 > 지식 마스터 AGY > 에이전트 실행에서 자동 찾기를 누르거나 Antigravity CLI 경로에 전체 경로를 입력하세요.',
			process.platform === 'win32'
				? 'Windows에서는 보통 PATH의 agy.exe, %LOCALAPPDATA%\\Programs\\Antigravity, 또는 %APPDATA%\\npm 위치에 있습니다.'
				: `macOS에서는 보통 다음 위치 중 하나입니다: ${homedir()}/.local/bin/agy 또는 /opt/homebrew/bin/agy`
		].join('\n');
	}
}
