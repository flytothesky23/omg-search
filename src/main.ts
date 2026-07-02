import { Plugin, WorkspaceLeaf, TFile } from 'obsidian';
import { MokAgySettings, DEFAULT_SETTINGS, MokAgySettingTab } from './settings';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';
import { AgentService } from './agent-service';

export default class MokAgyPlugin extends Plugin {
	settings: MokAgySettings;
	agentService: AgentService;
	statusBarItem: HTMLElement;

	async onload() {
		console.log('지식 마스터 AGY 플러그인을 불러옵니다.');

		// Load settings
		await this.loadSettings();

		// Initialize services
		this.agentService = new AgentService(this);
		this.ensureDefaultWorkspaceFolders().catch(error => {
			console.warn('지식 마스터 AGY 기본 작업공간 폴더를 준비하지 못했습니다:', error);
		});

		// Register chat view
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new ChatView(leaf, this)
		);

		// Add ribbon icon for chat
		this.addRibbonIcon('brain', '지식 마스터 AGY 열기', () => {
			this.activateChatView();
		});

		// Add settings tab
		this.addSettingTab(new MokAgySettingTab(this.app, this));

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('준비됨');

		// Add command to open chat
		this.addCommand({
			id: 'open-master-of-knowledge-agy',
			name: '지식 마스터 AGY 열기',
			callback: () => {
				this.activateChatView();
			}
		});

