import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile, Modal, FuzzySuggestModal, App } from 'obsidian';
import MokAgyPlugin from './main';
import { ChatMessage, Citation } from './types';

type DashboardTab = 'agent' | 'workspace' | 'graph' | 'settings';

type KnowledgeGraphNode = {
	id: string;
	title: string;
	path: string;
	folder: string;
	mtime: number;
	size: number;
	kind: 'note' | 'tag';
	degree?: number;
	pageRank?: number;
	community?: number;
};

type KnowledgeGraphEdge = {
	id: string;
	from: string;
	to: string;
	type: 'wikilink' | 'tag';
	label?: string;
	confidence: 'EXTRACTED';
	confidenceScore: number;
};

// Modal for selecting a note to apply content
class NoteSelectorModal extends FuzzySuggestModal<TFile> {
	private onSelect: (file: TFile) => void;

	constructor(app: App, onSelect: (file: TFile) => void) {
		super(app);
		this.onSelect = onSelect;
		this.setPlaceholder('내용을 반영할 노트를 선택하세요...');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
		this.onSelect(item);
	}
}

export const CHAT_VIEW_TYPE = 'gemini-chat-view';

export class ChatView extends ItemView {
	private plugin: MokAgyPlugin;
	private messagesContainer: HTMLElement;
	private inputContainer: HTMLElement;
	private inputEl: HTMLTextAreaElement;
	private sendButton: HTMLButtonElement;
	private agentMessages: ChatMessage[] = [];
	private isLoading: boolean = false;
	private loadingTab: DashboardTab | null = null;
	private isComposing: boolean = false;
	private syncStatusEl: HTMLElement | null = null;
	private welcomeEl: HTMLElement | null = null;
	private tabBarEl: HTMLElement;
	private dashboardContentEl: HTMLElement;
	private activeTab: DashboardTab = 'agent';
	private citationPreviewEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MokAgyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return '지식 마스터 AGY';
	}

	getIcon(): string {
		return 'brain';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('gemini-chat-container');

		const header = container.createDiv({ cls: 'gemini-chat-header' });
		header.createEl('h4', { text: '지식 마스터 AGY' });

		const headerActions = header.createDiv({ cls: 'gemini-chat-header-actions' });

		const clearBtn = headerActions.createEl('button', {
			cls: 'gemini-chat-clear-btn',
			text: '🗑️ 지우기'
		});
		clearBtn.addEventListener('click', () => this.clearChat());

		const contextCount = this.plugin.getKnowledgeMarkdownFiles().length;
		this.syncStatusEl = headerActions.createEl('span', {
			cls: 'gemini-chat-sync-status',
			text: `📚 문맥 노트 ${contextCount}개`
		});

		this.tabBarEl = container.createDiv({ cls: 'mok-tabs' });
		this.dashboardContentEl = container.createDiv({ cls: 'mok-content' });
		this.renderTabs();
		this.renderActiveTab();
	}

	async onClose() {
		this.hideCitationPreview();
	}

	// Public method to update sync status - can be called from outside
	updateSyncStatus() {
		const contextCount = this.plugin.getKnowledgeMarkdownFiles().length;

		if (this.syncStatusEl) {
			this.syncStatusEl.textContent = `📚 문맥 노트 ${contextCount}개`;
		}

		if (this.welcomeEl) {
			const existingWarning = this.welcomeEl.querySelector('.gemini-chat-welcome-warning');
			if (existingWarning) {
				existingWarning.remove();
			}

			if (contextCount === 0) {
				const paragraphs = this.welcomeEl.querySelectorAll('p');
				if (paragraphs.length > 0) {
					const warningEl = this.welcomeEl.createEl('p', {
						cls: 'gemini-chat-welcome-warning',
						text: '⚠️ 아직 문맥 노트가 선택되지 않았습니다. 설정에서 문맥 폴더를 선택하면 에이전트 실행 시 노트 발췌가 함께 전달됩니다.'
					});
					paragraphs[0].after(warningEl);
				}
			}
		}
	}

	private renderTabs() {
		this.tabBarEl.empty();
		const tabs: Array<{ id: DashboardTab; label: string }> = [
			{ id: 'agent', label: '에이전트' },
			{ id: 'workspace', label: '작업공간' },
			{ id: 'graph', label: '관계도' },
			{ id: 'settings', label: '설정' }
		];

		for (const tab of tabs) {
			const button = this.tabBarEl.createEl('button', {
				cls: tab.id === this.activeTab ? 'mok-tab mok-tab-active' : 'mok-tab',
				text: tab.label
			});
			button.addEventListener('click', () => {
				this.activeTab = tab.id;
				this.renderTabs();
				this.renderActiveTab();
			});
		}
	}

	private renderActiveTab() {
		this.dashboardContentEl.empty();
		this.welcomeEl = null;

		if (this.activeTab === 'workspace') {
			this.renderWorkspaceTab();
			return;
		}

		if (this.activeTab === 'graph') {
			void this.renderGraphTab();
			return;
		}

		if (this.activeTab === 'settings') {
			this.renderSettingsTab();
			return;
		}

		this.renderConversationToolbar();
		this.messagesContainer = this.dashboardContentEl.createDiv({ cls: 'gemini-chat-messages' });
		const list = this.agentMessages;
		if (list.length === 0) {
			this.showWelcomeMessage();
		} else {
			for (const msg of list) this.renderMessage(msg);
		}

		this.inputContainer = this.dashboardContentEl.createDiv({ cls: 'gemini-chat-input-container' });
		if (this.activeTab === 'agent') {
			this.renderAgentModeBar(this.inputContainer);
		}
			this.inputEl = this.inputContainer.createEl('textarea', {
				cls: 'gemini-chat-input',
				placeholder: this.activeTab === 'agent'
					? '조사, 정리, 관계도 작성, 노트 생성을 요청하세요...'
					: '노트에 대해 질문하세요...'
			});

		this.inputEl.addEventListener('compositionstart', () => {
			this.isComposing = true;
		});

		this.inputEl.addEventListener('compositionend', () => {
			window.setTimeout(() => {
				this.isComposing = false;
			}, 0);
		});

		this.inputEl.addEventListener('keydown', (e) => {
			if (this.isComposing || e.isComposing) return;
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		this.inputEl.addEventListener('input', () => {
			this.inputEl.style.height = 'auto';
			this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + 'px';
		});

		this.sendButton = this.inputContainer.createEl('button', {
			cls: 'gemini-chat-send-btn',
			text: this.isLoading && this.loadingTab === this.activeTab
				? (this.activeTab === 'agent' ? '■' : '⏳')
				: '➤'
			});
			this.sendButton.disabled = this.isLoading && this.activeTab !== 'agent';
			this.sendButton.setAttr('aria-label', this.isLoading && this.activeTab === 'agent' ? '에이전트 중지' : '보내기');
		this.sendButton.addEventListener('click', () => {
			if (this.isLoading && this.activeTab === 'agent') {
				this.stopAgentRun();
				return;
			}
			this.sendMessage();
		});

		if (this.isLoading && this.loadingTab === this.activeTab) {
			const loadingEl = this.messagesContainer.createDiv({ cls: 'gemini-chat-loading' });
			loadingEl.createEl('span', { cls: 'gemini-chat-loading-dots', text: '●●●' });
				loadingEl.createEl('span', {
					cls: 'gemini-chat-loading-label',
					text: this.activeTab === 'agent' ? '에이전트가 아직 실행 중입니다...' : '생각 중입니다...'
				});
			}
	}

	private renderConversationToolbar() {
		const toolbar = this.dashboardContentEl.createDiv({ cls: 'mok-conversation-toolbar' });
			const title = toolbar.createDiv({ cls: 'mok-conversation-title' });
			title.createEl('span', {
				text: '에이전트 대화'
			});
			title.createEl('small', {
				text: '저장된 결과는 유지한 채 새 에이전트 대화를 시작합니다.'
			});

			const newButton = toolbar.createEl('button', {
				cls: 'mok-new-conversation-btn',
				text: '+ 새 에이전트 대화'
			});
			const isRunningHere = this.isLoading && this.loadingTab === this.activeTab;
			newButton.disabled = isRunningHere;
			newButton.setAttr('aria-label', '새 에이전트 대화 시작');
			if (isRunningHere) {
				newButton.setAttr('title', '새 대화를 시작하려면 현재 실행을 먼저 중지하세요.');
			}
		newButton.addEventListener('click', () => this.startNewConversation());
	}

	private renderWorkspaceTab() {
		const panel = this.dashboardContentEl.createDiv({ cls: 'mok-panel' });
		panel.createEl('h3', { text: `${this.plugin.settings.workspaceFolder} 작업공간` });
		panel.createEl('p', { text: '에이전트 보고서, 정리 노트, 관계도 JSON, 캔버스 지도, 로그는 원본 노트와 분리해 보관됩니다.' });
		const folders = [
			`${this.plugin.settings.workspaceFolder}/compiled`,
			this.plugin.settings.agentOutputFolder,
			`${this.plugin.settings.workspaceFolder}/graph`,
			`${this.plugin.settings.workspaceFolder}/inbox`,
			`${this.plugin.settings.workspaceFolder}/logs`
		];
		const list = panel.createEl('ul');
		for (const folder of folders) {
			const exists = this.app.vault.getAbstractFileByPath(folder) ? 'ready' : 'missing';
			list.createEl('li', { text: `${folder} (${exists === 'ready' ? '준비됨' : '없음'})` });
		}
		const createBtn = panel.createEl('button', { cls: 'gemini-chat-action-btn', text: '작업공간 폴더 만들기' });
		createBtn.addEventListener('click', async () => {
			for (const folder of folders) await this.plugin.ensureVaultFolder(folder);
			new Notice('지식 마스터 AGY 작업공간 폴더가 준비되었습니다.');
			this.renderActiveTab();
		});

		const graphBtn = panel.createEl('button', {
			cls: 'gemini-chat-action-btn',
			text: '지식 관계도 만들기'
		});
		graphBtn.addEventListener('click', async () => {
			graphBtn.setText('관계도 생성 중...');
			graphBtn.setAttr('disabled', 'true');
			try {
				const { jsonPath, canvasPath, reportPath, nodeCount, edgeCount, communityCount } = await this.buildKnowledgeGraphArtifacts();
				new Notice(`지식 관계도 생성 완료: 노드 ${nodeCount}개, 연결 ${edgeCount}개, 묶음 ${communityCount}개`);
				await this.app.workspace.openLinkText(canvasPath || jsonPath, '', true);
				void reportPath;
			} catch (error) {
				new Notice('지식 관계도를 만들지 못했습니다.');
				console.error('관계도 생성 오류:', error);
			} finally {
				graphBtn.removeAttribute('disabled');
				graphBtn.setText('지식 관계도 만들기');
				this.renderActiveTab();
			}
		});
	}

	private async buildKnowledgeGraphArtifacts(): Promise<{ jsonPath: string; canvasPath: string; reportPath: string; nodeCount: number; edgeCount: number; communityCount: number }> {
		const graphFolder = await this.plugin.ensureWorkspaceFolder('graph');
		const files = this.app.vault.getMarkdownFiles()
			.filter(file => this.isSyncedCitationFile(file));
		const nodes: KnowledgeGraphNode[] = files.map(file => ({
			id: file.path,
			title: file.basename,
			path: file.path,
			folder: file.parent?.path || '',
			mtime: file.stat.mtime,
			size: file.stat.size,
			kind: 'note'
		}));
		const nodeIds = new Set(nodes.map(node => node.id));
		const edgeMap = new Map<string, KnowledgeGraphEdge>();
		const tags = new Map<string, KnowledgeGraphNode>();

		for (const file of files) {
			const content = await this.app.vault.read(file);
			const wikilinks = Array.from(content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g))
				.map(match => match[1]?.trim())
				.filter((value): value is string => !!value);
			for (const link of wikilinks) {
				const target = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
				if (!target || !nodeIds.has(target.path)) continue;
				const id = `${file.path}->${target.path}`;
				edgeMap.set(id, { id, from: file.path, to: target.path, type: 'wikilink', confidence: 'EXTRACTED', confidenceScore: 1 });
			}

			const noteTags = new Set(
				Array.from(content.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu))
					.map(match => match[2])
					.filter((tag): tag is string => !!tag && !/^\d+$/.test(tag))
			);
			for (const tag of Array.from(noteTags).slice(0, 20)) {
				const tagId = `tag:${tag}`;
				if (!tags.has(tagId)) {
					tags.set(tagId, {
						id: tagId,
						title: `#${tag}`,
						path: tagId,
						folder: 'tags',
						mtime: 0,
						size: 0,
						kind: 'tag'
					});
				}
				const id = `${file.path}->${tagId}`;
				edgeMap.set(id, { id, from: file.path, to: tagId, type: 'tag', label: `#${tag}`, confidence: 'EXTRACTED', confidenceScore: 1 });
			}
		}

		const allNodes = [...nodes, ...Array.from(tags.values())];
		const allEdges = Array.from(edgeMap.values());
		const analytics = this.analyzeKnowledgeGraph(allNodes, allEdges);
		for (const node of allNodes) {
			node.degree = analytics.degree.get(node.id) || 0;
			node.pageRank = analytics.pageRank.get(node.id) || 0;
			node.community = analytics.communities.get(node.id) || 0;
		}

			const graph = {
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				vault: this.plugin.getVaultPath(),
				syncFolders: this.plugin.settings.syncFolders,
				description: '로컬 문맥 노트의 Obsidian 위키링크와 태그에서 만든 경량 vault 관계도입니다. 연결은 LLM 추론이 아니라 명시 문법에서 추출한 항목입니다.',
			metrics: {
				nodes: allNodes.length,
				noteNodes: nodes.length,
				tagNodes: tags.size,
				edges: allEdges.length,
				communities: analytics.communityCount
			},
			nodes: allNodes,
			edges: allEdges
		};

		const jsonPath = `${graphFolder}/knowledge-graph.json`;
		await this.writeVaultFile(jsonPath, JSON.stringify(graph, null, 2));

		const canvasPath = `${graphFolder}/knowledge-graph.canvas`;
		await this.writeVaultFile(canvasPath, JSON.stringify(this.buildGraphCanvas(graph.nodes, graph.edges), null, 2));

		const reportPath = `${graphFolder}/GRAPH_REPORT.md`;
		await this.writeVaultFile(reportPath, this.buildGraphReport(graph.nodes, graph.edges, analytics.communityCount));

		return {
			jsonPath,
			canvasPath,
			reportPath,
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
			communityCount: analytics.communityCount
		};
	}

	private buildGraphCanvas(
		nodes: KnowledgeGraphNode[],
		edges: KnowledgeGraphEdge[]
	): { nodes: any[]; edges: any[] } {
		const noteCandidates = nodes
			.filter(node => node.kind !== 'tag')
			.sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0) || (b.degree || 0) - (a.degree || 0) || a.title.localeCompare(b.title))
			.slice(0, 120);
		const communities = new Map<number, KnowledgeGraphNode[]>();
		for (const node of noteCandidates) {
			const community = node.community || 0;
			const list = communities.get(community) || [];
			list.push(node);
			communities.set(community, list);
		}
		const communityEntries = Array.from(communities.entries())
			.sort((a, b) => b[1].length - a[1].length)
			.slice(0, 10);
		const selected: KnowledgeGraphNode[] = [];
		const canvasNodes: any[] = [];
		const groupWidth = 1500;
		const groupGapX = 220;
		const groupGapY = 260;
		const columns = 2;
		const columnHeights = new Array(columns).fill(0);

		for (const [groupIndex, [community, members]] of communityEntries.entries()) {
			const shown = members
				.sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0) || (b.degree || 0) - (a.degree || 0))
				.slice(0, groupIndex < 4 ? 18 : 10);
			selected.push(...shown);
			const col = groupIndex % columns;
			const rowY = columnHeights[col];
			const x = col * (groupWidth + groupGapX);
			const y = rowY;
			const childRows = Math.max(1, Math.ceil(Math.max(0, shown.length - 1) / 4));
			const groupHeight = 360 + childRows * 180;
			columnHeights[col] += groupHeight + groupGapY;

			canvasNodes.push({
				id: `community:${community}`,
				type: 'group',
				x,
				y,
					width: groupWidth,
					height: groupHeight,
					color: this.communityCanvasColor(community),
					label: `묶음 ${community + 1} · 노트 ${members.length}개`
			});

			const [hub, ...rest] = shown;
			if (hub) {
				canvasNodes.push({
					id: hub.id,
					type: 'file',
					x: x + 70,
					y: y + 85,
					width: 460,
					height: 190,
					color: this.communityCanvasColor(community),
					file: hub.path
				});
			}

			rest.forEach((node, index) => {
				const innerCol = index % 4;
				const innerRow = Math.floor(index / 4);
				canvasNodes.push({
					id: node.id,
					type: 'file',
					x: x + 580 + innerCol * 220,
					y: y + 85 + innerRow * 175,
					width: 190,
					height: 130,
					color: this.communityCanvasColor(community),
					file: node.path
				});
			});
		}

		const selectedIds = new Set(selected.map(node => node.id));
		const tagNodes = nodes
			.filter(node => node.kind === 'tag' && (node.degree || 0) > 1)
			.sort((a, b) => (b.degree || 0) - (a.degree || 0))
			.slice(0, 14);
		for (const node of tagNodes) selectedIds.add(node.id);

		if (tagNodes.length > 0) {
			const maxHeight = Math.max(...columnHeights);
			const tagX = columns * (groupWidth + groupGapX);
			canvasNodes.push({
				id: 'tag-bridges',
				type: 'group',
				x: tagX,
				y: 0,
					width: 760,
					height: Math.max(520, tagNodes.length * 150 + 180),
					color: '6',
					label: '태그 연결'
				});
			tagNodes.forEach((node, index) => {
				canvasNodes.push({
					id: node.id,
					type: 'text',
					x: tagX + 70,
					y: 90 + index * 145,
					width: 620,
						height: 90,
						color: this.communityCanvasColor(node.community || 5),
						text: `${node.title}\n연결된 노트 ${node.degree || 0}개`
					});
			});
			void maxHeight;
		}

		if (canvasNodes.length === 0) {
			const fallback = noteCandidates.slice(0, 40);
			for (const node of fallback) selectedIds.add(node.id);
			fallback.forEach((node, index) => {
				const col = index % 4;
				const row = Math.floor(index / 4);
				canvasNodes.push({
					id: node.id,
					type: 'file',
					x: col * 340,
					y: row * 210,
					width: 300,
					height: 150,
					color: this.communityCanvasColor(node.community || 0),
					file: node.path
				});
			});
		}

		const visibleEdgeIds = new Set<string>();
		const canvasEdges = edges
			.filter(edge => selectedIds.has(edge.from) && selectedIds.has(edge.to))
			.sort((a, b) => (a.type === 'wikilink' ? -1 : 1) - (b.type === 'wikilink' ? -1 : 1))
			.slice(0, 260)
			.map(edge => {
				const id = visibleEdgeIds.has(edge.id) ? `${edge.id}:${visibleEdgeIds.size}` : edge.id;
				visibleEdgeIds.add(edge.id);
				return {
					id,
					fromNode: edge.from,
					toNode: edge.to,
					label: edge.type === 'wikilink' ? 'link' : ''
				};
			});
		const legendX = 0;
		const legendY = Math.max(...columnHeights, 0) + 80;
		canvasNodes.push({
			id: 'graph-legend',
			type: 'text',
			x: legendX,
			y: legendY,
			width: 1180,
			height: 180,
			color: '6',
			text: [
					'지식 관계도',
					'묶음은 PageRank와 연결 수 기준으로 정렬됩니다. 큰 카드는 로컬 허브 노트이고, 태그 연결은 여러 주제를 가로지르는 태그를 보여줍니다.',
					'이 캔버스는 모든 문맥 노트가 아니라 관계가 뚜렷한 주요 노드를 선별해 보여줍니다.'
				].join('\n')
			});
		return { nodes: canvasNodes, edges: canvasEdges };
	}

	private buildLegacyGridGraphCanvas(
		nodes: KnowledgeGraphNode[],
		edges: KnowledgeGraphEdge[]
	): { nodes: any[]; edges: any[] } {
		const selected = nodes
			.filter(node => node.kind !== 'tag')
			.sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0) || (b.degree || 0) - (a.degree || 0) || a.title.localeCompare(b.title))
			.slice(0, 80);
		const selectedIds = new Set(selected.map(node => node.id));
		const canvasNodes = selected.map((node, index) => {
			const col = index % 8;
			const row = Math.floor(index / 8);
			return {
				id: node.id,
				type: 'file',
				x: col * 340,
				y: row * 210,
				width: 300,
				height: 150,
				color: this.communityCanvasColor(node.community || 0),
				file: node.path
			};
		});
		const canvasEdges = edges
			.filter(edge => selectedIds.has(edge.from) && selectedIds.has(edge.to))
			.slice(0, 200)
			.map(edge => ({
				id: edge.id,
				fromNode: edge.from,
				toNode: edge.to,
				label: edge.type === 'wikilink' ? 'link' : ''
			}));
		return { nodes: canvasNodes, edges: canvasEdges };
	}

	private analyzeKnowledgeGraph(nodes: KnowledgeGraphNode[], edges: KnowledgeGraphEdge[]): {
		degree: Map<string, number>;
		pageRank: Map<string, number>;
		communities: Map<string, number>;
		communityCount: number;
	} {
		const adjacency = this.buildGraphAdjacency(nodes, edges);
		const degree = new Map<string, number>();
		for (const node of nodes) degree.set(node.id, adjacency.get(node.id)?.size || 0);
		const pageRank = this.computePageRank(nodes, adjacency);
		const communities = this.computeLabelPropagation(nodes, adjacency);
		const communityCount = new Set(communities.values()).size;
		return { degree, pageRank, communities, communityCount };
	}

	private buildGraphAdjacency(nodes: KnowledgeGraphNode[], edges: KnowledgeGraphEdge[]): Map<string, Set<string>> {
		const adjacency = new Map<string, Set<string>>();
		for (const node of nodes) adjacency.set(node.id, new Set());
		for (const edge of edges) {
			if (!adjacency.has(edge.from) || !adjacency.has(edge.to) || edge.from === edge.to) continue;
			adjacency.get(edge.from)!.add(edge.to);
			adjacency.get(edge.to)!.add(edge.from);
		}
		return adjacency;
	}

	private computePageRank(nodes: KnowledgeGraphNode[], adjacency: Map<string, Set<string>>): Map<string, number> {
		const count = nodes.length;
		const scores = new Map<string, number>();
		if (count === 0) return scores;
		for (const node of nodes) scores.set(node.id, 1 / count);
		let current = scores;
		for (let i = 0; i < 30; i++) {
			const next = new Map<string, number>();
			for (const node of nodes) next.set(node.id, 0.15 / count);
			for (const node of nodes) {
				const neighbors = adjacency.get(node.id) || new Set<string>();
				if (neighbors.size === 0) continue;
				const share = ((current.get(node.id) || 0) * 0.85) / neighbors.size;
				for (const neighbor of neighbors) next.set(neighbor, (next.get(neighbor) || 0) + share);
			}
			current = next;
		}
		const values = Array.from(current.values());
		const min = Math.min(...values);
		const max = Math.max(...values);
		const range = Math.max(max - min, 1e-9);
		for (const [id, value] of current.entries()) current.set(id, (value - min) / range);
		return current;
	}

	private computeLabelPropagation(nodes: KnowledgeGraphNode[], adjacency: Map<string, Set<string>>): Map<string, number> {
		const labels = new Map<string, number>();
		nodes.forEach((node, index) => labels.set(node.id, index));
		const order = nodes.map(node => node.id).sort();
		for (let iter = 0; iter < 20; iter++) {
			let changed = false;
			for (const id of order) {
				const neighbors = adjacency.get(id);
				if (!neighbors || neighbors.size === 0) continue;
				const counts = new Map<number, number>();
				for (const neighbor of neighbors) {
					const label = labels.get(neighbor);
					if (label === undefined) continue;
					counts.set(label, (counts.get(label) || 0) + 1);
				}
				let bestLabel = labels.get(id) || 0;
				let bestCount = -1;
				for (const [label, count] of counts.entries()) {
					if (count > bestCount || (count === bestCount && label < bestLabel)) {
						bestLabel = label;
						bestCount = count;
					}
				}
				if (labels.get(id) !== bestLabel) {
					labels.set(id, bestLabel);
					changed = true;
				}
			}
			if (!changed) break;
		}
		const sizes = new Map<number, number>();
		for (const label of labels.values()) sizes.set(label, (sizes.get(label) || 0) + 1);
		const remap = new Map<number, number>();
		Array.from(sizes.entries())
			.sort((a, b) => b[1] - a[1])
			.forEach(([label], index) => remap.set(label, index));
		for (const [id, label] of labels.entries()) labels.set(id, remap.get(label) || 0);
		return labels;
	}

	private buildGraphReport(nodes: KnowledgeGraphNode[], edges: KnowledgeGraphEdge[], communityCount: number): string {
		const notes = nodes.filter(node => node.kind === 'note');
		const tags = nodes.filter(node => node.kind === 'tag');
		const hubs = [...nodes]
			.filter(node => node.degree && node.degree > 0)
			.sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0) || (b.degree || 0) - (a.degree || 0))
			.slice(0, 12);
		const communities = new Map<number, KnowledgeGraphNode[]>();
		for (const node of nodes) {
			const community = node.community || 0;
			const list = communities.get(community) || [];
			list.push(node);
			communities.set(community, list);
		}
		const communityLines = Array.from(communities.entries())
			.sort((a, b) => b[1].length - a[1].length)
			.slice(0, 12)
				.map(([community, members]) => {
					const examples = members
						.sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0))
						.slice(0, 5)
						.map(node => node.title)
						.join(', ');
					return `- 묶음 ${community}: 노드 ${members.length}개 - ${examples}`;
				});
			const hubLines = hubs.map(node => {
				const rank = ((node.pageRank || 0) * 100).toFixed(1);
				return `- ${node.title} - PageRank ${rank}, 연결 수 ${node.degree || 0}, 묶음 ${node.community || 0}`;
			});
			return [
				'# 지식 관계도 보고서',
				'',
				`생성 시각: ${new Date().toISOString()}`,
				'',
				'## 범위',
				'',
				`- 노트: ${notes.length}`,
				`- 태그: ${tags.length}`,
				`- 연결: ${edges.length}`,
				`- 묶음: ${communityCount}`,
				'',
				'## 방법',
				'',
				'- 원본 범위: 에이전트 문맥 폴더로 선택한 노트만 사용합니다.',
				'- 연결 기준: Obsidian 위키링크와 태그만 사용합니다.',
				'- 신뢰도: 모든 연결은 노트 문법에서 직접 추출된 항목입니다.',
				'- 분석 방식: Alda graphify 스타일의 경량 PageRank와 Label Propagation 묶음 탐지를 사용합니다.',
				'',
				'## 허브 노드',
				'',
				hubLines.length ? hubLines.join('\n') : '- 아직 연결된 허브가 없습니다. 문맥 노트 사이에 위키링크나 태그를 추가하세요.',
				'',
				'## 묶음',
				'',
				communityLines.length ? communityLines.join('\n') : '- 아직 묶음이 탐지되지 않았습니다.',
				'',
				'## 현재 한계',
				'',
				'- 현재 관계도는 경량 graphify 방식이며, 완전한 의미 기반 엔티티 그래프는 아닙니다.',
				'- LLM으로 엔티티나 개념을 추출하지 않습니다.',
				'- 추론형 또는 모호한 의미 연결은 만들지 않습니다.',
				'- Cytoscape 수준의 별도 대시보드는 아직 포함하지 않습니다.',
				''
			].join('\n');
		}

	private communityCanvasColor(community: number): string {
		const colors = ['1', '2', '3', '4', '5', '6'];
		return colors[community % colors.length];
	}

	private async renderGraphTab() {
		const panel = this.dashboardContentEl.createDiv({ cls: 'mok-panel mok-graph-panel' });
		const header = panel.createDiv({ cls: 'mok-graph-header' });
		header.createEl('h3', { text: '지식 관계도' });
		header.createEl('p', { text: '로컬 문맥 노트를 PageRank 크기, 묶음 색상, 1단계 연결 강조, 클릭 상세 보기로 탐색합니다.' });

		const controls = panel.createDiv({ cls: 'mok-graph-controls' });
		const maxLabel = controls.createEl('label', { cls: 'mok-graph-control-label' });
		maxLabel.createSpan({ text: '상위 노드' });
		const maxInput = maxLabel.createEl('input', { type: 'range' });
		maxInput.min = '80';
		maxInput.max = '300';
		maxInput.step = '10';
		maxInput.value = '120';
		const maxValue = maxLabel.createSpan({ cls: 'mok-graph-control-value', text: maxInput.value });

		const hideLabel = controls.createEl('label', { cls: 'mok-graph-check-label' });
		const hideInput = hideLabel.createEl('input', { type: 'checkbox' });
		hideInput.checked = true;
		hideLabel.createSpan({ text: '고립 노드 숨김' });

		const tagLabel = controls.createEl('label', { cls: 'mok-graph-check-label' });
		const tagInput = tagLabel.createEl('input', { type: 'checkbox' });
		tagInput.checked = false;
		tagLabel.createSpan({ text: '태그 포함' });

		const searchInput = controls.createEl('input', {
				cls: 'mok-graph-search',
				type: 'search',
				placeholder: '노드 검색...'
			});

			const rebuildBtn = controls.createEl('button', {
				cls: 'gemini-chat-action-btn',
				text: '관계도 다시 만들기'
			});

		const zoomOutBtn = controls.createEl('button', {
			cls: 'gemini-chat-action-btn',
			text: '-'
		});
			zoomOutBtn.setAttr('aria-label', '관계도 축소');

		const zoomInBtn = controls.createEl('button', {
			cls: 'gemini-chat-action-btn',
			text: '+'
		});
			zoomInBtn.setAttr('aria-label', '관계도 확대');

			const fitBtn = controls.createEl('button', {
				cls: 'gemini-chat-action-btn',
				text: '맞춤'
			});

			const relayoutBtn = controls.createEl('button', {
				cls: 'gemini-chat-action-btn',
				text: '재배치'
			});

			const resetBtn = controls.createEl('button', {
				cls: 'gemini-chat-action-btn',
				text: '초기화'
			});

		const statsEl = panel.createDiv({ cls: 'mok-graph-stats' });
		const graphWrap = panel.createDiv({ cls: 'mok-graph-wrap' });
		const detailPanel = graphWrap.createDiv({ cls: 'mok-graph-detail mok-graph-detail-hidden' });

			let graph = await this.loadKnowledgeGraph();
			if (!graph) {
				statsEl.setText('아직 관계도가 없습니다. 문맥 노트에서 관계도를 만들어 주세요.');
				const empty = graphWrap.createDiv({ cls: 'mok-graph-empty' });
				empty.createEl('div', { text: '관계도 산출물을 찾지 못했습니다.' });
				empty.createEl('button', {
					cls: 'gemini-chat-action-btn',
					text: '지식 관계도 만들기'
				}).addEventListener('click', async () => {
				await this.buildKnowledgeGraphArtifacts();
				this.renderActiveTab();
			});
			return;
		}

		let currentGraph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; metrics?: any } | null = graph;
		const redraw = () => {
			if (!currentGraph) return;
			maxValue.setText(maxInput.value);
			this.renderInteractiveGraph(graphWrap, statsEl, currentGraph, {
				maxNodes: Number(maxInput.value),
				hideIsolated: hideInput.checked,
				includeTags: tagInput.checked,
				search: searchInput.value
			});
		};

		maxInput.addEventListener('input', redraw);
		hideInput.addEventListener('change', redraw);
		tagInput.addEventListener('change', redraw);
		searchInput.addEventListener('input', redraw);
		zoomOutBtn.addEventListener('click', () => this.zoomGraph(graphWrap, 0.82));
		zoomInBtn.addEventListener('click', () => this.zoomGraph(graphWrap, 1.22));
		fitBtn.addEventListener('click', () => this.resetGraphZoom(graphWrap));
		relayoutBtn.addEventListener('click', redraw);
		resetBtn.addEventListener('click', () => {
			maxInput.value = '120';
			hideInput.checked = true;
			tagInput.checked = false;
			searchInput.value = '';
			redraw();
		});
			rebuildBtn.addEventListener('click', async () => {
				rebuildBtn.setText('생성 중...');
				rebuildBtn.setAttr('disabled', 'true');
				try {
					await this.buildKnowledgeGraphArtifacts();
					currentGraph = await this.loadKnowledgeGraph();
					if (currentGraph) redraw();
					new Notice('지식 관계도를 다시 만들었습니다.');
				} catch (error) {
					new Notice('관계도를 다시 만들지 못했습니다.');
					console.error('관계도 재생성 오류:', error);
				} finally {
					rebuildBtn.removeAttribute('disabled');
					rebuildBtn.setText('관계도 다시 만들기');
				}
			});

		redraw();
	}

	private async loadKnowledgeGraph(): Promise<{ nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; metrics?: any } | null> {
		const path = `${this.plugin.settings.workspaceFolder}/graph/knowledge-graph.json`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		try {
			const raw = await this.app.vault.read(file);
			const graph = JSON.parse(raw);
			if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
			return graph;
		} catch (error) {
			console.error('지식 관계도를 읽지 못했습니다:', error);
			return null;
		}
	}

	private renderInteractiveGraph(
		container: HTMLElement,
		statsEl: HTMLElement,
		graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; metrics?: any },
		options: { maxNodes: number; hideIsolated: boolean; includeTags: boolean; search: string }
	) {
		const existingDetail = container.querySelector('.mok-graph-detail');
		container.empty();
		const detailPanel = container.createDiv({ cls: 'mok-graph-detail mok-graph-detail-hidden' });
		if (existingDetail instanceof HTMLElement && existingDetail.textContent) {
			detailPanel.setText(existingDetail.textContent);
		}
		const allNodes = graph.nodes || [];
		const allEdges = graph.edges || [];
		const degree = new Map<string, number>();
		for (const node of allNodes) degree.set(node.id, node.degree || 0);

		let candidates = allNodes.filter(node => options.includeTags || node.kind !== 'tag');
		if (options.hideIsolated) candidates = candidates.filter(node => (degree.get(node.id) || 0) > 0);
		const selected = candidates
			.sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0) || (degree.get(b.id) || 0) - (degree.get(a.id) || 0))
			.slice(0, options.maxNodes);
		const selectedIds = new Set(selected.map(node => node.id));
		const selectedById = new Map(selected.map(node => [node.id, node]));
		const rawEdges = allEdges.filter(edge =>
			selectedIds.has(edge.from) &&
			selectedIds.has(edge.to) &&
			(options.includeTags || edge.type === 'wikilink')
		);
		const edges = this.capGraphEdges(rawEdges, selected, options.includeTags ? 520 : 340, options.includeTags ? 10 : 8);
		const layout = this.computeForceLayout(selected, edges, container.clientWidth || 1100, 620);
		const neighbors = new Map<string, Set<string>>();
		for (const node of selected) neighbors.set(node.id, new Set());
		for (const edge of edges) {
			neighbors.get(edge.from)?.add(edge.to);
			neighbors.get(edge.to)?.add(edge.from);
		}

		const search = options.search.trim().toLowerCase();
		const searchHits = search
			? selected.filter(node => (node.title || node.path).toLowerCase().includes(search)).length
			: 0;
			statsEl.setText(`노드 ${selected.length}개 · 표시 연결 ${edges.length}/${rawEdges.length}개 · 묶음 ${new Set(selected.map(node => node.community || 0)).size}개${search ? ` · 검색 결과 ${searchHits}개` : ''}`);

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
		svg.setAttribute('class', 'mok-graph-svg');
		svg.setAttribute('data-graph-scale', '1');
		svg.setAttribute('data-graph-x', '0');
		svg.setAttribute('data-graph-y', '0');
		container.appendChild(svg);

		const viewport = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		viewport.setAttribute('class', 'mok-graph-viewport');
		svg.appendChild(viewport);

		const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		edgeLayer.setAttribute('class', 'mok-graph-edge-layer');
		viewport.appendChild(edgeLayer);
		const nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		nodeLayer.setAttribute('class', 'mok-graph-node-layer');
		viewport.appendChild(nodeLayer);
		this.attachGraphNavigation(svg, viewport, detailPanel, layout.width, layout.height);

		const nodeElements = new Map<string, SVGElement>();
		const edgeElements: Array<{ element: SVGElement; from: string; to: string }> = [];
		for (const edge of edges) {
			const from = layout.positions.get(edge.from);
			const to = layout.positions.get(edge.to);
			if (!from || !to) continue;
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', String(from.x));
			line.setAttribute('y1', String(from.y));
			line.setAttribute('x2', String(to.x));
			line.setAttribute('y2', String(to.y));
			line.setAttribute('class', edge.type === 'wikilink' ? 'mok-graph-edge mok-graph-edge-link' : 'mok-graph-edge');
			edgeLayer.appendChild(line);
			edgeElements.push({ element: line, from: edge.from, to: edge.to });
		}

		for (const node of selected) {
			const pos = layout.positions.get(node.id);
			if (!pos) continue;
			const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
			const title = node.title || node.path;
			const isSearchHit = search && title.toLowerCase().includes(search);
			group.setAttribute('class', isSearchHit ? 'mok-graph-node mok-graph-node-search-hit' : 'mok-graph-node');
			group.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);

			const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			circle.setAttribute('r', String(pos.r));
			circle.setAttribute('fill', this.communityGraphColor(node.community || 0));
			circle.setAttribute('data-node-id', node.id);
			circle.setAttribute('data-node-kind', node.kind);
			group.appendChild(circle);

			if (pos.r > 12 || isSearchHit) {
				const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
				label.setAttribute('y', String(pos.r + 13));
				label.setAttribute('text-anchor', 'middle');
				label.textContent = this.truncateGraphLabel(title, pos.r > 18 ? 18 : 12);
				group.appendChild(label);
			}

			const tooltip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
			tooltip.textContent = `${title}\n${node.path}\n연결 수 ${node.degree || 0} · PageRank ${Math.round((node.pageRank || 0) * 100)}`;
			group.appendChild(tooltip);

			group.addEventListener('mouseenter', () => {
				const related = neighbors.get(node.id) || new Set<string>();
				for (const [id, el] of nodeElements.entries()) {
					el.toggleClass('mok-graph-faded', id !== node.id && !related.has(id));
				}
				for (const edgeEl of edgeElements) {
					const active = edgeEl.from === node.id || edgeEl.to === node.id;
					edgeEl.element.toggleClass('mok-graph-edge-highlight', active);
					edgeEl.element.toggleClass('mok-graph-faded', !active);
				}
			});
			group.addEventListener('mouseleave', () => {
				for (const el of nodeElements.values()) el.removeClass('mok-graph-faded');
				for (const edgeEl of edgeElements) {
					edgeEl.element.removeClass('mok-graph-edge-highlight');
					edgeEl.element.removeClass('mok-graph-faded');
				}
			});
			group.addEventListener('click', async () => {
				await this.showGraphNodeDetail(detailPanel, node, Array.from(neighbors.get(node.id) || []), selectedById);
			});

			nodeLayer.appendChild(group);
			nodeElements.set(node.id, group);
		}

		svg.addEventListener('click', (event) => {
			if (event.target === svg) detailPanel.addClass('mok-graph-detail-hidden');
		});
	}

	private attachGraphNavigation(svg: SVGSVGElement, viewport: SVGGElement, detailPanel: HTMLElement, width: number, height: number) {
		let isPanning = false;
		let last: { x: number; y: number } | null = null;
		const getState = () => ({
			scale: Number(svg.dataset.graphScale || '1'),
			x: Number(svg.dataset.graphX || '0'),
			y: Number(svg.dataset.graphY || '0')
		});
		const apply = (state: { scale: number; x: number; y: number }) => {
			svg.dataset.graphScale = String(state.scale);
			svg.dataset.graphX = String(state.x);
			svg.dataset.graphY = String(state.y);
			viewport.setAttribute('transform', `translate(${state.x} ${state.y}) scale(${state.scale})`);
		};
		const point = (event: MouseEvent | WheelEvent | PointerEvent) => {
			const rect = svg.getBoundingClientRect();
			return {
				x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * width,
				y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * height
			};
		};
		const zoomAt = (factor: number, cx: number, cy: number) => {
			const current = getState();
			const nextScale = Math.max(0.35, Math.min(4, current.scale * factor));
			const ratio = nextScale / current.scale;
			apply({
				scale: nextScale,
				x: cx - (cx - current.x) * ratio,
				y: cy - (cy - current.y) * ratio
			});
		};

		svg.addEventListener('wheel', (event) => {
			event.preventDefault();
			const p = point(event);
			zoomAt(event.deltaY < 0 ? 1.12 : 0.89, p.x, p.y);
		}, { passive: false });
		svg.addEventListener('pointerdown', (event) => {
			const target = event.target as Element;
			if (target.closest('.mok-graph-node') || target.closest('.mok-graph-detail')) return;
			isPanning = true;
			last = point(event);
			detailPanel.addClass('mok-graph-detail-hidden');
			svg.addClass('mok-graph-panning');
			svg.setPointerCapture(event.pointerId);
		});
		svg.addEventListener('pointermove', (event) => {
			if (!isPanning || !last) return;
			const p = point(event);
			const state = getState();
			apply({
				scale: state.scale,
				x: state.x + p.x - last.x,
				y: state.y + p.y - last.y
			});
			last = p;
		});
		const stopPan = (event: PointerEvent) => {
			if (!isPanning) return;
			isPanning = false;
			last = null;
			svg.removeClass('mok-graph-panning');
			try {
				svg.releasePointerCapture(event.pointerId);
			} catch {
				// Pointer capture may already be released by the browser.
			}
		};
		svg.addEventListener('pointerup', stopPan);
		svg.addEventListener('pointercancel', stopPan);
	}

	private zoomGraph(container: HTMLElement, factor: number) {
		const svg = container.querySelector('.mok-graph-svg') as SVGSVGElement | null;
		const viewport = container.querySelector('.mok-graph-viewport') as SVGGElement | null;
		if (!svg || !viewport) return;
		const viewBox = svg.viewBox.baseVal;
		const current = {
			scale: Number(svg.dataset.graphScale || '1'),
			x: Number(svg.dataset.graphX || '0'),
			y: Number(svg.dataset.graphY || '0')
		};
		const cx = viewBox.width / 2;
		const cy = viewBox.height / 2;
		const nextScale = Math.max(0.35, Math.min(4, current.scale * factor));
		const ratio = nextScale / current.scale;
		const next = {
			scale: nextScale,
			x: cx - (cx - current.x) * ratio,
			y: cy - (cy - current.y) * ratio
		};
		svg.dataset.graphScale = String(next.scale);
		svg.dataset.graphX = String(next.x);
		svg.dataset.graphY = String(next.y);
		viewport.setAttribute('transform', `translate(${next.x} ${next.y}) scale(${next.scale})`);
	}

	private resetGraphZoom(container: HTMLElement) {
		const svg = container.querySelector('.mok-graph-svg') as SVGSVGElement | null;
		const viewport = container.querySelector('.mok-graph-viewport') as SVGGElement | null;
		if (!svg || !viewport) return;
		svg.dataset.graphScale = '1';
		svg.dataset.graphX = '0';
		svg.dataset.graphY = '0';
		viewport.setAttribute('transform', 'translate(0 0) scale(1)');
	}

	private async showGraphNodeDetail(
		panel: HTMLElement,
		node: KnowledgeGraphNode,
		visibleNeighborIds: string[],
		selectedById: Map<string, KnowledgeGraphNode>
	) {
		panel.empty();
		panel.removeClass('mok-graph-detail-hidden');
		const close = panel.createEl('button', { cls: 'mok-graph-detail-close', text: 'x' });
		close.setAttr('aria-label', '관계도 상세 닫기');
		close.addEventListener('click', () => panel.addClass('mok-graph-detail-hidden'));
			panel.createEl('div', {
				cls: 'mok-graph-detail-kind',
				text: node.kind === 'tag' ? '태그 연결' : '문맥 노트'
			});
		panel.createEl('h4', { text: node.title || node.path });
			panel.createEl('p', {
				text: `${node.path} · 연결 수 ${node.degree || 0} · 표시된 이웃 ${visibleNeighborIds.length}개 · PageRank ${Math.round((node.pageRank || 0) * 100)}`
			});
		if (node.kind === 'note') {
			const file = this.app.vault.getAbstractFileByPath(node.path);
			if (file instanceof TFile) {
				const preview = (await this.app.vault.cachedRead(file))
					.replace(/---[\s\S]*?---/, '')
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, 360);
				if (preview) panel.createEl('p', { cls: 'mok-graph-detail-preview', text: preview });
				const actions = panel.createDiv({ cls: 'mok-graph-detail-actions' });
					const openBtn = actions.createEl('button', { cls: 'gemini-chat-action-btn', text: '노트 열기' });
				openBtn.addEventListener('click', async () => {
					await this.app.workspace.getLeaf(true).openFile(file);
				});
			}
		}
		const neighbors = visibleNeighborIds
			.map(id => selectedById.get(id))
			.filter((neighbor): neighbor is KnowledgeGraphNode => !!neighbor)
			.sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0))
			.slice(0, 10);
			if (neighbors.length > 0) {
				const relationWrap = panel.createDiv({ cls: 'mok-graph-detail-relations' });
				relationWrap.createEl('strong', { text: '표시된 연결' });
			for (const neighbor of neighbors) {
				const item = relationWrap.createEl('button', {
					cls: 'mok-graph-relation-btn',
					text: neighbor.title || neighbor.path
				});
				item.addEventListener('click', async () => {
					if (neighbor.kind !== 'note') return;
					const file = this.app.vault.getAbstractFileByPath(neighbor.path);
					if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
				});
			}
		}
	}

	private capGraphEdges(
		edges: KnowledgeGraphEdge[],
		nodes: KnowledgeGraphNode[],
		maxEdges: number,
		maxPerNode: number
	): KnowledgeGraphEdge[] {
		const nodeById = new Map(nodes.map(node => [node.id, node]));
		const countByNode = new Map<string, number>();
		const hubPenalty = (edge: KnowledgeGraphEdge) => {
			const from = nodeById.get(edge.from);
			const to = nodeById.get(edge.to);
			const maxDegree = Math.max(from?.degree || 0, to?.degree || 0);
			return Math.min(maxDegree, 500);
		};
		const sorted = [...edges].sort((a, b) => {
			const aSame = (nodeById.get(a.from)?.community || 0) === (nodeById.get(a.to)?.community || 0) ? 0 : 1;
			const bSame = (nodeById.get(b.from)?.community || 0) === (nodeById.get(b.to)?.community || 0) ? 0 : 1;
			return aSame - bSame || hubPenalty(a) - hubPenalty(b);
		});
		const selected: KnowledgeGraphEdge[] = [];
		for (const edge of sorted) {
			if (selected.length >= maxEdges) break;
			const fromCount = countByNode.get(edge.from) || 0;
			const toCount = countByNode.get(edge.to) || 0;
			if (fromCount >= maxPerNode || toCount >= maxPerNode) continue;
			selected.push(edge);
			countByNode.set(edge.from, fromCount + 1);
			countByNode.set(edge.to, toCount + 1);
		}
		if (selected.length >= Math.min(maxEdges, edges.length) || maxPerNode >= 20) return selected;
		for (const edge of sorted) {
			if (selected.length >= maxEdges) break;
			if (selected.includes(edge)) continue;
			const fromCount = countByNode.get(edge.from) || 0;
			const toCount = countByNode.get(edge.to) || 0;
			if (fromCount >= maxPerNode + 3 || toCount >= maxPerNode + 3) continue;
			selected.push(edge);
			countByNode.set(edge.from, fromCount + 1);
			countByNode.set(edge.to, toCount + 1);
		}
		return selected;
	}

	private computeForceLayout(
		nodes: KnowledgeGraphNode[],
		edges: KnowledgeGraphEdge[],
		width: number,
		height: number
	): { width: number; height: number; positions: Map<string, { x: number; y: number; r: number }> } {
		const safeWidth = Math.max(width, 900);
		const safeHeight = Math.max(height, 560);
		const positions = new Map<string, { x: number; y: number; vx: number; vy: number; r: number; community: number }>();
		const communities = Array.from(new Set(nodes.map(node => node.community || 0))).sort((a, b) => a - b);
		const centerByCommunity = new Map<number, { x: number; y: number }>();
		const communityCounts = new Map<number, number>();
		for (const node of nodes) communityCounts.set(node.community || 0, (communityCounts.get(node.community || 0) || 0) + 1);
		const topCommunities = new Set(
			Array.from(communityCounts.entries())
				.sort((a, b) => b[1] - a[1])
				.slice(0, 12)
				.map(([community]) => community)
		);
		const ring = Math.min(safeWidth, safeHeight) * 0.18;
		communities.forEach((community, index) => {
			const centerSeed = this.graphSeed(`community:${community}`);
			const angle = centerSeed * Math.PI * 2;
			const radial = topCommunities.has(community) ? ring : ring * 0.45;
			centerByCommunity.set(community, {
				x: safeWidth / 2 + Math.cos(angle) * radial,
				y: safeHeight / 2 + Math.sin(angle) * radial * 0.68
			});
			void index;
		});

		nodes.forEach((node, index) => {
			const community = node.community || 0;
			const center = centerByCommunity.get(community) || { x: safeWidth / 2, y: safeHeight / 2 };
			const seed = this.graphSeed(node.id);
			const angle = seed * Math.PI * 2;
			const radius = 26 + ((index % 13) * 7);
			const nodeRadius = node.kind === 'tag'
				? 7 + Math.min(node.degree || 0, 35) * 0.16
				: 6 + Math.sqrt(Math.max(0, node.pageRank || 0)) * 20 + Math.min(node.degree || 0, 40) * 0.12;
			positions.set(node.id, {
				x: center.x + Math.cos(angle) * radius,
				y: center.y + Math.sin(angle) * radius,
				vx: 0,
				vy: 0,
				r: Math.max(5, Math.min(26, nodeRadius)),
				community
			});
		});

		const visibleEdges = edges
			.filter(edge => positions.has(edge.from) && positions.has(edge.to))
			.slice(0, 420);
		for (let iter = 0; iter < 180; iter++) {
			const alpha = 1 - iter / 180;
			for (let i = 0; i < nodes.length; i++) {
				const a = positions.get(nodes[i].id);
				if (!a) continue;
				for (let j = i + 1; j < nodes.length; j++) {
					const b = positions.get(nodes[j].id);
					if (!b) continue;
					const dx = a.x - b.x;
					const dy = a.y - b.y;
					const distSq = Math.max(dx * dx + dy * dy, 220);
					const force = (a.community === b.community ? 320 : 620) / distSq;
					const fx = dx * force * alpha;
					const fy = dy * force * alpha;
					a.vx += fx;
					a.vy += fy;
					b.vx -= fx;
					b.vy -= fy;
				}
			}
			for (const edge of visibleEdges) {
				const a = positions.get(edge.from);
				const b = positions.get(edge.to);
				if (!a || !b) continue;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
				const desired = edge.type === 'wikilink' ? 105 : 150;
				const force = (dist - desired) * (edge.type === 'wikilink' ? 0.006 : 0.003) * alpha;
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				a.vx += fx;
				a.vy += fy;
				b.vx -= fx;
				b.vy -= fy;
			}
			for (const item of positions.values()) {
				const center = centerByCommunity.get(item.community) || { x: safeWidth / 2, y: safeHeight / 2 };
				item.vx += (center.x - item.x) * 0.009 * alpha;
				item.vy += (center.y - item.y) * 0.009 * alpha;
				item.vx += (safeWidth / 2 - item.x) * 0.0025 * alpha;
				item.vy += (safeHeight / 2 - item.y) * 0.0025 * alpha;
				item.x += item.vx;
				item.y += item.vy;
				item.vx *= 0.72;
				item.vy *= 0.72;
			}
		}

		const output = new Map<string, { x: number; y: number; r: number }>();
		const raw = Array.from(positions.values());
		const minX = Math.min(...raw.map(item => item.x - item.r));
		const maxX = Math.max(...raw.map(item => item.x + item.r));
		const minY = Math.min(...raw.map(item => item.y - item.r));
		const maxY = Math.max(...raw.map(item => item.y + item.r));
		const padding = 58;
		const scale = Math.min(
			(safeWidth - padding * 2) / Math.max(maxX - minX, 1),
			(safeHeight - padding * 2) / Math.max(maxY - minY, 1),
			1.25
		);
		for (const [id, item] of positions.entries()) {
			output.set(id, {
				x: padding + (item.x - minX) * scale,
				y: padding + (item.y - minY) * scale,
				r: item.r
			});
		}
		return { width: safeWidth, height: safeHeight, positions: output };
	}

	private communityGraphColor(community: number): string {
		const colors = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16', '#14b8a6', '#f97316', '#a855f7', '#22c55e'];
		return colors[Math.abs(community) % colors.length];
	}

	private graphSeed(value: string): number {
		let hash = 2166136261;
		for (let i = 0; i < value.length; i++) {
			hash ^= value.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0) / 4294967295;
	}

	private truncateGraphLabel(label: string, max: number): string {
		return label.length > max ? `${label.slice(0, max - 1)}…` : label;
	}

	private async writeVaultFile(path: string, content: string) {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}

	private renderSettingsTab() {
		const panel = this.dashboardContentEl.createDiv({ cls: 'mok-panel' });
		panel.createEl('h3', { text: '설정' });
		panel.createEl('p', { text: '문맥 폴더, 에이전트 CLI 경로, 에이전트 결과 폴더, 로컬 작업공간 옵션을 변경합니다.' });
		const openBtn = panel.createEl('button', {
			cls: 'gemini-chat-action-btn',
			text: '지식 마스터 설정 열기'
		});
		openBtn.addEventListener('click', () => this.plugin.openPluginSettings());
	}

	private showWelcomeMessage() {
		this.welcomeEl = this.messagesContainer.createDiv({ cls: 'gemini-chat-welcome' });
		this.welcomeEl.createEl('div', { cls: 'gemini-chat-welcome-icon', text: '🧭' });
		this.welcomeEl.createEl('h3', { text: '에이전트 작업공간' });
		this.welcomeEl.createEl('p', { text: '로컬 CLI OAuth 세션으로 Obsidian 안에서 Antigravity/AGY 작업을 실행하고, 결과를 노트에 반영합니다.' });

		const contextCount = this.plugin.getKnowledgeMarkdownFiles().length;
		if (contextCount === 0) {
				this.welcomeEl.createEl('p', {
					cls: 'gemini-chat-welcome-warning',
					text: '⚠️ 아직 문맥 노트가 선택되지 않았습니다. 설정에서 문맥 폴더를 선택하면 에이전트 실행 시 노트 발췌가 함께 전달됩니다.'
				});
			}

		return;
	}

	private renderAgentModeBar(container: HTMLElement) {
		const modeBar = container.createDiv({ cls: 'mok-agent-mode-bar' });
			const webSearchButton = modeBar.createEl('button', {
				cls: this.plugin.settings.agentWebSearchEnabled
					? 'mok-agent-mode-toggle mok-agent-mode-toggle-active'
					: 'mok-agent-mode-toggle',
				text: this.plugin.settings.agentWebSearchEnabled ? '웹 검색 켜짐' : '웹 검색 꺼짐'
			});
		webSearchButton.setAttr('aria-pressed', String(this.plugin.settings.agentWebSearchEnabled));
		webSearchButton.addEventListener('click', async () => {
			this.plugin.settings.agentWebSearchEnabled = !this.plugin.settings.agentWebSearchEnabled;
			await this.plugin.saveSettings();
			this.renderActiveTab();
		});
			modeBar.createSpan({
				cls: 'mok-agent-mode-hint',
				text: this.plugin.settings.agentWebSearchEnabled
					? '필요하면 최신 웹 자료를 사용할 수 있습니다.'
					: '요청이 없으면 vault 문맥에 집중합니다.'
			});
	}

	private async sendMessage() {
		const text = this.inputEl.value.trim();
		if (!text || this.isLoading) return;
		const requestTab = this.activeTab;
		const requestContainer = this.messagesContainer;
		const requestInput = this.inputEl;
		const requestButton = this.sendButton;

			if (requestTab !== 'agent') {
				new Notice('이 AGY 전용 fork에서는 일반 채팅을 사용하지 않습니다. 에이전트 탭을 사용하세요.');
				return;
			}

		// Clear welcome message
		const welcomeEl = this.messagesContainer.querySelector('.gemini-chat-welcome');
		if (welcomeEl) {
			welcomeEl.remove();
		}

		// Add user message
		const userMessage: ChatMessage = {
			role: 'user',
			content: text
		};
		const list = this.agentMessages;
		list.push(userMessage);
		this.renderMessage(userMessage);

		// Clear input
		requestInput.value = '';
		requestInput.style.height = 'auto';

		// Show loading
		this.isLoading = true;
		this.loadingTab = requestTab;
			requestButton.disabled = requestTab !== 'agent';
			requestButton.textContent = requestTab === 'agent' ? '■' : '⏳';
			requestButton.setAttr('aria-label', requestTab === 'agent' ? '에이전트 중지' : '실행 중');

		const loadingEl = requestContainer.createDiv({ cls: 'gemini-chat-loading' });
		loadingEl.createEl('span', { cls: 'gemini-chat-loading-dots', text: '●●●' });
			const loadingLabel = loadingEl.createEl('span', {
				cls: 'gemini-chat-loading-label',
				text: requestTab === 'agent' ? '에이전트 실행 중 0초...' : '생각 중입니다...'
			});
		const startedAt = Date.now();
		const loadingTimer = requestTab === 'agent'
				? window.setInterval(() => {
					const seconds = Math.floor((Date.now() - startedAt) / 1000);
					loadingLabel.setText(`에이전트 실행 중 ${seconds}초...`);
				}, 1000)
				: null;

		// Scroll to bottom
		this.scrollToBottom();

		let streamingMessage: ChatMessage | null = null;
		let streamedContent = '';
		let lastStreamRender = 0;
		if (requestTab === 'agent') {
				streamingMessage = {
					role: 'model',
					content: '에이전트를 시작하고 있습니다...',
					isStreaming: true
				};
			list.push(streamingMessage);
			if (this.activeTab === requestTab) this.renderActiveTab();
		}

		try {
			const response = await this.runAgentMessage(text, (chunk, stream) => {
					if (!streamingMessage || stream !== 'stdout') return;
					streamedContent += chunk;
					streamingMessage.content = streamedContent.trim() || '에이전트가 실행 중입니다...';
				const now = Date.now();
				if (this.activeTab === requestTab && now - lastStreamRender > 350) {
					lastStreamRender = now;
					this.renderActiveTab();
				}
			});

			if (streamingMessage) {
				streamingMessage.content = response.content;
				streamingMessage.citations = response.citations;
				streamingMessage.isStreaming = false;
			} else {
				list.push(response);
			}
			} catch (error) {
				const errorMessage: ChatMessage = {
					role: 'model',
					content: `오류: ${error instanceof Error ? error.message : '응답을 가져오지 못했습니다.'}`
				};
			if (streamingMessage) {
				streamingMessage.content = errorMessage.content;
				streamingMessage.isStreaming = false;
			} else {
				list.push(errorMessage);
			}
		} finally {
			if (loadingTimer !== null) window.clearInterval(loadingTimer);
			loadingEl.remove();
			this.isLoading = false;
			this.loadingTab = null;

			if (this.activeTab === requestTab) {
				this.renderActiveTab();
			}
		}
	}

	private stopAgentRun() {
		const stopped = this.plugin.agentService.stop();
		new Notice(stopped ? '에이전트 실행을 중지했습니다.' : '중지할 에이전트 실행이 없습니다.');
	}

	private async runAgentMessage(
		text: string,
		onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void
	): Promise<ChatMessage> {
		const result = await this.plugin.agentService.run(text, onChunk);
			const contextLine = result.contextStats
				? [
					`지식 문맥: 로컬 문맥 노트 ${result.contextStats.totalContextNotes}개 사용 가능; `,
					`이번 실행에 관련 노트 발췌 ${result.contextStats.loadedExcerptNotes}개 포함`,
					result.contextStats.truncatedByBudget ? ' (에이전트 프롬프트 한도에 맞춰 일부 생략됨).' : '.'
				].join('')
				: '';
		const savedNotePath = this.extractVaultNotePath(result.content);
		return {
			role: 'model',
			content: [
				result.content,
				'',
					'---',
					contextLine,
					`에이전트 명령: \`${result.command}\``,
					`실행 시간: ${(result.durationMs / 1000).toFixed(1)}초`,
					result.logPath ? `에이전트 로그: [[${result.logPath}]]` : '',
					result.agyLogPath ? `AGY 로그: [[${result.agyLogPath}]]` : '',
					result.exitCode === 0 ? '' : `종료 코드: ${result.exitCode ?? '알 수 없음'}`
				].filter(Boolean).join('\n'),
			savedNotePath: savedNotePath || undefined
		};
	}

	private renderMessage(message: ChatMessage) {
		const msgEl = this.messagesContainer.createDiv({
			cls: `gemini-chat-message gemini-chat-message-${message.role}`
		});

		// Avatar
		const avatarEl = msgEl.createDiv({ cls: 'gemini-chat-avatar' });
		avatarEl.textContent = message.role === 'user' ? '👤' : '🤖';

		// Content wrapper - contains content, citations, and actions vertically stacked
		const contentWrapper = msgEl.createDiv({ cls: 'gemini-chat-content-wrapper' });

		// Content
		const contentEl = contentWrapper.createDiv({ cls: 'gemini-chat-content' });

		// Render markdown content
		MarkdownRenderer.renderMarkdown(
			message.content,
			contentEl,
			'',
			this
		);

		// Process citation links
		this.processCitationLinks(contentEl);
		this.processVaultFileLinks(contentEl);

		// Render citations if present
			if (message.citations && message.citations.length > 0) {
				const citationsEl = contentWrapper.createDiv({ cls: 'gemini-chat-citations' });
				citationsEl.createEl('div', { cls: 'gemini-chat-citations-label', text: '📎 출처:' });

			for (const citation of message.citations) {
				this.renderCitationPreview(citationsEl, citation);
			}
		}

			if (message.logPath) {
				const logEl = contentWrapper.createDiv({ cls: 'gemini-chat-log-link' });
				logEl.createEl('span', { text: '로그: ' });
			const logLink = logEl.createEl('a', { text: message.logPath, href: '#' });
			logLink.addEventListener('click', async (event) => {
				event.preventDefault();
				await this.app.workspace.openLinkText(message.logPath || '', '', true);
			});
		}

			if (message.savedNotePath) {
				const savedEl = contentWrapper.createDiv({ cls: 'gemini-chat-log-link' });
				savedEl.createEl('span', { text: '저장된 노트: ' });
			const savedLink = savedEl.createEl('a', { text: message.savedNotePath, href: '#' });
			savedLink.addEventListener('click', async (event) => {
				event.preventDefault();
				await this.app.workspace.openLinkText(message.savedNotePath || '', '', true);
			});
		}

		// Add Apply/Copy buttons for model responses
		if (message.role === 'model' && !message.isStreaming) {
			this.renderActionButtons(contentWrapper, message);
		}

		this.scrollToBottom();
	}

	private processCitationLinks(container: HTMLElement) {
		// Find all [Source: filename.md] patterns and make them clickable
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];

		while (walker.nextNode()) {
			textNodes.push(walker.currentNode as Text);
		}

		for (const textNode of textNodes) {
			const text = textNode.textContent || '';
			const pattern = /\[Source:\s*([^\]]+)\]/g;
			let match: RegExpExecArray | null;
			let lastIndex = 0;
			const fragments: (string | HTMLElement)[] = [];

			while ((match = pattern.exec(text)) !== null) {
				// Add text before match
				if (match.index > lastIndex) {
					fragments.push(text.slice(lastIndex, match.index));
				}

				// Create clickable link
				const sourcePath = match[1];
				const file = this.resolveCitationFile(sourcePath);
				const link = document.createElement('a');
				if (file) {
					link.className = 'gemini-chat-inline-citation';
					link.textContent = `📄 ${file.basename}`;
					link.href = '#';
					link.addEventListener('click', (e) => {
						e.preventDefault();
						this.openNote(file.path);
					});
					this.attachCitationHover(link, file);
					fragments.push(link);
				} else {
					const missing = document.createElement('span');
					missing.className = 'gemini-chat-inline-citation gemini-chat-inline-citation-missing';
					missing.textContent = `📄 ${sourcePath}`;
					fragments.push(missing);
				}

				lastIndex = match.index + match[0].length;
			}

			// Add remaining text
			if (lastIndex < text.length) {
				fragments.push(text.slice(lastIndex));
			}

			// Replace text node if we found matches
			if (fragments.length > 1) {
				const span = document.createElement('span');
				for (const fragment of fragments) {
					if (typeof fragment === 'string') {
						span.appendChild(document.createTextNode(fragment));
					} else {
						span.appendChild(fragment);
					}
				}
				textNode.parentNode?.replaceChild(span, textNode);
			}
		}
	}

	private processVaultFileLinks(container: HTMLElement) {
		const links = Array.from(container.querySelectorAll('a[href]')) as HTMLAnchorElement[];
		for (const link of links) {
			const vaultPath = this.findVaultNotePath(link.href) || this.findVaultNotePath(link.textContent || '');
			if (!vaultPath) continue;
			link.addClass('gemini-chat-inline-citation');
			link.setAttr('href', '#');
			link.addEventListener('click', async (event) => {
				event.preventDefault();
				await this.app.workspace.openLinkText(vaultPath, '', true);
			});
			if (!link.nextElementSibling?.hasClass('gemini-chat-find-note-btn')) {
					const findButton = document.createElement('button');
					findButton.className = 'gemini-chat-find-note-btn';
					findButton.textContent = '노트 찾기';
				findButton.addEventListener('click', async (event) => {
					event.preventDefault();
					event.stopPropagation();
					await this.app.workspace.openLinkText(vaultPath, '', true);
				});
				link.insertAdjacentElement('afterend', findButton);
			}
		}
	}

	private extractVaultNotePath(text: string): string | null {
		const candidates: string[] = [];
		const markdownLinks = /\[([^\]]+)]\(([^)]+)\)/g;
		const bareFileUrl = /file:\/\/[^\s)]+(?:\.md)?/g;
		const savedLocation = /(?:저장\s*위치|saved\s*note|saved\s*location|file|파일)\s*[:：]\s*([^\n]+)/gi;
		let match: RegExpExecArray | null;

		while ((match = markdownLinks.exec(text)) !== null) {
			candidates.push(match[1], match[2]);
		}
		while ((match = bareFileUrl.exec(text)) !== null) candidates.push(match[0]);
		while ((match = savedLocation.exec(text)) !== null) candidates.push(match[1]);
		candidates.push(text.trim());

		for (const candidate of candidates) {
			const vaultPath = this.findVaultNotePath(candidate);
			if (vaultPath) return vaultPath;
		}
		return null;
	}

	private findVaultNotePath(candidate: string): string | null {
		const cleaned = this.cleanNoteCandidate(candidate);
		if (!cleaned) return null;

		const directCandidates = [cleaned];
		if (!cleaned.endsWith('.md')) directCandidates.push(`${cleaned}.md`);

		for (const direct of directCandidates) {
			const absolute = this.toAbsoluteVaultCandidate(direct);
			if (absolute) {
				const vaultRoot = this.plugin.getVaultPath().replace(/\\/g, '/').replace(/\/+$/g, '');
				if (absolute.startsWith(`${vaultRoot}/`)) {
					const relativePath = decodeURIComponent(absolute.slice(vaultRoot.length + 1));
					const file = this.app.vault.getAbstractFileByPath(relativePath);
					if (file instanceof TFile && file.extension === 'md') return file.path;
				}
			}

			const file = this.app.vault.getAbstractFileByPath(direct);
			if (file instanceof TFile && file.extension === 'md') return file.path;
		}

		const normalizedCandidates = directCandidates.map(path => this.normalizeCitationPath(path));
		const basenameCandidates = normalizedCandidates.map(path => path.split('/').pop() || path);
		const matches = this.app.vault.getMarkdownFiles().filter(file => {
			const normalizedPath = this.normalizeCitationPath(file.path);
			const normalizedName = this.normalizeCitationPath(file.name);
			return normalizedCandidates.some(candidate =>
				normalizedPath === candidate ||
				normalizedPath.endsWith(`/${candidate}`) ||
				normalizedName === candidate
			) || basenameCandidates.some(name => normalizedName === name);
		});

		return matches[0]?.path || null;
	}

	private cleanNoteCandidate(candidate: string): string {
		return decodeURIComponent(candidate || '')
			.trim()
			.replace(/^["'`]+|["'`]+$/g, '')
			.replace(/^<|>$/g, '')
			.replace(/^\.?\//, '')
			.replace(/^\[\[/, '')
			.replace(/\]\]$/, '')
			.split('|')[0]
			.replace(/\s+$/g, '')
			.trim();
	}

	private toAbsoluteVaultCandidate(candidate: string): string | null {
		const trimmed = candidate.trim().replace(/^["']|["']$/g, '');
		try {
			if (trimmed.startsWith('file://')) {
				return decodeURIComponent(new URL(trimmed).pathname).replace(/\\/g, '/');
			}
		} catch {
			return null;
		}
		if (trimmed.startsWith(this.plugin.getVaultPath())) {
			return trimmed.replace(/\\/g, '/');
		}
		return null;
	}

	private async openNote(path: string) {
		// Clean up the path
		let cleanPath = path.trim();

		// Remove .md extension if checking for file
		if (!cleanPath.endsWith('.md')) {
			cleanPath += '.md';
		}

		// Try to find the file in the local context scope.
		const file = this.resolveCitationFile(cleanPath);

		if (file instanceof TFile) {
			// Open the file
			await this.app.workspace.openLinkText(file.path, '', true);
		} else {
			// Try to find by name only (without path)
			const fileName = cleanPath.split('/').pop() || cleanPath;
			const files = this.getSyncedMarkdownFiles();
			const matchingFile = files.find(f =>
				f.name === fileName || f.path.endsWith(cleanPath)
			);

			if (matchingFile) {
				await this.app.workspace.openLinkText(matchingFile.path, '', true);
			} else {
				new Notice(`노트를 찾지 못했습니다: ${path}`);
			}
		}
	}

	private renderCitationPreview(container: HTMLElement, citation: Citation) {
		const row = container.createDiv({ cls: 'gemini-chat-citation-row' });
		const file = this.resolveCitationFile(citation.sourcePath);
		const title = file?.basename || this.getCitationTitle(citation.sourcePath);

		row.createEl('div', { cls: 'gemini-chat-citation-title', text: title });

		const actions = row.createDiv({ cls: 'gemini-chat-citation-actions' });
			const openButton = actions.createEl('button', {
				cls: 'gemini-chat-citation-open',
				text: '노트 찾기'
			});
		openButton.addEventListener('click', () => this.openNote(citation.sourcePath));

		if (file) {
			this.attachCitationHover(row, file);
			row.addEventListener('click', (event) => {
				if ((event.target as HTMLElement).closest('button')) return;
				this.openNote(file.path);
			});
		}
	}

	private attachCitationHover(target: HTMLElement, file: TFile) {
		target.addEventListener('mouseenter', async () => {
			const preview = await this.buildNotePreview(file);
			this.showCitationPreview(target, file, preview);
		});
		target.addEventListener('mousemove', () => {
			if (this.citationPreviewEl) {
				this.positionCitationPreview(target, this.citationPreviewEl);
			}
		});
		target.addEventListener('mouseleave', () => this.hideCitationPreview());
	}

	private async buildNotePreview(file: TFile): Promise<string> {
		try {
			const content = await this.app.vault.read(file);
			const meaningfulLines = content
				.split('\n')
				.map(line => line
					.replace(/^#{1,6}\s*/, '')
					.replace(/^[-*]\s+/, '')
					.replace(/^\d+\.\s+/, '')
					.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
					.replace(/!\[[^\]]*]\([^)]*\)/g, '')
					.replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
					.replace(/[*_`>#]/g, '')
					.trim()
				)
				.filter(line => line.length > 0 && !/^---+$/.test(line))
				.slice(0, 6);
			const preview = meaningfulLines.join('\n');
			return preview.length > 700 ? `${preview.slice(0, 700)}...` : preview || '미리볼 수 있는 내용이 없습니다.';
		} catch {
			return '노트 내용을 불러오지 못했습니다.';
		}
	}

	private showCitationPreview(target: HTMLElement, file: TFile, preview: string) {
		this.hideCitationPreview();
		const previewEl = document.body.createDiv({ cls: 'gemini-chat-note-popover' });
		previewEl.createDiv({ cls: 'gemini-chat-note-popover-title', text: file.basename });
		previewEl.createDiv({ cls: 'gemini-chat-note-popover-path', text: file.path });
		previewEl.createDiv({ cls: 'gemini-chat-note-popover-body', text: preview });
		this.citationPreviewEl = previewEl;
		this.positionCitationPreview(target, previewEl);
	}

	private positionCitationPreview(target: HTMLElement, previewEl: HTMLElement) {
		const rect = target.getBoundingClientRect();
		const width = Math.min(360, Math.max(260, window.innerWidth - 32));
		previewEl.style.width = `${width}px`;
		const left = Math.min(Math.max(16, rect.left), window.innerWidth - width - 16);
		const below = rect.bottom + 10;
		const estimatedHeight = previewEl.offsetHeight || 180;
		const top = below + estimatedHeight < window.innerHeight
			? below
			: Math.max(16, rect.top - estimatedHeight - 10);
		previewEl.style.left = `${left}px`;
		previewEl.style.top = `${top}px`;
	}

	private hideCitationPreview() {
		this.citationPreviewEl?.remove();
		this.citationPreviewEl = null;
	}

	private resolveCitationFile(path: string): TFile | null {
		const candidates = this.getCitationPathCandidates(path);
		for (const candidate of candidates) {
			const file = this.app.vault.getAbstractFileByPath(candidate);
			if (file instanceof TFile && this.isSyncedCitationFile(file)) return file;
		}

		const normalizedCandidates = new Set(candidates.map(candidate => this.normalizeCitationPath(candidate)));
		return this.getSyncedMarkdownFiles().find(file => {
			const normalizedPath = this.normalizeCitationPath(file.path);
			const normalizedName = this.normalizeCitationPath(file.name);
			return normalizedCandidates.has(normalizedPath) ||
				normalizedCandidates.has(normalizedName) ||
				Array.from(normalizedCandidates).some(candidate =>
					normalizedPath.endsWith(candidate) || normalizedName === candidate
				);
		}) || null;
	}

	private getSyncedMarkdownFiles(): TFile[] {
		return this.plugin.getKnowledgeMarkdownFiles().filter(file => this.isSyncedCitationFile(file));
	}

	private isSyncedCitationFile(file: TFile): boolean {
		return file.extension === 'md' &&
			this.plugin.isInSyncFolder(file.path);
	}

	private getCitationPathCandidates(path: string): string[] {
		const cleaned = path
			.trim()
			.replace(/^\[\[/, '')
			.replace(/\]\]$/, '')
			.replace(/^["']|["']$/g, '')
			.split('|')[0]
			.trim();
		if (!cleaned) return [];
		const candidates = [cleaned];
		if (!cleaned.endsWith('.md')) candidates.push(`${cleaned}.md`);
		return Array.from(new Set(candidates));
	}

	private normalizeCitationPath(path: string): string {
		return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
	}

	private getCitationTitle(path: string): string {
		const cleaned = this.getCitationPathCandidates(path)[0] || path;
		return cleaned.split('/').pop()?.replace(/\.md$/i, '') || cleaned;
	}

	private clearChat() {
		this.startNewConversation();
	}

	private startNewConversation() {
		if (this.isLoading && this.loadingTab === this.activeTab) {
			new Notice('새 대화를 시작하려면 현재 실행을 먼저 중지하세요.');
			return;
		}

		if (this.activeTab !== 'agent') {
			return;
		}

		this.agentMessages = [];
		new Notice('새 에이전트 대화를 시작했습니다.');
		this.renderActiveTab();
	}

	// Render action buttons (Apply, Copy) for AI responses
	private renderActionButtons(msgEl: HTMLElement, message: ChatMessage) {
		const actionsEl = msgEl.createDiv({ cls: 'gemini-chat-actions' });

		// Apply button with dropdown
		const applyContainer = actionsEl.createDiv({ cls: 'gemini-chat-apply-container' });

			const applyBtn = applyContainer.createEl('button', {
				cls: 'gemini-chat-action-btn gemini-chat-apply-btn',
				text: '📝 반영'
			});

		// Dropdown arrow
		const dropdownArrow = applyContainer.createEl('button', {
			cls: 'gemini-chat-dropdown-arrow',
			text: '▼'
		});

		// Dropdown menu
		const dropdownMenu = applyContainer.createDiv({ cls: 'gemini-chat-dropdown-menu' });
		dropdownMenu.style.display = 'none';

			const menuItems = [
				{ text: '📍 커서 위치에 삽입', action: () => this.insertAtCursor(message.content, message.citations) },
				{ text: '📎 현재 노트 끝에 추가', action: () => this.appendToCurrentNote(message.content, message.citations) },
				{ text: '📄 새 노트 만들기', action: () => this.createNewNote(message) },
				{ text: '📂 노트 선택...', action: () => this.selectNoteToApply(message.content, message.citations) },
				{ text: `🧠 ${this.getWorkspaceSaveLabel()}에 저장`, action: () => this.saveToWorkspace(message) }
			];

		for (const item of menuItems) {
			const menuItem = dropdownMenu.createEl('div', {
				cls: 'gemini-chat-dropdown-item',
				text: item.text
			});
			menuItem.addEventListener('click', (e) => {
				e.stopPropagation();
				dropdownMenu.style.display = 'none';
				item.action();
			});
		}

		// Close dropdown when clicking outside
		const closeDropdown = (e: MouseEvent) => {
			if (!applyContainer.contains(e.target as Node)) {
				dropdownMenu.style.display = 'none';
				document.removeEventListener('click', closeDropdown);
			}
		};

		// Toggle dropdown on arrow click (single unified handler)
		dropdownArrow.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();

			const isCurrentlyVisible = dropdownMenu.style.display === 'block';

			if (isCurrentlyVisible) {
				// Close dropdown
				dropdownMenu.style.display = 'none';
				document.removeEventListener('click', closeDropdown);
			} else {
				// Open dropdown
				dropdownMenu.style.display = 'block';
				// Add outside click listener after a small delay
				setTimeout(() => {
					document.addEventListener('click', closeDropdown);
				}, 0);
			}
		});

		// Default apply action (Insert at Cursor)
		applyBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.insertAtCursor(message.content, message.citations);
		});

		// Copy button
			const copyBtn = actionsEl.createEl('button', {
				cls: 'gemini-chat-action-btn gemini-chat-copy-btn',
				text: '📋 복사'
			});

			copyBtn.addEventListener('click', async () => {
				await navigator.clipboard.writeText(message.content);
				copyBtn.textContent = '✓ 복사됨';
				setTimeout(() => {
					copyBtn.textContent = '📋 복사';
				}, 2000);
			});
	}

	// Format content with optional metadata
	private formatContentWithMetadata(content: string, citations?: Citation[]): string {
		if (!this.plugin.settings.includeMetadata) {
			return content;
		}

		const now = new Date();
		const dateStr = now.toLocaleDateString('ko-KR', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});

		const label = '에이전트 결과';
		let result = `\n\n---\n*🤖 ${label} (${dateStr})*\n\n${content}`;

		if (citations && citations.length > 0) {
			result += '\n\n**출처:**\n';
			for (const citation of citations) {
				result += `- [[${citation.sourcePath}]]\n`;
			}
		}

		result += '\n---\n';
		return result;
	}

	private getWorkspaceSaveLabel(): string {
		return this.activeTab === 'agent'
			? this.plugin.settings.agentOutputFolder
			: `${this.plugin.settings.workspaceFolder}/compiled`;
	}

	private async saveToWorkspace(message: ChatMessage) {
		const folder = this.activeTab === 'agent'
			? await this.plugin.ensureVaultFolder(this.plugin.settings.agentOutputFolder)
			: await this.plugin.ensureWorkspaceFolder('compiled');
		const now = new Date();
		const dateStr = now.toISOString().slice(0, 10);
		const timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
		const fileName = `${folder}/지식 마스터 ${dateStr} ${timeStr}.md`;
		const formattedContent = this.formatContentWithMetadata(message.content, message.citations);
		try {
			const file = await this.app.vault.create(fileName, formattedContent);
			message.savedNotePath = file.path;
			await this.app.workspace.openLinkText(file.path, '', true);
			new Notice(`✅ 저장했습니다: ${file.path}`);
			this.renderActiveTab();
		} catch (error) {
			new Notice('작업공간 노트를 저장하지 못했습니다.');
			console.error('작업공간 저장 오류:', error);
		}
	}

	// Insert at cursor position in active editor
	private async insertAtCursor(content: string, citations?: Citation[]) {
		const activeView = this.app.workspace.getActiveViewOfType(ItemView);

		// Get the active markdown editor
		const markdownView = this.app.workspace.getActiveFile();
		if (!markdownView) {
			new Notice('활성 노트가 없습니다. 먼저 노트를 열어 주세요.');
			return;
		}

		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) {
			new Notice('활성 편집기를 찾지 못했습니다.');
			return;
		}

		// @ts-ignore - accessing editor from view
		const editor = leaf.view?.editor;
		if (!editor) {
			new Notice('편집기를 찾지 못했습니다. 노트를 편집 모드로 열어 주세요.');
			return;
		}

		const formattedContent = this.formatContentWithMetadata(content, citations);
		editor.replaceSelection(formattedContent);
		new Notice('✅ 커서 위치에 내용을 삽입했습니다.');
	}

	// Append to current note
	private async appendToCurrentNote(content: string, citations?: Citation[]) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('활성 노트가 없습니다. 먼저 노트를 열어 주세요.');
			return;
		}

		const formattedContent = this.formatContentWithMetadata(content, citations);
		await this.app.vault.append(activeFile, formattedContent);
		new Notice(`✅ ${activeFile.name}에 내용을 추가했습니다.`);
	}

	// Create new note with content
	private async createNewNote(message: ChatMessage) {
		const now = new Date();
		const dateStr = now.toISOString().slice(0, 10);
		const timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
		const folder = this.activeTab === 'agent'
			? await this.plugin.ensureVaultFolder(this.plugin.settings.agentOutputFolder)
			: '';
		const baseName = '에이전트 결과';
		const fileName = folder
			? `${folder}/${baseName} ${dateStr} ${timeStr}.md`
			: `${baseName} ${dateStr} ${timeStr}.md`;

		const formattedContent = this.formatContentWithMetadata(message.content, message.citations);

		try {
			const newFile = await this.app.vault.create(fileName, formattedContent);
			message.savedNotePath = newFile.path;
			await this.app.workspace.openLinkText(newFile.path, '', true);
			new Notice(`✅ 새 노트를 만들었습니다: ${newFile.path}`);
			this.renderActiveTab();
		} catch (error) {
			new Notice('노트를 만들지 못했습니다. 다시 시도해 주세요.');
			console.error('노트 생성 오류:', error);
		}
	}

	// Open note selector modal
	private selectNoteToApply(content: string, citations?: Citation[]) {
		const modal = new NoteSelectorModal(this.app, async (file: TFile) => {
			const formattedContent = this.formatContentWithMetadata(content, citations);
			await this.app.vault.append(file, formattedContent);
			new Notice(`✅ ${file.name}에 내용을 추가했습니다.`);
		});
		modal.open();
	}

	private scrollToBottom() {
		setTimeout(() => {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}, 50);
	}
}
