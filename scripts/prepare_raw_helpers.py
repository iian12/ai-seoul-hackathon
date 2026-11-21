import hashlib
import json


def manifest_id(manifest):
    content = {k: v for k, v in manifest.items() if k not in {'id', 'createdAt'}}
    return hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def checked_path(root, relative):
    p = (root / relative).resolve()
    if not p.is_relative_to(root.resolve()):
        raise ValueError('package_path_outside_root')
    return p