		// Gemini API sync is disabled in this fork. The selected folders are
		// used only as local context for Antigravity CLI Agent runs.
	}

	onunload() {
		console.log('지식 마스터 AGY 플러그인을 종료합니다.');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.apiKey = '';
		this.settings.autoSync = false;
		this.settings.corpusName = '';
		const configuredFolders = Array.isArray(this.settings.syncFolders)
			? this.settings.syncFolders
			: [];
		this.settings.syncFolders = Array.from(new Set([
			...(this.settings.syncFolder ? [this.settings.syncFolder] : []),
			...configuredFolders
		].filter(folder => folder.trim().length > 0))).sort();
		delete this.settings.syncFolder;
		this.settings.workspaceFolder = this.normalizeFolder(
			this.settings.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder,
			DEFAULT_SETTINGS.workspaceFolder
		);
		this.settings.agentOutputFolder = this.normalizeFolder(
			this.settings.agentOutputFolder || `${this.settings.workspaceFolder}/agent`,
			`${this.settings.workspaceFolder}/agent`
		);
		this.settings.agentCliPath = this.settings.agentCliPath || DEFAULT_SETTINGS.agentCliPath;
		this.settings.agentModel = this.settings.agentModel || DEFAULT_SETTINGS.agentModel;
		this.settings.agentPermissionMode = this.settings.agentPermissionMode || DEFAULT_SETTINGS.agentPermissionMode;
		this.settings.agentTimeoutSeconds = this.settings.agentTimeoutSeconds || DEFAULT_SETTINGS.agentTimeoutSeconds;
		this.settings.agentEnvironment = this.settings.agentEnvironment || DEFAULT_SETTINGS.agentEnvironment;
		this.settings.agentWebSearchEnabled = typeof this.settings.agentWebSearchEnabled === 'boolean'
			? this.settings.agentWebSearchEnabled
			: DEFAULT_SETTINGS.agentWebSearchEnabled;
		this.settings.agentUseObsidianSkill = typeof this.settings.agentUseObsidianSkill === 'boolean'
			? this.settings.agentUseObsidianSkill
			: DEFAULT_SETTINGS.agentUseObsidianSkill;
		this.settings.agentObsidianSkillPath = this.normalizeFolder(
			this.settings.agentObsidianSkillPath || DEFAULT_SETTINGS.agentObsidianSkillPath,
			DEFAULT_SETTINGS.agentObsidianSkillPath
		);
		this.settings.files = this.settings.files || {};
		await this.saveData(this.settings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Update chat view if it's open
		this.updateChatViewSyncStatus();
	}

	estimateTokens(text: string): number {
		return Math.max(1, Math.ceil(text.length / 4));
	}

	// Update sync status in chat view if it's open
	updateChatViewSyncStatus() {
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (leaves.length > 0) {
			const chatView = leaves[0].view as ChatView;
			if (chatView && typeof chatView.updateSyncStatus === 'function') {
				chatView.updateSyncStatus();
			}
		}
	}

	shouldSync(file: TFile): boolean {
		if (this.settings.syncFolders.length === 0) return false;
		if (file.extension !== 'md') return false;
		return this.isInSyncFolder(file.path);
	}

	getKnowledgeMarkdownFiles(): TFile[] {
		if (this.settings.syncFolders.length === 0) return [];
		return this.app.vault.getMarkdownFiles().filter(file =>
			file.extension === 'md' && this.isInSyncFolder(file.path)
		);
	}

	isInSyncFolder(path: string): boolean {
		return this.settings.syncFolders.some(folder =>
			path === folder || path.startsWith(`${folder}/`)
		);
	}

	updateStatusBar(status: string) {
		this.statusBarItem.setText(`MoK AGY: ${status}`);
	}

	getVaultPath(): string {
		const adapter = this.app.vault.adapter as { basePath?: string };
		return adapter.basePath || '/';
	}

	normalizeFolder(folder: string, fallback = '_omg'): string {
		const fallbackPath = (fallback || '_omg')
			.replace(/\\/g, '/')
			.replace(/^\/+|\/+$/g, '') || '_omg';
		let cleaned = (folder || fallbackPath).trim().replace(/\\/g, '/');

		try {
			if (cleaned.startsWith('file://')) {
				cleaned = decodeURIComponent(new URL(cleaned).pathname).replace(/\\/g, '/');
			}
		} catch {
			cleaned = fallbackPath;
		}

		const vaultRoot = this.getVaultPath().replace(/\\/g, '/').replace(/\/+$/g, '');
		if (vaultRoot && cleaned.startsWith(`${vaultRoot}/`)) {
			cleaned = cleaned.slice(vaultRoot.length + 1);
		} else if (cleaned === vaultRoot || cleaned.startsWith('/') || /^[A-Za-z]:\//.test(cleaned)) {
			cleaned = fallbackPath;
		}

		const parts = cleaned
			.replace(/^\/+|\/+$/g, '')
			.split('/')
			.filter(part => part && part !== '.' && part !== '..');
		return parts.join('/') || fallbackPath;
	}

	async ensureWorkspaceFolder(subfolder?: string): Promise<string> {
		const root = this.normalizeFolder(this.settings.workspaceFolder, DEFAULT_SETTINGS.workspaceFolder);
		const path = subfolder ? `${root}/${subfolder}` : root;
		return this.ensureVaultFolder(path);
	}

	async ensureDefaultWorkspaceFolders() {
		await this.ensureWorkspaceFolder('compiled');
		await this.ensureVaultFolder(this.settings.agentOutputFolder || `${this.settings.workspaceFolder}/agent`);
		await this.ensureWorkspaceFolder('graph');
		await this.ensureWorkspaceFolder('inbox');
		await this.ensureWorkspaceFolder('logs');
		await this.ensureWorkspaceFolder('skills');
	}

	async ensureVaultFolder(folder: string): Promise<string> {
		const path = this.normalizeFolder(folder);
		const parts = path.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) {
				try {
					await this.app.vault.createFolder(current);
				} catch (error: any) {
					if (!(await this.app.vault.adapter.exists(current))) {
						throw error;
					}
				}
			}
		}
		return path;
	}

	async installObsidianWritingSkill(): Promise<string> {
		const skillPath = this.normalizeFolder(
			this.settings.agentObsidianSkillPath || DEFAULT_SETTINGS.agentObsidianSkillPath,
			DEFAULT_SETTINGS.agentObsidianSkillPath
		);
		const folder = skillPath.split('/').slice(0, -1).join('/');
		if (folder) await this.ensureVaultFolder(folder);

			const content = [
				'# Obsidian 작성 스킬',
				'',
				'사용자가 에이전트에게 Obsidian 노트 작성, 정리, 요약, 생성을 요청할 때 이 스킬을 사용합니다.',
				'',
				'## 출력 규칙',
				'- Obsidian에서 바로 열리는 올바른 Markdown을 작성합니다.',
				'- 명확한 제목, 짧은 문단, 필요한 경우에만 표, 실행 가능한 체크리스트를 우선합니다.',
				'- [[노트 제목]] 형태의 위키링크는 대상 노트가 존재하거나 새 노트를 의도적으로 만들 때만 사용합니다.',
				'- 생성 노트는 설정된 에이전트 결과 폴더 안에 보관합니다.',
				'- 노트 파일을 만들었다면 vault 상대 경로와 해당 경로의 Markdown 링크를 함께 반환합니다.',
				'- 실제로 파일을 쓰지 않았다면 저장했다고 말하지 않습니다.',
				'',
				'## 출처 규칙',
				'- 로컬 문맥 노트의 근거를 사용하면 vault 노트 경로를 표시합니다.',
				'- 노트 근거가 있는 주장과 일반 제안을 구분합니다.',
				'- 근거가 약하거나 없으면 분명히 말합니다.',
				'',
				'## 한국어 규칙',
				'- 모든 설명, 제목, 버튼에 들어갈 제안 문구, 노트 본문은 자연스러운 한국어로 작성합니다.',
				'- 명령어, 파일명, 모델명, API 이름 같은 고유명사를 제외하고 영어 문장을 섞지 않습니다.',
				'- 번역투를 피하고 사용자가 그대로 보관할 수 있는 실무형 Obsidian 노트로 작성합니다.'
			].join('\n');

		const existing = this.app.vault.getAbstractFileByPath(skillPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(skillPath, content);
		}

		this.settings.agentObsidianSkillPath = skillPath;
		this.settings.agentUseObsidianSkill = true;
		await this.saveSettings();
		return skillPath;
	}

	openPluginSettings() {
		const setting = (this.app as any).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById?.(this.manifest.id);
	}

	async activateChatView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}
}
