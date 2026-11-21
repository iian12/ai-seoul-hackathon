"""Verify every archive byte, original file and complete canonical record stream."""
import argparse
import gzip
import hashlib
import json
import shutil
import tarfile
from pathlib import Path
from prepare_raw_helpers import checked_path, manifest_id


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def verify(root):
    m = json.loads((root / 'manifest.json').read_text())
    if m['id'] != manifest_id(m):
        raise ValueError('manifest_id_mismatch')
    combined = root / 'verify-combined.tar.gz.tmp'
    try:
        with combined.open('wb') as out:
            for part in m['archiveParts']:
                p = checked_path(root, part['path'])
                if p.stat().st_size != part['bytes'] or digest(p) != part['sha256']:
                    raise ValueError('archive_part_mismatch')
                with p.open('rb') as f:
                    shutil.copyfileobj(f, out)
        expected = {x['path']: x for x in m['files']}
        seen = set()
        with tarfile.open(combined, 'r|gz') as tar:
            for member in tar:
                if not member.isfile() or member.name not in expected or member.name in seen:
                    raise ValueError('unexpected_archive_member')
                seen.add(member.name)
                h = hashlib.sha256()
                f = tar.extractfile(member)
                for b in iter(lambda: f.read(1024 * 1024), b''):
                    h.update(b)
                if member.size != expected[member.name]['bytes'] or h.hexdigest() != expected[member.name]['sha256']:
                    raise ValueError('archived_source_mismatch')
        if seen != set(expected):
            raise ValueError('archive_files_missing')
    finally:
        combined.unlink(missing_ok=True)
    total = 0
    for source in m['sources']:
        count, size, h = 0, 0, hashlib.sha256()
        for chunk in source['chunks']:
            p = checked_path(root, chunk['path'])
            if p.stat().st_size != chunk['bytes'] or digest(p) != chunk['sha256']:
                raise ValueError('row_chunk_mismatch')
            chunk_count = 0
            with gzip.open(p, 'rb') as f:
                for line in f:
                    if not isinstance(json.loads(line), dict):
                        raise ValueError('invalid_record')
                    h.update(line)
                    size += len(line)
                    count += 1
                    chunk_count += 1
            if chunk_count != chunk['rows']:
                raise ValueError('chunk_count_mismatch')
        if count != source['rows'] or count != source['expectedRows'] or size != source['jsonlBytes'] or h.hexdigest() != source['recordsSha256']:
            raise ValueError('source_stream_mismatch')
        total += count
    if total != m['stats']['rows']:
        raise ValueError('total_count_mismatch')
    print(json.dumps({'status': 'PASS', 'id': m['id'], 'sources': len(m['sources']), 'sourceFilesVerified': len(seen), 'recordsVerified': total, 'archiveBytes': m['stats']['archiveBytes']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', nargs='?', default='data-export/raw-v1')
    verify(Path(parser.parse_args().directory).resolve())
