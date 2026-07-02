import { Plugin, WorkspaceLeaf, TFile } from 'obsidian';
import { MokAgySettings, DEFAULT_SETTINGS, MokAgySettingTab } from './settings';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';
import { AgentService } from './agent-service';

export default class MokAgyPlugin extends Plugin {
	settings: MokAgySettings;
	agentService: AgentService;
	statusBarItem: HTMLElement;

	async onload() {
		console.log('Loading Master of Knowledge AGY Plugin');

		// Load settings
		await this.loadSettings();

		// Initialize services
		this.agentService = new AgentService(this);
		this.ensureDefaultWorkspaceFolders().catch(error => {
			console.warn('Master of Knowledge AGY could not prepare default workspace folders:', error);
		});

		// Register chat view
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new ChatView(leaf, this)
		);

		// Add ribbon icon for chat
		this.addRibbonIcon('brain', 'Open Master of Knowledge AGY', () => {
			this.activateChatView();
		});

		// Add settings tab
		this.addSettingTab(new MokAgySettingTab(this.app, this));

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('Ready');

		// Add command to open chat
		this.addCommand({
			id: 'open-master-of-knowledge-agy',
			name: 'Open Master of Knowledge AGY',
			callback: () => {
				this.activateChatView();
			}
		});

		// Gemini API sync is disabled in this fork. The selected folders are
		// used only as local context for Antigravity CLI Agent runs.
	}

	onunload() {
		console.log('Unloading Master of Knowledge AGY Plugin');
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
			'# Obsidian Writing Skill',
			'',
			'Use this skill whenever the user asks the Agent to write, compile, summarize, or create an Obsidian note.',
			'',
			'## Output Contract',
			'- Write valid Markdown that opens cleanly in Obsidian.',
			'- Prefer clear headings, short paragraphs, tables only when they improve scanning, and actionable checklists.',
			'- Use wiki links like [[Note Title]] only when the target note exists or when creating a deliberate new note.',
			'- Keep generated notes inside the configured Agent output folder.',
			'- When a note file is created, return its vault-relative path and a markdown link to that path.',
			'- Do not claim a file was saved unless the file was actually written.',
			'',
			'## Source Discipline',
			'- Cite vault note paths when using local context note evidence.',
			'- Separate note-grounded claims from general suggestions.',
			'- If evidence is weak or missing, say so plainly.',
			'',
			'## Korean Notes',
			'- If the user writes Korean, answer in natural Korean.',
			'- Avoid stiff translation tone; write as a practical Obsidian note the user can keep.'
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
