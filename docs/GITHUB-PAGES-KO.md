# GitHub Pages 배포 방법

GitHub 사용 경험이 많지 않아도 따라 할 수 있도록 순서대로 적었습니다.

## 배포 정보 (이미 완료됨)

- 저장소: `github.com/jennie-verse/tide` (Public)
- 배포 주소: `https://jennie-verse.github.io/tide/`
- 배포 방식: GitHub Actions (Pages) — `main` 브랜치에 올라간 그대로 배포됩니다

## 폴더 안의 파일을 다시 배포하고 싶을 때

1. 이 폴더(`tide/`) 전체를 `github.com/jennie-verse/tide` 저장소에 업로드(commit + push)합니다.
   - 폴더 구조를 그대로 유지하세요. 압축을 풀었을 때 `tide/tide/` 처럼 폴더가 한 겹 더 생기면 안 됩니다.
   - 저장소 최상위에 `index.html`이 바로 보여야 합니다.
2. 저장소(Repository) → 설정(Settings) → Pages 메뉴로 이동합니다.
3. Source를 **GitHub Actions** 또는 **Deploy from a branch: main / (root)** 로 지정합니다.
4. 몇 분 뒤 `https://jennie-verse.github.io/tide/` 접속해 화면이 뜨는지 확인합니다.

## 새 버전을 올릴 때 꼭 확인할 것

- `app.js`나 `app.css`를 고쳤다면 `sw.js`의 `CACHE` 이름(`tide-v1` → `tide-v2` 등)을 반드시 함께 올립니다. 그래야 이미 홈 화면에 설치된 기기에서도 새 버전이 적용됩니다.
- `shared/v1/` 폴더는 여러 앱이 함께 쓰는 고정 규칙이 있는 폴더입니다. **이 폴더는 절대 수정하지 마세요.**

## iPhone / iPad에서 확인하기

1. Safari에서 `https://jennie-verse.github.io/tide/` 접속
2. 공유(Share) → 홈 화면에 추가(Add to Home Screen)
3. 홈 화면 아이콘으로 실행해 정상 동작 확인

## iOS 단축어 주소 갱신

기존에 `clip` 앱의 단축어를 쓰고 계셨다면, 단축어 앱에서 주소를 아래와 같이 바꿔주세요.

```
이전: https://jennie-verse.github.io/clip/?add=
이후: https://jennie-verse.github.io/tide/?add=
```

설정(Settings) → Shortcut → **How to make one**에서도 같은 안내를 볼 수 있습니다.

## 기기 간 동기화 토큰

Settings → Sync에서 GitHub Personal Access Token을 입력해야 동기화가 켜집니다. clip에서 쓰던 토큰과 **같은 토큰**을 그대로 쓸 수 있습니다(저장소 `webapp-data`에 대한 접근 권한만 있으면 됩니다). 새로 발급해야 한다면 GitHub → Settings → Developer settings → Personal access tokens에서 `webapp-data` 저장소에 대한 Contents 읽기·쓰기 권한으로 만드세요.

## clip에서 tide로 넘어가기

1. 위 방법대로 tide 배포 주소가 실제로 열리는 것을 확인합니다.
2. 문제없이 며칠 써 보신 뒤, 기존 `Published/clip/` 폴더를 `Deprecated/clip/`으로 옮깁니다.
3. GitHub의 `clip` 저장소는 그대로 두거나 Archive 처리하면 됩니다. 삭제할 필요는 없습니다.
