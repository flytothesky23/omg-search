import { App, PluginSettingTab, Setting, Notice, TFolder } from 'obsidian';
import MokAgyPlugin from './main';

export interface FileSyncData {
	uri: string;
	hash: string;
	lastSynced: number;
	status: 'synced' | 'pending' | 'error';
}

export interface MokAgySettings {
	// Legacy Gemini settings are retained for existing data.json compatibility.
	// This fork ignores API keys and uses the Antigravity CLI OAuth session only.
	apiKey: string;
	syncFolders: string[];
	syncFolder?: string; // Legacy setting migrated on load.
	workspaceFolder: string;
	agentOutputFolder: string;
	agentCliPath: string;
	agentModel: string;
	agentPermissionMode: 'review' | 'auto' | 'yolo';
	agentTimeoutSeconds: number;
	agentEnvironment: string;
	agentWebSearchEnabled: boolean;
	agentUseObsidianSkill: boolean;
	agentObsidianSkillPath: string;
	corpusName: string;
	autoSync: boolean;
	files: Record<string, FileSyncData>;
	// Apply to Note settings
	includeMetadata: boolean;
}

export const DEFAULT_SETTINGS: MokAgySettings = {
	apiKey: '',
	syncFolders: [],
	workspaceFolder: '_omg',
	agentOutputFolder: '_omg/agent',
	agentCliPath: 'agy',
	agentModel: '',
	agentPermissionMode: 'review',
	agentTimeoutSeconds: 60,
	agentEnvironment: '',
	agentWebSearchEnabled: false,
	agentUseObsidianSkill: true,
	agentObsidianSkillPath: '_omg/skills/obsidian-writing-skill.md',
	corpusName: '',
	autoSync: false,
	files: {},
	// Apply to Note settings
	includeMetadata: true
};

export class MokAgySettingTab extends PluginSettingTab {
	plugin: MokAgyPlugin;

