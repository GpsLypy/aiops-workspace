"""Resume the pinned official Python 3.12 archive using verified small ranges.

This is the reusable version of the one-off PoC range downloader. It only
downloads the fixed official archive; it never installs or changes runtimes.
"""

import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

URL = 'https://releases.astral.sh/github/python-build-standalone/releases/download/20260623/cpython-3.12.13%2B20260623-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'
SIZE = 34159178
SHA256 = '10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1'
MIN_CHUNK = 16 * 1024
DEFAULT_DIRECTORY = pathlib.Path('/home/sandbox/poc-runtime/downloads/python-parts-128k')


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def valid_range_headers(text, start, end):
    # After HTTPS redirects, validate only the final HTTP response block.
    responses = re.split(r'(?im)(?=^HTTP/\S+\s+\d{3})', text.replace('\r\n', '\n'))
    response = responses[-1]
    status = re.match(r'HTTP/\S+\s+(\d{3})', response)
    content_range = re.search(r'(?im)^content-range:\s*bytes\s+(\d+)-(\d+)/(\d+)\s*$', response)
    return bool(status and status.group(1) == '206' and content_range and tuple(map(int, content_range.groups())) == (start, end, SIZE))


def checkpoint(target, start, end):
    metadata = {'url': URL, 'size': SIZE, 'start': start, 'end': end, 'sha256': file_digest(target)}
    temporary = target.with_name(target.name + '.verified.json.partial')
    temporary.write_text(json.dumps(metadata) + '\n')
    temporary.replace(target.with_name(target.name + '.verified.json'))


def valid_cached_part(target, start, end):
    if target.is_symlink() or not target.is_file() or target.stat().st_size != end - start + 1:
        return False
    metadata_path = target.with_name(target.name + '.verified.json')
    if metadata_path.exists():
        try:
            metadata = json.loads(metadata_path.read_text())
            return metadata == {'url': URL, 'size': SIZE, 'start': start, 'end': end, 'sha256': file_digest(target)}
        except (OSError, ValueError):
            return False
    # Existing parts from the original one-off downloader can be resumed only
    # when their original Content-Range is valid. Whole-archive SHA is required.
    header = target.with_name(target.name + '.headers')
    if header.is_file() and valid_range_headers(header.read_text(), start, end):
        checkpoint(target, start, end)
        return True
    return False


def fetch_range(target, start, end):
    if valid_cached_part(target, start, end):
        return target
    temporary = target.with_name(target.name + '.partial')
    header = target.with_name(target.name + '.headers.partial')
    try:
        subprocess.run(['curl', '--location', '--proto', '=https', '--proto-redir', '=https',
                        '--fail', '--silent', '--show-error', '--retry', '1', '--retry-all-errors',
                        '--connect-timeout', '10', '--max-time', '45', '--range', f'{start}-{end}',
                        '-D', str(header), '-o', str(temporary), URL], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if not valid_range_headers(header.read_text(), start, end) or temporary.stat().st_size != end - start + 1:
            raise ValueError('Official range response did not match requested bytes')
        temporary.replace(target)
        header.replace(target.with_name(target.name + '.headers'))
        checkpoint(target, start, end)
        return target
    except (subprocess.CalledProcessError, OSError, ValueError):
        if end - start + 1 <= MIN_CHUNK:
            raise RuntimeError(f'Python archive range {start}-{end} failed; completed checkpoints retained') from None
        # A failed large range falls back to independently checkpointed smaller
        # ranges. Restarting the command retains successful leaves and parts.
        pieces = target.with_name(target.name + '.pieces')
        pieces.mkdir(exist_ok=True)
        middle = (start + end) // 2
        left = fetch_range(pieces / f'{start}-{middle}', start, middle)
        right = fetch_range(pieces / f'{middle + 1}-{end}', middle + 1, end)
        with temporary.open('wb') as stream:
            stream.write(left.read_bytes())
            stream.write(right.read_bytes())
        temporary.replace(target)
        checkpoint(target, start, end)
        return target


def assemble(parts, output):
    temporary = output.with_name(output.name + '.partial')
    with temporary.open('wb') as stream:
        for part in parts:
            stream.write(part.read_bytes())
    if temporary.stat().st_size != SIZE or file_digest(temporary) != SHA256:
        raise RuntimeError('Python archive official SHA256 check failed; final output not replaced')
    temporary.replace(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=pathlib.Path, default=DEFAULT_DIRECTORY)
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--chunk-size', type=int, default=128 * 1024)
    args = parser.parse_args()
    if not 1 <= args.workers <= 16 or not MIN_CHUNK <= args.chunk_size <= 1024 * 1024:
        parser.error('workers must be 1-16 and chunk-size must be 16384-1048576')
    if os.environ.get('COMPANY_SANDBOX_POC') != 'true' or os.getuid() != 1000:
        parser.error('Only the new PoC sandbox with COMPANY_SANDBOX_POC=true and UID 1000 is supported')
    root = args.directory.resolve()
    root.mkdir(parents=True, exist_ok=True)
    output = (args.output or root.parent / 'cpython-linux-x64.tar.gz').resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Never run two instances against the same checkpoint directory.
    with (root / '.download.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another Python archive downloader owns this checkpoint directory') from None
        if output.is_file() and output.stat().st_size == SIZE and file_digest(output) == SHA256:
            print(json.dumps({'archive': str(output), 'sha256': SHA256, 'alreadyVerified': True}))
            return
        count = (SIZE + args.chunk_size - 1) // args.chunk_size

        def download(index):
            start, end = index * args.chunk_size, min(SIZE, (index + 1) * args.chunk_size) - 1
            target = fetch_range(root / f'{index:03d}', start, end)
            print(f'part {index + 1}/{count}', flush=True)
            return target

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            parts = list(pool.map(download, range(count)))
        assemble(parts, output)
        print(json.dumps({'archive': str(output), 'sha256': SHA256, 'bytes': SIZE, 'alreadyVerified': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
