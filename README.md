# KineTutor

KineTutor는 비디오 기반 각도, 거리, 마커 움직임을 교육적으로 학습하기 위한 웹 운동학 분석 MVP입니다. 현재 구현은 의존성 없는 정적 웹앱이며, 다음 단계에서 백엔드 FFmpeg 변환, AI pose import, 마커 트래킹 엔진을 붙일 수 있도록 데이터 모델을 먼저 고정했습니다.

## 실행

브라우저에서 `index.html`을 열거나 정적 서버로 실행합니다.

```powershell
python -m http.server 5173
```

그 다음 `http://localhost:5173`으로 접속합니다.

## 현재 기능

- 여러 영상 업로드
- 1/2/4분할 스타일 플레이어
- 공통 `analysisTime` 기반 싱크 재생
- 플레이어별 `sourceIn`, `sourceOut`, `syncOffset`, `fps` 설정
- 프레임 단위 이동
- 마커, 거리, 3마커 각도 annotation
- 프로젝트 JSON export
- annotation CSV export

## 설계 원칙

원본 영상을 직접 자르지 않고 비파괴 trim으로 관리합니다.

```text
sourceTime = analysisTime + sourceIn + syncOffset
```

모든 측정값은 `analysisTime` 기준으로 저장하고, 각 플레이어의 실제 원본 시간은 `sourceTime`으로 함께 저장합니다. 이 구조를 유지해야 이후 AI pose 결과, 수동 마커, 자동 트래킹 결과를 같은 타임라인에서 합칠 수 있습니다.

마커 좌표는 캔버스 좌표가 아니라 실제 영상 프레임 기준 정규화 좌표입니다. 영상이 letterbox 형태로 표시되어도 검은 여백이 좌표계에 섞이지 않습니다.

## 다음 확장 지점

- `tracks`: 같은 마커의 시간축 좌표 시퀀스 저장
- `annotations`: 단일 프레임 마커/거리/각도 저장
- `calibration`: 픽셀-실측 단위 변환 저장
- 백엔드: 업로드 원본을 constant frame rate proxy MP4로 변환
- AI pose: 외부 서비스 결과를 `analysisTime` 기준 joint track으로 import
- 마커 트래킹: 초기 ROI 지정 후 frame-by-frame 좌표를 `tracks.samples`에 저장