	constructor(app: App, plugin: MokAgyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h1', { text: 'Master of Knowledge AGY Settings' });

		// Local context folder section
		containerEl.createEl('h2', { text: 'Agent Context' });

		const folders = this.getAllFolders();

		new Setting(containerEl)
			.setName('Context Folders')
			.setDesc('Select folders the Agent should use as local vault context. Files stay local and are not synced to Google APIs.');

		this.renderSyncFolderPicker(containerEl, folders);

		containerEl.createEl('h2', { text: 'Workspace' });

		new Setting(containerEl)
			.setName('Workspace Folder')
			.setDesc('Generated agent reports, compiled notes, graphs, and logs are saved under this vault folder.')
			.addText(text => text
				.setPlaceholder('_omg')
				.setValue(this.plugin.settings.workspaceFolder)
				.onChange(async (value) => {
					this.plugin.settings.workspaceFolder = this.plugin.normalizeFolder(value.trim() || '_omg', '_omg');
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Agent Output Folder')
			.setDesc('Agent-generated notes are saved here when you use Create New Note or Save from the Agent tab.')
			.addText(text => text
				.setPlaceholder('_omg/agent')
				.setValue(this.plugin.settings.agentOutputFolder)
				.onChange(async (value) => {
					this.plugin.settings.agentOutputFolder = this.plugin.normalizeFolder(value.trim() || '_omg/agent', '_omg/agent');
					await this.plugin.saveSettings();
				})
			)
			.addButton(button => button
				.setButtonText('Create')
				.onClick(async () => {
					await this.plugin.ensureVaultFolder(this.plugin.settings.agentOutputFolder);
					new Notice(`Agent output folder is ready: ${this.plugin.settings.agentOutputFolder}`);
				})
			);

		containerEl.createEl('h2', { text: 'Agent Workspace' });

		new Setting(containerEl)
			.setName('Antigravity CLI Path')
			.setDesc('Path or command used by the Agent tab. Use a full path if Obsidian cannot find agy from your shell PATH.')
			.addText(text => text
				.setPlaceholder(process.platform === 'win32' ? 'agy.exe' : '/Users/you/.local/bin/agy')
				.setValue(this.plugin.settings.agentCliPath)
				.onChange(async (value) => {
					this.plugin.settings.agentCliPath = value.trim() || 'agy';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Find Antigravity CLI')
			.setDesc('Auto-detect agy from PATH and common macOS/Windows install locations.')
			.addButton(button => button
				.setButtonText('Auto-detect')
				.onClick(async () => {
					const found = this.plugin.agentService.detectAgentCliPath();
					if (!found) {
						new Notice('Could not find agy. Install Antigravity CLI or set the full path manually.');
						return;
					}
					this.plugin.settings.agentCliPath = found;
					await this.plugin.saveSettings();
					new Notice(`Antigravity CLI found: ${found}`);
					this.display();
				})
			);

		new Setting(containerEl)
			.setName('AGY Model')
			.setDesc('Model passed to agy with --model. Leave Auto to use the AGY default.')
			.addDropdown(dropdown => {
				dropdown.addOption('', 'Auto / AGY default');
				dropdown.addOption('Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (Medium)');
				dropdown.addOption('Gemini 3.5 Flash (High)', 'Gemini 3.5 Flash (High)');
				dropdown.addOption('Gemini 3.5 Flash (Low)', 'Gemini 3.5 Flash (Low)');
				dropdown.addOption('Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (High)');
				dropdown.addOption('Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (Low)');
				dropdown.addOption('Claude Sonnet 4.6 (Thinking)', 'Claude Sonnet 4.6 (Thinking)');
				dropdown.addOption('Claude Opus 4.6 (Thinking)', 'Claude Opus 4.6 (Thinking)');
				dropdown.addOption('GPT-OSS 120B (Medium)', 'GPT-OSS 120B (Medium)');
				dropdown.setValue(this.plugin.settings.agentModel || '');
				dropdown.onChange(async (value) => {
					this.plugin.settings.agentModel = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Agent Permission Mode')
			.setDesc('Review is preview-first. Auto and Yolo are reserved for trusted vault workflows.')
			.addDropdown(dropdown => {
				dropdown.addOption('review', 'Safe / Review');
				dropdown.addOption('auto', 'Auto');
				dropdown.addOption('yolo', 'Yolo');
				dropdown.setValue(this.plugin.settings.agentPermissionMode);
				dropdown.onChange(async (value: 'review' | 'auto' | 'yolo') => {
					this.plugin.settings.agentPermissionMode = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Agent Timeout (seconds)')
			.setDesc('Maximum time to wait for a single agent run.')
			.addText(text => text
				.setPlaceholder('180')
				.setValue(String(this.plugin.settings.agentTimeoutSeconds))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num >= 30) {
						this.plugin.settings.agentTimeoutSeconds = num;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName('Use Obsidian Writing Skill')
			.setDesc('Inject a vault-local Obsidian writing skill into Agent prompts by default.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.agentUseObsidianSkill)
				.onChange(async (value) => {
					this.plugin.settings.agentUseObsidianSkill = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Obsidian Skill File')
			.setDesc('Vault-relative skill file used for Markdown note writing instructions.')
			.addText(text => text
				.setPlaceholder('_omg/skills/obsidian-writing-skill.md')
				.setValue(this.plugin.settings.agentObsidianSkillPath)
				.onChange(async (value) => {
					this.plugin.settings.agentObsidianSkillPath = this.plugin.normalizeFolder(value.trim() || '_omg/skills/obsidian-writing-skill.md', '_omg/skills/obsidian-writing-skill.md');
					await this.plugin.saveSettings();
				})
			)
			.addButton(button => button
				.setButtonText('Install skill')
				.onClick(async () => {
					const path = await this.plugin.installObsidianWritingSkill();
					new Notice(`Obsidian writing skill installed: ${path}`);
					this.display();
				})
			);

		// Dashboard Section
		containerEl.createEl('h2', { text: 'Context Dashboard' });

		const dashboardEl = containerEl.createDiv({ cls: 'gemini-sync-dashboard' });
		this.renderDashboard(dashboardEl);

		// Sync Actions
		containerEl.createEl('h2', { text: 'Actions' });

		new Setting(containerEl)
			.setName('Clear Legacy Gemini Sync Data')
			.setDesc('Remove old local Gemini sync mappings from this plugin data file. This does not call external APIs.')
			.addButton(button => button
				.setButtonText('Clear')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.files = {};
					this.plugin.settings.corpusName = '';
					await this.plugin.saveSettings();
					new Notice('Legacy sync data cleared');
					this.display();
				})
			);

		// Apply to Note Section
		containerEl.createEl('h2', { text: 'Apply to Note' });

		new Setting(containerEl)
			.setName('Include Metadata')
			.setDesc('Add date and source information when inserting AI responses into notes.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeMetadata)
				.onChange(async (value) => {
					this.plugin.settings.includeMetadata = value;
					await this.plugin.saveSettings();
				})
			);

		// Help Section
		containerEl.createEl('h2', { text: 'Help' });

		const helpEl = containerEl.createDiv({ cls: 'gemini-sync-help' });
		helpEl.createEl('p', {
			text: 'Master of Knowledge AGY uses your local Antigravity CLI OAuth session for Agent workflows. Google API key setup is disabled in this fork.'
		});
		helpEl.createEl('p', {
			text: 'Install or configure the AGY CLI so Obsidian can find it, then choose context folders and run tasks from the Agent tab.'
		});
	}

	getAllFolders(): string[] {
		const folders: string[] = [];
		const rootFolder = this.app.vault.getRoot();

		const collectFolders = (folder: TFolder, path: string = '') => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					const fullPath = path ? `${path}/${child.name}` : child.name;
					folders.push(fullPath);
					collectFolders(child, fullPath);
				}
			}
		};

		collectFolders(rootFolder);
		folders.sort();
		return folders;
	}

	private renderSyncFolderPicker(containerEl: HTMLElement, folders: string[]) {
		const pickerEl = containerEl.createDiv({ cls: 'mok-folder-picker' });
		const selectedFolders = this.plugin.settings.syncFolders;
		const selectedSet = new Set(selectedFolders);
		const availableFolders = folders.filter(folder => !selectedSet.has(folder));

		const controlsEl = pickerEl.createDiv({ cls: 'mok-folder-picker-controls' });
		const selectEl = controlsEl.createEl('select', { cls: 'dropdown mok-folder-select' });
		selectEl.createEl('option', {
			text: availableFolders.length > 0 ? 'Choose a folder to add...' : 'No more folders available',
			value: ''
		});

		for (const folder of availableFolders) {
			selectEl.createEl('option', { text: folder, value: folder });
		}

		const addButton = controlsEl.createEl('button', {
			cls: 'mod-cta mok-folder-add-button',
			text: 'Add'
		});
		addButton.disabled = availableFolders.length === 0;
		addButton.addEventListener('click', async () => {
			const folder = selectEl.value;
			if (!folder) {
				new Notice('Choose a folder first.');
				return;
			}
			await this.updateSyncFolders([...selectedFolders, folder]);
		});

		if (selectedFolders.length > 0) {
			const clearButton = controlsEl.createEl('button', {
				cls: 'mok-folder-clear-button',
				text: 'Clear'
			});
			clearButton.addEventListener('click', async () => {
				await this.updateSyncFolders([]);
			});
		}

		const summaryEl = pickerEl.createDiv({
			cls: 'mok-folder-picker-summary',
			text: selectedFolders.length === 0
				? 'No folders selected.'
				: `${selectedFolders.length} folder${selectedFolders.length === 1 ? '' : 's'} selected.`
		});

		const chipsEl = pickerEl.createDiv({ cls: 'mok-folder-chip-list' });
		for (const folder of selectedFolders) {
			const chipEl = chipsEl.createDiv({ cls: 'mok-folder-chip' });
			chipEl.createSpan({ cls: 'mok-folder-chip-label', text: folder });
			const removeButton = chipEl.createEl('button', {
				cls: 'mok-folder-chip-remove',
				text: 'x',
				attr: { 'aria-label': `Remove ${folder}` }
			});
			removeButton.addEventListener('click', async () => {
				await this.updateSyncFolders(selectedFolders.filter(item => item !== folder));
			});
		}

		if (folders.length === 0) {
			summaryEl.setText('No folders found in this vault.');
		}
	}

	private async updateSyncFolders(folders: string[]) {
		this.plugin.settings.syncFolders = Array.from(new Set(
			folders.map(folder => folder.trim()).filter(Boolean)
		)).sort();
		await this.plugin.saveSettings();
		this.display();
	}

	renderDashboard(container: HTMLElement) {
		const files = this.plugin.getKnowledgeMarkdownFiles();
		const fileCount = files.length;

		const statsEl = container.createDiv({ cls: 'sync-stats' });

		statsEl.createEl('div', {
			cls: 'sync-stat',
			text: `📁 Context Files: ${fileCount}`
		});

		if (this.plugin.settings.syncFolders.length > 0) {
			const folders = this.plugin.settings.syncFolders;
			const folderText = folders.length > 5
				? `${folders.slice(0, 5).join(', ')} +${folders.length - 5} more`
				: folders.join(', ');
			container.createEl('div', {
				cls: 'sync-folder-info',
				text: `Context folders: ${folderText}`
			});
		} else {
			container.createEl('div', {
				cls: 'sync-folder-info',
				text: 'No context folders selected.'
			});
		}

		container.createEl('div', {
			cls: 'sync-corpus-info',
			text: 'Google Gemini API sync is disabled. Context stays local and is passed to the Antigravity CLI prompt.'
		});
	}
}
