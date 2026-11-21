"""Build verified district rates from official 2025 police CSV and Seoul population workbook."""
import csv,json,zipfile,hashlib,xml.etree.ElementTree as E
from datetime import datetime, timezone
from pathlib import Path
base=Path('data/crime'); ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
z=zipfile.ZipFile(base/'population-2025.xlsx')
ss=[''.join(t.itertext()) for t in E.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',ns)]
rows=[]
for row in E.fromstring(z.read('xl/worksheets/sheet2.xml')).findall('.//m:row',ns):
 d={}
 for c in row:
  v=c.find('m:v',ns)
  if v is not None:d[''.join(x for x in c.get('r') if x.isalpha())]=ss[int(v.text)] if c.get('t')=='s' else v.text
 if 8 <= int(row.get('r')) <= 36: rows.append(d)
assert any('2025. 12. 31.' in s for s in ss)
pop={d['C']:int(d['I']) for d in rows if d.get('C','').endswith('구') and d.get('I','').isdigit()}
assert len(pop)==25 and sum(pop.values())==9299548
crime=list(csv.DictReader((base/'crime.csv').read_text(encoding='cp949').splitlines()))
assert len({(r['범죄대분류'],r['범죄중분류']) for r in crime})==len(crime)==38
out=[]
for district,population in pop.items():
 values=[int(r['서울 '+district].replace(',','')) for r in crime]
 assert all(v>=0 for v in values)
 cases=sum(values);out.append(dict(district=district,year=2025,cases=cases,population=population,per100k=cases/population*100000))
result={'year':2025,'retrievedAt':datetime.fromtimestamp(max((base/f).stat().st_mtime for f in ['crime.csv','population-2025.xlsx']),timezone.utc).isoformat(),'populationDate':'2025-12-31','definition':'전체 범죄 (교통범죄 등 포함), 주민등록인구(내국인) 10만 명당 발생 건수','crimeSource':'https://www.data.go.kr/data/3074462/fileData.do','populationSource':'https://data.seoul.go.kr/together/statbook/statbookList.do','populationSheet':'1. 등록인구총괄 · C8:C36 / I8:I36','hashes':{f:hashlib.sha256((base/f).read_bytes()).hexdigest() for f in ['crime.csv','population-2025.xlsx']},'districts':out}
Path('src/data/district-crime-2025.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print('25개 구 검증 완료; 인구 합계',sum(pop.values()),'; 범죄 합계',sum(r['cases'] for r in out))
