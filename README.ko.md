# 지식 마스터 AGY

Antigravity CLI OAuth 기반 에이전트 작업에 집중한 Obsidian 플러그인 fork입니다.

이 fork는 Google Gemini API key 설정, File Search 업로드/동기화, API key 기반 채팅을 비활성화합니다. 대신 로컬 `agy` CLI의 구독형 OAuth 세션과 로컬 vault 문맥 폴더를 사용합니다.

## 이 Fork의 동작

- Obsidian 안에서 에이전트 중심 대시보드를 엽니다.
- 에이전트 탭에서 Antigravity/AGY를 실행하고 현재 vault 경로를 `--add-dir`로 전달합니다.
- 선택한 로컬 문맥 폴더에서 관련 노트 발췌를 에이전트 프롬프트에 넣습니다.
- 생성 노트, 관계도 산출물, 로그를 `_omg` 아래에 보관합니다.
- 반영, 복사, 새 노트 만들기, 노트 선택, `_omg` 저장 액션을 지원합니다.
- 선택한 문맥 폴더의 위키링크와 태그를 기반으로 로컬 관계도를 생성하고, D3 기반 화면에서 탐색합니다.
- 화면 버튼, 설명, 에이전트 기본 응답 지시는 한국어 중심으로 구성되어 있습니다.

## 비활성화된 기능

- Google Gemini API key 입력/검증.
- Gemini File Search 업로드/sync.
- API key 기반 Chat 탭.
- Gemini API 예산 추적.

기존 플러그인 데이터와의 호환성을 위해 Gemini 관련 설정 필드는 남아 있지만, 이 fork는 로딩 시 `apiKey`를 비우고 에이전트 전용 경로에서 Google API를 호출하지 않습니다.

## 설치

### BRAT 설치

1. Obsidian에서 BRAT 플러그인을 엽니다.
2. `Add Beta Plugin`에 `https://github.com/flytothesky23/omg-search`를 입력합니다.
3. 설치 후 Obsidian을 다시 시작합니다.
4. 커뮤니티 플러그인 목록에서 `지식 마스터 AGY`를 활성화합니다.

### 직접 설치

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

3. Obsidian 커뮤니티 플러그인 설정에서 `지식 마스터 AGY`를 활성화합니다.

## 설정

1. Antigravity CLI를 설치하고 터미널에서 `agy` 로그인이 완료된 상태로 만듭니다.
2. Obsidian 설정 > 지식 마스터 AGY를 엽니다.
3. `Antigravity CLI 경로`를 설정합니다.
   - 먼저 `자동 찾기`를 시도합니다.
   - Obsidian이 `agy`를 찾지 못하면 `/opt/homebrew/bin/agy` 또는 `/Users/you/.local/bin/agy`처럼 전체 경로를 입력합니다.
4. `문맥 폴더`를 선택합니다.
   - 이 폴더의 노트는 로컬에 남습니다.
   - 관련 발췌만 에이전트 프롬프트에 포함됩니다.
5. 대시보드를 열고 에이전트 탭에서 작업을 실행합니다.

## 주요 기능

- 에이전트 대화: vault 문맥과 현재 노트를 바탕으로 조사, 요약, 비교, 초안 작성, 노트 생성 요청을 실행합니다.
- 문맥 폴더: 특정 폴더만 에이전트 근거로 선택해 원본 노트 범위를 제한합니다.
- 노트 반영: 응답을 커서 위치에 삽입하거나 현재 노트 끝에 추가하거나 새 노트로 저장합니다.
- 작업공간: `_omg/agent`, `_omg/graph`, `_omg/logs` 등에 생성 결과와 로그를 분리 보관합니다.
- 지식 관계도: 선택한 문맥 노트의 위키링크와 태그를 분석해 JSON, Canvas, Markdown 보고서를 만들고, D3 기반 관계도 화면에서 노드 유형 색상, 곡선 연결선, 드래그, 확대/축소, 상세 패널로 탐색합니다.
- 웹 검색 토글: 필요할 때만 웹 검색을 켜서 최신 외부 정보를 사용할 수 있습니다.
- 한국어 전용 UI: 버튼, 설명, 기본 에이전트 지시를 한국어 중심으로 제공합니다.

## 주의사항

- 플러그인은 노트를 Gemini File Search로 업로드하지 않습니다.
- Antigravity CLI 자체의 OAuth/구독 세션은 미리 설정되어 있어야 합니다.
- Obsidian을 Finder 또는 Dock에서 열면 shell PATH를 물려받지 못할 수 있습니다. 자동 찾기가 실패하면 CLI 전체 경로를 지정하세요.
- 에이전트 실행 로그는 `_omg/logs`에 저장됩니다.
- 에이전트 생성 노트의 기본 저장 위치는 `_omg/agent`입니다.

## 개발

```bash
npm install
npm run dev
npm run build
```

## 라이선스

MIT

## 출처

[`reallygood83/omg-search`](https://github.com/reallygood83/omg-search)에서 fork했습니다.
