# Master of Knowledge AGY

Antigravity CLI OAuth 기반 Agent 워크플로우에 집중한 Obsidian 플러그인 fork입니다.

이 fork는 Google Gemini API key 설정, File Search 업로드/sync, API key 기반 Chat을 비활성화합니다. 대신 로컬 `agy` CLI의 구독형 OAuth 세션과 로컬 vault context 폴더를 사용합니다.

## 이 Fork의 동작

- Obsidian 안에서 Agent-first dashboard를 엽니다.
- Agent 탭에서 Antigravity/AGY를 실행하고 현재 vault 경로를 `--add-dir`로 전달합니다.
- 선택한 로컬 context 폴더에서 관련 노트 발췌를 Agent 프롬프트에 넣습니다.
- 생성 노트, graph artifact, log를 `_omg` 아래에 보관합니다.
- Apply, Copy, Create Note, Select Note, Save to `_omg` 액션을 지원합니다.
- 선택한 context 폴더의 wikilink와 tag를 기반으로 로컬 graph를 생성합니다.

## 비활성화된 기능

- Google Gemini API key 입력/검증.
- Gemini File Search 업로드/sync.
- API key 기반 Chat 탭.
- Gemini API 예산 추적.

기존 플러그인 데이터와의 호환성을 위해 Gemini 관련 설정 필드는 남아 있지만, 이 fork는 로딩 시 `apiKey`를 비우고 Agent-only 경로에서 Google API를 호출하지 않습니다.

## 설치

1. 이 repository를 vault의 플러그인 폴더에 clone합니다.

```bash
cd /path/to/your/vault/.obsidian/plugins
git clone https://github.com/flytothesky23/omg-search.git master-of-knowledge-agy
cd master-of-knowledge-agy
```

2. 플러그인을 빌드합니다.

```bash
npm install
npm run build
```

3. Obsidian Community Plugins 설정에서 `Master of Knowledge AGY`를 활성화합니다.

## 설정

1. Antigravity CLI를 설치하고 터미널에서 `agy` 로그인이 완료된 상태로 만듭니다.
2. Obsidian Settings > Master of Knowledge AGY를 엽니다.
3. `Antigravity CLI Path`를 설정합니다.
   - 먼저 `Auto-detect`를 시도합니다.
   - Obsidian이 `agy`를 찾지 못하면 `/Users/you/.local/bin/agy`처럼 전체 경로를 입력합니다.
4. `Context Folders`를 선택합니다.
   - 이 폴더의 노트는 로컬에 남습니다.
   - 관련 발췌만 Agent 프롬프트에 포함됩니다.
5. dashboard를 열고 Agent 탭에서 작업을 실행합니다.

## 주의사항

- 플러그인은 노트를 Gemini File Search로 업로드하지 않습니다.
- Antigravity CLI 자체의 OAuth/구독 세션은 미리 설정되어 있어야 합니다.
- Obsidian을 Finder 또는 Dock에서 열면 shell PATH를 물려받지 못할 수 있습니다. Auto-detect가 실패하면 CLI 전체 경로를 지정하세요.
- Agent 실행 로그는 `_omg/logs`에 저장됩니다.
- Agent 생성 노트의 기본 저장 위치는 `_omg/agent`입니다.

## 개발

```bash
npm install
npm run dev
npm run build
```

## 라이선스

MIT

## Credits

[`reallygood83/omg-search`](https://github.com/reallygood83/omg-search)에서 fork했습니다.
