export interface ChatMessage {
	role: 'user' | 'model';
	content: string;
	citations?: Citation[];
	isStreaming?: boolean;
	logPath?: string;
	savedNotePath?: string;
}

export interface Citation {
	sourceId: string;
	sourcePath: string;
	content: string;
}
