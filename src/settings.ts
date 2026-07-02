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

			containerEl.createEl('h1', { text: '지식 마스터 AGY 설정' });

			containerEl.createEl('h2', { text: '에이전트 문맥' });

		const folders = this.getAllFolders();

			new Setting(containerEl)
				.setName('문맥 폴더')
				.setDesc('에이전트가 로컬 vault 문맥으로 사용할 폴더를 선택합니다. 파일은 로컬에만 남고 Google API로 동기화되지 않습니다.');

		this.renderSyncFolderPicker(containerEl, folders);

			containerEl.createEl('h2', { text: '작업공간' });

			new Setting(containerEl)
				.setName('작업공간 폴더')
				.setDesc('에이전트 보고서, 정리 노트, 관계도, 로그가 이 vault 폴더 아래에 저장됩니다.')
			.addText(text => text
				.setPlaceholder('_omg')
				.setValue(this.plugin.settings.workspaceFolder)
				.onChange(async (value) => {
					this.plugin.settings.workspaceFolder = this.plugin.normalizeFolder(value.trim() || '_omg', '_omg');
					await this.plugin.saveSettings();
				})
			);

			new Setting(containerEl)
				.setName('에이전트 결과 폴더')
				.setDesc('에이전트 탭에서 새 노트 만들기 또는 저장을 사용할 때 생성 노트가 여기에 저장됩니다.')
			.addText(text => text
				.setPlaceholder('_omg/agent')
				.setValue(this.plugin.settings.agentOutputFolder)
				.onChange(async (value) => {
					this.plugin.settings.agentOutputFolder = this.plugin.normalizeFolder(value.trim() || '_omg/agent', '_omg/agent');
					await this.plugin.saveSettings();
				})
				)
				.addButton(button => button
					.setButtonText('만들기')
					.onClick(async () => {
						await this.plugin.ensureVaultFolder(this.plugin.settings.agentOutputFolder);
						new Notice(`에이전트 결과 폴더가 준비되었습니다: ${this.plugin.settings.agentOutputFolder}`);
					})
				);

			containerEl.createEl('h2', { text: '에이전트 실행' });

			new Setting(containerEl)
				.setName('Antigravity CLI 경로')
				.setDesc('에이전트 탭에서 사용할 명령 또는 전체 경로입니다. Obsidian이 PATH에서 agy를 찾지 못하면 전체 경로를 입력하세요.')
			.addText(text => text
				.setPlaceholder(process.platform === 'win32' ? 'agy.exe' : '/Users/you/.local/bin/agy')
				.setValue(this.plugin.settings.agentCliPath)
				.onChange(async (value) => {
					this.plugin.settings.agentCliPath = value.trim() || 'agy';
					await this.plugin.saveSettings();
				})
			);

			new Setting(containerEl)
				.setName('Antigravity CLI 찾기')
				.setDesc('PATH와 macOS/Windows의 일반 설치 위치에서 agy를 자동으로 찾습니다.')
				.addButton(button => button
					.setButtonText('자동 찾기')
					.onClick(async () => {
						const found = this.plugin.agentService.detectAgentCliPath();
						if (!found) {
							new Notice('agy를 찾지 못했습니다. Antigravity CLI를 설치하거나 전체 경로를 직접 입력하세요.');
							return;
						}
						this.plugin.settings.agentCliPath = found;
						await this.plugin.saveSettings();
						new Notice(`Antigravity CLI를 찾았습니다: ${found}`);
						this.display();
					})
				);

			new Setting(containerEl)
				.setName('AGY 모델')
				.setDesc('agy 실행 시 --model로 전달할 모델입니다. AGY 기본값을 쓰려면 자동으로 둡니다.')
				.addDropdown(dropdown => {
					dropdown.addOption('', '자동 / AGY 기본값');
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
				.setName('에이전트 권한 모드')
				.setDesc('검토 우선은 미리보기 중심입니다. 자동 실행과 제한 없음은 신뢰할 수 있는 vault 작업에만 사용하세요.')
				.addDropdown(dropdown => {
					dropdown.addOption('review', '안전 / 검토 우선');
					dropdown.addOption('auto', '자동 실행');
					dropdown.addOption('yolo', '제한 없음');
				dropdown.setValue(this.plugin.settings.agentPermissionMode);
				dropdown.onChange(async (value: 'review' | 'auto' | 'yolo') => {
					this.plugin.settings.agentPermissionMode = value;
					await this.plugin.saveSettings();
				});
			});

			new Setting(containerEl)
				.setName('에이전트 제한 시간(초)')
				.setDesc('한 번의 에이전트 실행을 기다릴 최대 시간입니다.')
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
				.setName('Obsidian 작성 스킬 사용')
				.setDesc('vault 안의 Obsidian 작성 스킬을 에이전트 프롬프트에 기본으로 포함합니다.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.agentUseObsidianSkill)
				.onChange(async (value) => {
					this.plugin.settings.agentUseObsidianSkill = value;
					await this.plugin.saveSettings();
				})
			);

			new Setting(containerEl)
				.setName('Obsidian 스킬 파일')
				.setDesc('Markdown 노트 작성 지시문으로 사용할 vault 상대 경로의 스킬 파일입니다.')
			.addText(text => text
				.setPlaceholder('_omg/skills/obsidian-writing-skill.md')
				.setValue(this.plugin.settings.agentObsidianSkillPath)
				.onChange(async (value) => {
					this.plugin.settings.agentObsidianSkillPath = this.plugin.normalizeFolder(value.trim() || '_omg/skills/obsidian-writing-skill.md', '_omg/skills/obsidian-writing-skill.md');
					await this.plugin.saveSettings();
				})
				)
				.addButton(button => button
					.setButtonText('스킬 설치')
					.onClick(async () => {
						const path = await this.plugin.installObsidianWritingSkill();
						new Notice(`Obsidian 작성 스킬을 설치했습니다: ${path}`);
						this.display();
					})
				);

			containerEl.createEl('h2', { text: '문맥 대시보드' });

		const dashboardEl = containerEl.createDiv({ cls: 'gemini-sync-dashboard' });
		this.renderDashboard(dashboardEl);

			containerEl.createEl('h2', { text: '작업' });

			new Setting(containerEl)
				.setName('기존 Gemini 동기화 데이터 지우기')
				.setDesc('이 플러그인 데이터 파일에 남아 있는 예전 Gemini 동기화 매핑을 지웁니다. 외부 API는 호출하지 않습니다.')
				.addButton(button => button
					.setButtonText('지우기')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.files = {};
						this.plugin.settings.corpusName = '';
						await this.plugin.saveSettings();
						new Notice('기존 동기화 데이터를 지웠습니다.');
						this.display();
					})
				);

			containerEl.createEl('h2', { text: '노트에 반영' });

			new Setting(containerEl)
				.setName('메타데이터 포함')
				.setDesc('AI 응답을 노트에 넣을 때 날짜와 출처 정보를 함께 추가합니다.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeMetadata)
				.onChange(async (value) => {
					this.plugin.settings.includeMetadata = value;
					await this.plugin.saveSettings();
				})
			);

			containerEl.createEl('h2', { text: '도움말' });

			const helpEl = containerEl.createDiv({ cls: 'gemini-sync-help' });
			helpEl.createEl('p', {
				text: '지식 마스터 AGY는 로컬 Antigravity CLI OAuth 세션으로 에이전트 작업을 실행합니다. 이 fork에서는 Google API 키 설정을 사용하지 않습니다.'
			});
			helpEl.createEl('p', {
				text: 'Obsidian이 AGY CLI를 찾을 수 있도록 설치하거나 경로를 설정한 뒤, 문맥 폴더를 선택하고 에이전트 탭에서 작업을 실행하세요.'
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
				text: availableFolders.length > 0 ? '추가할 폴더 선택...' : '추가할 폴더가 없습니다',
				value: ''
			});

		for (const folder of availableFolders) {
			selectEl.createEl('option', { text: folder, value: folder });
		}

			const addButton = controlsEl.createEl('button', {
				cls: 'mod-cta mok-folder-add-button',
				text: '추가'
			});
		addButton.disabled = availableFolders.length === 0;
		addButton.addEventListener('click', async () => {
				const folder = selectEl.value;
				if (!folder) {
					new Notice('먼저 폴더를 선택하세요.');
					return;
				}
			await this.updateSyncFolders([...selectedFolders, folder]);
		});

		if (selectedFolders.length > 0) {
				const clearButton = controlsEl.createEl('button', {
					cls: 'mok-folder-clear-button',
					text: '전체 해제'
				});
			clearButton.addEventListener('click', async () => {
				await this.updateSyncFolders([]);
			});
		}

			const summaryEl = pickerEl.createDiv({
				cls: 'mok-folder-picker-summary',
				text: selectedFolders.length === 0
					? '선택된 폴더가 없습니다.'
					: `폴더 ${selectedFolders.length}개 선택됨.`
			});

		const chipsEl = pickerEl.createDiv({ cls: 'mok-folder-chip-list' });
		for (const folder of selectedFolders) {
			const chipEl = chipsEl.createDiv({ cls: 'mok-folder-chip' });
			chipEl.createSpan({ cls: 'mok-folder-chip-label', text: folder });
				const removeButton = chipEl.createEl('button', {
					cls: 'mok-folder-chip-remove',
					text: 'x',
					attr: { 'aria-label': `${folder} 제거` }
				});
			removeButton.addEventListener('click', async () => {
				await this.updateSyncFolders(selectedFolders.filter(item => item !== folder));
			});
		}

			if (folders.length === 0) {
				summaryEl.setText('이 vault에서 폴더를 찾지 못했습니다.');
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
				text: `📁 문맥 파일: ${fileCount}개`
			});

		if (this.plugin.settings.syncFolders.length > 0) {
			const folders = this.plugin.settings.syncFolders;
				const folderText = folders.length > 5
					? `${folders.slice(0, 5).join(', ')} 외 ${folders.length - 5}개`
					: folders.join(', ');
				container.createEl('div', {
					cls: 'sync-folder-info',
					text: `문맥 폴더: ${folderText}`
				});
			} else {
				container.createEl('div', {
					cls: 'sync-folder-info',
					text: '선택된 문맥 폴더가 없습니다.'
				});
			}

			container.createEl('div', {
				cls: 'sync-corpus-info',
				text: 'Google Gemini API 동기화는 비활성화되어 있습니다. 문맥은 로컬에 남고 Antigravity CLI 프롬프트에만 전달됩니다.'
			});
	}
}
