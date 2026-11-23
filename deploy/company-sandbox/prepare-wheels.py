"""Prepare a frozen CPython 3.12/Linux x86_64 wheel plan without network access."""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import tomllib
import urllib.parse

try:
    from packaging.markers import default_environment
    from packaging.requirements import Requirement
    from packaging.tags import compatible_tags, cpython_tags
    from packaging.utils import canonicalize_name, parse_wheel_filename
except ImportError:
    # The platform's system pip provides this parser without installing anything.
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.tags import compatible_tags, cpython_tags
    from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename


def target_environment():
    return {**default_environment(), 'os_name': 'posix', 'sys_platform': 'linux',
            'platform_machine': 'x86_64', 'platform_python_implementation': 'CPython',
            'platform_system': 'Linux', 'implementation_name': 'cpython',
            'python_version': '3.12', 'python_full_version': '3.12.13',
            'implementation_version': '3.12.13', 'extra': ''}


def frozen_requirements(text):
    selected = []
    for line in text.replace('\\\n', ' ').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        hashes = set(re.findall(r'--hash=sha256:([a-f0-9]{64})', line))
        requirement = Requirement(line.split('--hash=')[0].strip())
        if not hashes or requirement.url or len(list(requirement.specifier)) != 1:
            raise ValueError('Every frozen requirement must pin one version and SHA256 hashes')
        pin = list(requirement.specifier)[0]
        if pin.operator != '==':
            raise ValueError('Frozen requirements must use exact versions')
        if not requirement.marker or requirement.marker.evaluate(target_environment()):
            selected.append((canonicalize_name(requirement.name), pin.version, hashes))
    return selected


def target_tag_ranks(glibc_minor):
    platforms = [f'manylinux_2_{minor}_x86_64' for minor in range(glibc_minor, 16, -1)]
    platforms += ['manylinux2014_x86_64', 'manylinux2010_x86_64', 'manylinux1_x86_64', 'linux_x86_64']
    tags = list(cpython_tags(python_version=(3, 12), abis=['cp312'], platforms=platforms))
    tags += list(compatible_tags(python_version=(3, 12), interpreter='cp312', platforms=platforms))
    return {tag: index for index, tag in reversed(list(enumerate(tags)))}


def select_wheels(lock, requirements, glibc_minor):
    packages = {(canonicalize_name(package['name']), package['version']): package for package in lock['package']}
    ranks = target_tag_ranks(glibc_minor)
    result = []
    for name, version, hashes in frozen_requirements(requirements):
        package = packages[(name, version)]
        if package.get('source') != {'registry': 'https://pypi.org/simple'}:
            raise ValueError('Worker wheel plan only accepts the locked official PyPI registry')
        candidates = []
        for wheel in package.get('wheels', []):
            url = urllib.parse.urlsplit(wheel['url'])
            if url.scheme != 'https' or url.netloc != 'files.pythonhosted.org' or url.query or url.fragment:
                continue
            filename = urllib.parse.unquote(pathlib.PurePosixPath(url.path).name)
            wheel_name, wheel_version, _, wheel_tags = parse_wheel_filename(filename)
            common = wheel_tags.intersection(ranks)
            wheel_hash = wheel['hash'].removeprefix('sha256:')
            if common and wheel_hash in hashes and canonicalize_name(wheel_name) == name and str(wheel_version) == version:
                candidates.append((min(ranks[tag] for tag in common), {**wheel, 'name': name, 'version': version, 'filename': filename, 'sha256': wheel_hash}))
        if not candidates:
            raise ValueError(f'No locked official binary wheel matches CPython3.12/linux x86_64: {name}=={version}')
        result.append(min(candidates, key=lambda item: item[0])[1])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=pathlib.Path, default=pathlib.Path('agent-worker'))
    parser.add_argument('--out-directory', type=pathlib.Path, required=True)
    parser.add_argument('--glibc', default='2.28', help='Verified target glibc major.minor; default chooses portable >=2.28 wheels')
    args = parser.parse_args()
    match = re.fullmatch(r'2\.(\d+)', args.glibc)
    if not match or int(match.group(1)) < 28:
        parser.error('This PoC plan requires verified glibc >=2.28')
    project = args.project.resolve()
    lock_bytes = (project / 'uv.lock').read_bytes()
    lock = tomllib.loads(lock_bytes.decode())
    if lock.get('requires-python') != '==3.12.*':
        parser.error('Expected existing locked Python3.12 worker')
    version = subprocess.run(['uv', '--version'], capture_output=True, text=True, check=True).stdout
    if not re.match(r'^uv 0\.11\.26(?:\s|$)', version):
        parser.error('uv 0.11.26 is required for the frozen export')
    exported = subprocess.run(['uv', 'export', '--offline', '--frozen', '--no-dev', '--no-emit-project', '--no-editable', '--format', 'requirements.txt'], cwd=project, capture_output=True, text=True, check=True).stdout
    if (project / 'uv.lock').read_bytes() != lock_bytes:
        raise ValueError('Source uv.lock changed while preparing the plan')
    wheels = select_wheels(lock, exported, int(match.group(1)))
    output = args.out_directory.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    requirements_path = output / 'requirements-frozen.txt'
    with requirements_path.open('x') as stream:
        stream.write(exported)
    requirements_path.chmod(0o600)
    manifest = {'schemaVersion': 1, 'kind': 'company-sandbox-worker-wheel-plan',
                'target': {'python': '3.12.13', 'implementation': 'CPython', 'platform': 'linux-x86_64', 'glibc': args.glibc},
                'lockSha256': hashlib.sha256(lock_bytes).hexdigest(),
                'requirementsSha256': hashlib.sha256(exported.encode()).hexdigest(),
                'totalBytes': sum(wheel['size'] for wheel in wheels), 'wheels': wheels}
    manifest_path = output / 'wheel-plan.json'
    with manifest_path.open('x') as stream:
        json.dump(manifest, stream, indent=2)
        stream.write('\n')
    manifest_path.chmod(0o600)
    largest = sorted(wheels, key=lambda item: item['size'], reverse=True)[:10]
    print(json.dumps({'manifest': str(manifest_path), 'requirements': str(requirements_path), 'wheels': len(wheels),
                      'totalBytes': manifest['totalBytes'], 'lockUnchanged': True,
                      'largest': [{'name': item['name'], 'version': item['version'], 'bytes': item['size']} for item in largest]}))


if __name__ == '__main__':
    main()
