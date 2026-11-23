"""Verify a frozen wheel plan; download only when --execute is explicitly given."""

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import tomllib
import urllib.parse


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=pathlib.Path, required=True)
    parser.add_argument('--lock', type=pathlib.Path, default=pathlib.Path('agent-worker/uv.lock'))
    parser.add_argument('--wheel-directory', type=pathlib.Path, default=pathlib.Path('/home/sandbox/poc-runtime/wheels'))
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--verify-complete', action='store_true', help='Fail if any locked wheel is absent or does not match its SHA256')
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    plan = json.loads(args.manifest.read_text())
    if plan.get('schemaVersion') != 1 or plan.get('kind') != 'company-sandbox-worker-wheel-plan' or digest(args.lock) != plan['lockSha256']:
        parser.error('Wheel plan does not match the current frozen worker lock')
    locked = tomllib.loads(args.lock.read_text())
    approved = {(package['name'], package['version'], wheel['url'], wheel['hash'].removeprefix('sha256:'), wheel['size']) for package in locked['package'] for wheel in package.get('wheels', [])}
    root = args.wheel_directory.resolve()
    missing = []
    for wheel in plan['wheels']:
        url = urllib.parse.urlsplit(wheel['url'])
        filename = urllib.parse.unquote(pathlib.PurePosixPath(url.path).name)
        if url.scheme != 'https' or url.netloc != 'files.pythonhosted.org' or filename != wheel['filename'] or not filename.endswith('.whl') or (wheel['name'], wheel['version'], wheel['url'], wheel['sha256'], wheel['size']) not in approved:
            parser.error('Wheel artifact is not present in the frozen official PyPI lock')
        target = root / filename
        if not target.is_file() or target.is_symlink() or target.stat().st_size != wheel['size'] or digest(target) != wheel['sha256']:
            missing.append(wheel)
    print(json.dumps({'execute': args.execute, 'wheels': len(plan['wheels']), 'missing': len(missing), 'missingBytes': sum(wheel['size'] for wheel in missing), 'directory': str(root)}), flush=True)
    if args.verify_complete and missing:
        parser.error('Complete verified wheelhouse required before offline installation')
    if not args.execute:
        return
    if os.environ.get('COMPANY_SANDBOX_POC') != 'true' or os.getuid() != 1000 or not 1 <= args.workers <= 16:
        parser.error('Execution requires the new PoC sandbox, COMPANY_SANDBOX_POC=true, UID1000 and 1-16 workers')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    helper_path = pathlib.Path(__file__).with_name('download-python-ranges.py')
    # Each wheel has a separate helper module/checkpoint tree. Downloads are
    # sequential by artifact, concurrent only within its verified byte ranges.
    for wheel in sorted(missing, key=lambda item: item['size'], reverse=True):
        spec = importlib.util.spec_from_file_location('poc_locked_wheel_ranges', helper_path)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        helper.URL, helper.SIZE, helper.SHA256 = wheel['url'], wheel['size'], wheel['sha256']
        chunks = root / '.ranges' / wheel['sha256']
        chunks.mkdir(parents=True, exist_ok=True, mode=0o700)
        chunk_size = 128 * 1024
        count = (wheel['size'] + chunk_size - 1) // chunk_size

        def download(index):
            start, end = index * chunk_size, min(wheel['size'], (index + 1) * chunk_size) - 1
            return helper.fetch_range(chunks / f'{index:05d}', start, end)

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            parts = list(pool.map(download, range(count)))
        helper.assemble(parts, root / wheel['filename'])
        print(json.dumps({'verifiedWheel': wheel['filename'], 'sha256': wheel['sha256'], 'bytes': wheel['size']}), flush=True)


if __name__ == '__main__':
    main()
