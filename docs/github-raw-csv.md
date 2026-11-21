# 전체 원천 레코드의 GitHub CSV 보관 가능 여부

확인일: 2026-11-16. GitHub에 실제 업로드하거나 새 저장소/릴리스를 만들지 않았습니다.

API 12종의 2,778,197개 레코드를 원천별 컬럼 합집합으로 UTF-8/LF 일반 CSV 직렬화하는 크기를 전량 계산했습니다. 파일을 생성하지 않고 같은 CSV writer의 출력 바이트를 모두 셌습니다. 합계 401,531,213바이트(약 402MB), 전월세만 381,411,606바이트입니다. [전량 측정 결과](raw-csv-size-check.json).

| 방식 | 가능 여부와 조건 |
|---|---|
| 일반 Git의 CSV 파일 | 가능. 전월세는 연도·자치구 또는 파일당 40MiB 이하로 분할해야 함. GitHub는 50MiB 초과 경고, 100MiB 초과 차단. 웹 직접 업로드는 25MiB 제한 |
| Git LFS | 가능. GitHub Free 파일당 2GB, 포함 Storage 10GiB·월 다운로드 10GiB. 현재 계정의 기존 사용량은 확인하지 않음. 파일을 수정하면 변경분이 아니라 전체 새 버전 크기가 누적됨 |
| Releases의 CSV/CSV.gz 첨부 | 가능. 원천의 정기 스냅샷 배포에 적합하며 코드 Git 히스토리에 큰 파일을 넣지 않을 수 있음 |

일반 Git에서는 원천별 CSV를 나누고 전월세는 40MiB 이하로 더 분할하는 방식이 현재 용량에 맞습니다. 전체 스냅샷을 자주 갱신한다면 Releases의 CSV.gz와 Git의 스키마·건수·SHA256 manifest를 함께 관리하는 쪽이 관리하기 쉽습니다. 저장소 권장 크기는 이상적으로 1GB 미만, 강하게 권장하는 상한은 5GB 미만입니다. 실제 Git 압축 크기와 변경 이력에 따라 달라집니다.

이번 측정은 일반 CSV 규칙으로 null을 빈 문자열로 썼으므로 무손실 CSV 내보내기 규격을 확정한 것은 아닙니다. 실제 배포 전 원천별 컬럼 타입, 코드의 앞자리 0, null·빈 문자열·필드 없음 구별과 특수문자 인용 규칙을 정의하고 행 수/해시 및 JSONL과의 왕복 검증을 해야 합니다. OSM PBF·ZIP·코드북 같은 비정형 원천은 CSV로 억지 변환하지 않고 원래 파일도 보존해야 합니다. 현재 Supabase용 원천 패키지는 원본 파일과 JSON 필드를 그대로 보존합니다.

GitHub는 파일 보관·버전 관리·다운로드 수단입니다. CSV를 올리는 것만으로 DB의 SQL 조회/조건 검색 API가 생기는 것은 아닙니다. 전체 CSV를 React 브라우저에 매번 내려받게 하는 변경은 하지 않았습니다.

공식 근거:
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage
- https://docs.github.com/en/billing/concepts/product-billing/git-lfs
