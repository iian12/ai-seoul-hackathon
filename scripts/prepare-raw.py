"""Offline full-source archive + lossless row batches for Supabase. No network calls."""
import argparse
import gzip
import hashlib
import json
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
PART_BYTES = 40 * 1024 * 1024


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def scan(stream, secrets, label):
    tail = b''
    overlap = max(map(len, secrets), default=1) - 1
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        body = tail + chunk
        if any(secret in body for secret in secrets):
            raise ValueError(f'secret_detected: {label}')
        tail = body[-overlap:] if overlap else b''


def secrets_from_env():
    values = []
    p = ROOT / '.env.server.local'
    if p.exists():
        for line in p.read_text().splitlines():
            if line.strip().startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            value = value.strip().strip('"\'')
            if ('KEY' in key or 'TOKEN' in key or 'PASSWORD' in key) and len(value) > 8:
                values.extend([value.encode(), quote(value, safe='').encode()])
    return list(set(values))


def source_files():
    included, excluded = [], []
    for p in sorted((ROOT / 'data').rglob('*')):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT).as_posix()
        if 'venv' in p.parts or '__pycache__' in p.parts or p.name.startswith('rentals-build.sqlite') or p.name == 'demo-snapshot.json' or p.suffix == '.tmp':
            excluded.append({'path': rel, 'reason': 'generated_database_runtime_demo_or_temporary'})
            continue
        if p.is_symlink():
            raise ValueError(f'symlink_not_allowed: {rel}')
        included.append(p)
    return included, excluded


def write_rows(folder, source_id, expected, out):
    """Preserve every field and every row, including invalid/unused records."""
    files = sorted(folder.glob('*.json.gz'))
    count, raw_bytes, chunks, pending = 0, 0, [], []
    digest = hashlib.sha256()

    def flush():
        name = f'rows/{source_id}/{len(chunks) + 1:06d}.jsonl.gz'
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('wb') as raw:
            with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as f:
                f.writelines(pending)
        chunks.append({'path': name, 'rows': len(pending), 'bytes': path.stat().st_size, 'sha256': sha(path)})
        pending.clear()

    for file in files:
        with gzip.open(file, 'rt') as f:
            data = json.load(f)
        rows = data if isinstance(data, list) else data.get('rows')
        if not isinstance(rows, list):
            raise ValueError(f'invalid_rows: {source_id}/{file.name}')
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError(f'invalid_record: {source_id}')
            line = (json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
            digest.update(line)
            raw_bytes += len(line)
            count += 1
            pending.append(line)
            if len(pending) == 5000:
                flush()
    if pending:
        flush()
    if count != expected:
        raise ValueError(f'row_count_mismatch: {source_id}: {count} != {expected}')
    return {'id': source_id, 'expectedRows': expected, 'rows': count, 'jsonlBytes': raw_bytes, 'recordsSha256': digest.hexdigest(), 'chunks': chunks}


def prepare(output):
    if output.exists():
        raise ValueError('output_exists: choose a new --output directory; existing packages are immutable')
    files, excluded = source_files()
    report = json.loads((ROOT / 'data/full-seoul/report.json').read_text())
    auxiliary = json.loads((ROOT / 'data/full-seoul/aux-report.json').read_text())
    if any(s['status'] != 'complete' for s in report['sources'].values()) or auxiliary['tdataSubway']['status'] != 'complete':
        raise ValueError('collection_incomplete')
    secrets = secrets_from_env()
    inventory = []
    # Inspect both stored bytes and compressed contents before producing uploadable archives.
    for p in files:
        rel = p.relative_to(ROOT).as_posix()
        with p.open('rb') as f:
            scan(f, secrets, rel)
        if p.suffix == '.gz':
            with gzip.open(p, 'rb') as f:
                scan(f, secrets, rel)
        elif p.suffix == '.zip':
            with zipfile.ZipFile(p) as z:
                for member in z.infolist():
                    if not member.is_dir():
                        with z.open(member) as f:
                            scan(f, secrets, rel)
        inventory.append({'path': rel, 'bytes': p.stat().st_size, 'sha256': sha(p)})
    print(f'Secret scan passed; {len(files)} source/supporting files', flush=True)
    output.mkdir(parents=True)
    sources = []
    for source_id, state in report['sources'].items():
        s = write_rows(ROOT / 'data/full-seoul' / source_id, source_id, int(state['expected']), output)
        sources.append(s)
        print(f'{source_id}: {s["rows"]:,} rows / {s["jsonlBytes"]:,} JSONL bytes', flush=True)
    sources.append(write_rows(ROOT / 'data/full-seoul/tdata-subway', 'tdata-subway', int(auxiliary['tdataSubway']['rows']), output))
    archive = output / 'source-files.tar.gz.tmp'
    with archive.open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w|') as tar:
                for p, record in zip(files, inventory):
                    # Refuse changed source inputs rather than archive a mixed collection.
                    if sha(p) != record['sha256']:
                        raise ValueError(f'input_changed: {record["path"]}')
                    info = tar.gettarinfo(str(p), arcname=record['path'])
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ''
                    with p.open('rb') as f:
                        tar.addfile(info, f)
    parts = []
    with archive.open('rb') as f:
        while True:
            chunk = f.read(PART_BYTES)
            if not chunk:
                break
            name = f'archive/source-files.tar.gz.part-{len(parts) + 1:04d}'
            target = output / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(chunk)
            parts.append({'path': name, 'bytes': len(chunk), 'sha256': hashlib.sha256(chunk).hexdigest()})
    archive.unlink()
    content = {'format': 'housing-raw-1', 'scope': 'All currently collected API rows, source files and supporting artifacts; rental receipt years 2024-2026; not all historical Seoul data', 'files': inventory, 'excluded': excluded, 'sources': sources, 'archiveParts': parts, 'stats': {'sourceFiles': len(inventory), 'sourceBytes': sum(r['bytes'] for r in inventory), 'archiveBytes': sum(r['bytes'] for r in parts), 'rows': sum(s['rows'] for s in sources), 'jsonlBytes': sum(s['jsonlBytes'] for s in sources)}}
    collection_id = hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    manifest = {**content, 'id': collection_id, 'createdAt': datetime.now(timezone.utc).isoformat()}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'id': collection_id, **content['stats'], 'archiveParts': len(parts), 'output': str(output)}, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='data-export/raw-v1')
    args = parser.parse_args()
    prepare((ROOT / args.output).resolve())
