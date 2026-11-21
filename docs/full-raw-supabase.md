# Supabase 원천 전체 적재 준비

현재 상태: 로컬 패키지 생성·전체 복원 검증·DB 함수 테스트 완료. Supabase 프로젝트와 키가 없어 원격 DB/Storage 생성·업로드는 하지 않았습니다.

## 대상과 실제 크기

- 수집 완료 API 12종, 2,778,197개 원천 레코드. 이 중 전월세 2,701,942건은 접수연도 2024~2026 전체입니다. 전세/잘못된 값/경계 매핑 실패 등도 원천 테이블에서는 제외하지 않습니다.
- 원천·참고 파일 2,960개, 420,284,382바이트. 수집 JSON 캐시, bulk JSON/ZIP, OSM PBF, 경계, 코드북과 수집 보고서 등을 포함합니다. 진단용 부분 수집/중복 약국 페이지도 아카이브에는 보관하되 검증된 API 레코드에 중복 합산하지 않습니다.
- 아카이브 221,463,527바이트를 최대 40MiB짜리 6개 파일로 분할했습니다. 빈 파일이나 행 절단 없이 바이트를 이어 붙이면 원본 tar.gz가 복원됩니다.
- API 레코드 JSONL은 1,181,108,516바이트입니다. 로컬 PostgreSQL JSONB 5,825개 표본의 행·인덱스 비용 추정은 약 1.62GB입니다. 실제 호스팅 DB 사용량과 같다고 단정하지 않으며 [표본 결과](raw-db-size-estimate.json)를 참고하세요.
- 무료 Storage 1GB에는 현재 아카이브가 들어갑니다. 모든 행을 JSONB DB에 적재하는 구성은 무료 DB 500MB를 넘을 것으로 예상합니다. 요금제를 자동 변경하거나 유료 프로젝트를 생성하지 않았습니다. [공식 한도](https://supabase.com/pricing)
- 설치 환경(venv), 파생 SQLite, 데모, 임시 파일은 제외하고 manifest에 제외 이유를 남깁니다. 원본 PBF와 경계 파일은 Storage에서 보존하며, OSM의 모든 노드/도로를 DB 행으로 펼치는 작업은 아닙니다. API 캐시는 수집 시 파싱한 행을 보존한 것으로 모든 원래 HTTP 응답 헤더/바이트가 저장됐다는 뜻은 아닙니다.

## 저장 구조

- Storage의 비공개 `housing-raw` 버킷: `<collection-id>/archive/...`, `<collection-id>/manifest.json`.
- `housing_raw_collections`: 원천 파일 SHA256/크기와 레코드 목록 manifest, 아카이브 검증 및 전체 적재 상태.
- `housing_raw_sources`: 원천별 기대/적재 건수와 JSONL 전체 해시.
- `housing_raw_records`: 각 원천의 모든 레코드를 `payload jsonb`로 저장. 원천별 행 번호를 기본키로 사용하며 원천 자체의 중복도 지우지 않습니다.
- `housing_raw_batches`: 원천별 500행 단위의 원자적 적재/재시도 기록.
- 원천은 비공개 RLS·service_role 전용이며 공개 스냅샷 테이블의 익명 읽기와 분리합니다. 숫자는 JS로 다시 직렬화하지 않고 JSON 텍스트로 전달해 큰 정수의 반올림을 방지합니다.
- 최신 집계 스냅샷은 기존 `housing_snapshots`로 별도 적재합니다. 이 명령은 React의 조회 방식을 원천 전체 다운로드로 바꾸지 않습니다. 원천에서 클라우드 집계를 자동 재실행하는 배치는 아직 없습니다.

## 준비와 검증

프로젝트 폴더에서 실행합니다. 기존 패키지는 덮어쓰지 않습니다. 새 수집 버전은 다른 출력 폴더로 만드세요.

```sh
npm run raw:prepare
npm run raw:verify
npm run raw:import                 # 기본은 dry-run, 원격 쓰기 없음
npm run raw:test                   # 로컬 PostgreSQL 함수/RLS/재시도 테스트
node scripts/estimate-raw-db.mjs    # 로컬 표본 추정
```

생성 위치는 `data-export/raw-v1/manifest.json`, `archive/`, `rows/`입니다. Git에는 포함하지 않습니다. 원본 키는 압축 해제한 gzip/zip 내용까지 검사한 뒤 업로드용 파일을 만듭니다. 개별 아카이브 조각과 모든 원천 파일, 전체 API 레코드 스트림을 해시/건수로 검증했습니다.

## 프로젝트 생성 후

1. 새 프로젝트 SQL Editor에서 `supabase/migrations/`의 4개 파일을 파일명 순으로 실행합니다. 마지막 `202611160003_full_raw.sql`이 원천 전용 테이블/RPC/비공개 버킷을 생성합니다. 기존 테이블이 있는 프로젝트에서는 적용하지 않은 migration만 실행합니다.
2. 기존 `.env.server.local`에 `SUPABASE_URL`과 `SUPABASE_SECRET_KEY`를 추가합니다. `VITE_` 변수나 채팅에 비밀키를 넣을 필요가 없습니다.
3. 아래 명령으로 아카이브와 모든 API 레코드를 적재합니다.

```sh
npm run raw:import -- --upload
# 다른 패키지: npm run raw:import -- data-export/raw-v2 --upload
# 집계 스냅샷 별도 적재
npm run snapshot:import -- public/data/seoul-snapshot.json
```

원본 아카이브는 업로드 후 다운로드 SHA256까지 확인합니다. DB는 순차 배치로 전달하고 PostgreSQL에서도 SHA256을 계산합니다. 응답 유실 후 재시도는 동일 배치를 중복 생성하지 않습니다. 마지막 정상 배치 뒤에서 이어가며 기대 건수와 실제 테이블 건수가 일치해야 완료됩니다. 불완전한 수집을 정상 완료로 표시하거나 기존 정상 컬렉션을 삭제하지 않습니다. 원격 API 오류 본문은 출력하지 않습니다.

아카이브 복원은 파일 번호순으로 `source-files.tar.gz.part-*`를 합쳐 tar.gz로 만든 뒤 manifest의 개별 파일 해시를 확인하면 됩니다. `raw:verify`가 디스크 추출 없이 이 복원 검증을 수행합니다.

## 적재 후 SQL 확인

```sql
select source_id, expected_rows, loaded_rows, state
from public.housing_raw_sources
order by source_id;

select r.row_no, r.payload
from public.housing_raw_records r
join public.housing_raw_sources s on s.id = r.source_id
where s.source_id = 'tbLnOpendataRentV'
order by s.id desc, r.row_no
limit 10;

select pg_size_pretty(pg_total_relation_size('public.housing_raw_records'));
```

검증 기록: [원천 준비 요약](raw-preparation-report.json). 실제 원격 업로드/프로젝트별 Storage 정책과 성능은 프로젝트 생성 후 검증해야 합니다.
