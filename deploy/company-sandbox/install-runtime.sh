#!/bin/sh
set -eu
# Installs only into this new PoC workspace; never replaces system runtimes.
test "${COMPANY_SANDBOX_POC:-}" = true
test "$(id -u)" = 1000
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
umask 077
runtime_dir=/home/sandbox/poc-runtime
mkdir -p "$runtime_dir/downloads" "$runtime_dir/bin"
cd "$runtime_dir/downloads"

ensure_link() {
  expected_target=$1
  link_path=$2
  if test -L "$link_path"; then
    test "$(readlink "$link_path")" = "$expected_target" || { echo 'Existing PoC runtime link has a different target; inspect it before continuing' >&2; exit 1; }
  elif test -e "$link_path"; then
    echo 'Existing PoC runtime link path is an ordinary file; refusing to overwrite it' >&2
    exit 1
  else
    ln -s "$expected_target" "$link_path"
  fi
}

node_version=v22.23.1
node_archive="node-${node_version}-linux-x64.tar.xz"
node_directory="$runtime_dir/node-${node_version}-linux-x64"
test ! -L "$node_directory"
test ! -L "$runtime_dir/uv"
test ! -L "$runtime_dir/python-standalone"
if test ! -f "$node_archive"; then
  if test -f "/workspace/poc-runtime/downloads/$node_archive"; then
    cp "/workspace/poc-runtime/downloads/$node_archive" "$node_archive"
  else
    curl -fsS --retry 2 --max-time 180 -o "$node_archive.partial" "https://nodejs.org/dist/${node_version}/${node_archive}"
    mv "$node_archive.partial" "$node_archive"
  fi
fi
test ! -L "$node_archive"
curl -fsS --retry 2 --max-time 60 -o SHASUMS256.txt "https://nodejs.org/dist/${node_version}/SHASUMS256.txt"
awk -v file="$node_archive" '$2 == file' SHASUMS256.txt > node.sha256
test -s node.sha256
sha256sum -c node.sha256
if test -x "$node_directory/bin/node"; then
  test "$("$node_directory/bin/node" --version)" = "$node_version"
elif test -e "$node_directory"; then
  echo 'Existing PoC Node directory is incomplete; refusing to overwrite it' >&2
  exit 1
else
  node_staging="$runtime_dir/node-unpack-$$"
  mkdir "$node_staging"
  tar -xJf "$node_archive" -C "$node_staging"
  test "$("$node_staging/node-${node_version}-linux-x64/bin/node" --version)" = "$node_version"
  mv "$node_staging/node-${node_version}-linux-x64" "$node_directory"
  rmdir "$node_staging"
fi
if test -x "$runtime_dir/uv/bin/uv"; then
  test "$("$runtime_dir/uv/bin/uv" --version)" = 'uv 0.11.26'
elif test -e "$runtime_dir/uv"; then
  echo 'Existing PoC uv directory is incomplete; refusing to overwrite it' >&2
  exit 1
else
  python3 -m pip install --no-cache-dir --target "$runtime_dir/uv" uv==0.11.26
  test "$("$runtime_dir/uv/bin/uv" --version)" = 'uv 0.11.26'
fi
ensure_link "$runtime_dir/uv/bin/uv" "$runtime_dir/bin/uv"
export UV_PYTHON_INSTALL_DIR="$runtime_dir/python"
if test -n "${POC_PYTHON_ARCHIVE:-}"; then
  # This exact official standalone archive is listed in uv 0.11.26 metadata.
  test -f "$POC_PYTHON_ARCHIVE" && test ! -L "$POC_PYTHON_ARCHIVE"
  printf '%s  %s\n' '10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1' "$POC_PYTHON_ARCHIVE" | sha256sum -c -
  python_path="$runtime_dir/python-standalone/python/bin/python3.12"
  if test -x "$python_path"; then
    "$python_path" -c 'import sys,ssl,sqlite3,ctypes,venv; assert sys.version_info[:3] == (3,12,13)'
  elif test -e "$runtime_dir/python-standalone"; then
    echo 'Existing PoC Python directory is incomplete; refusing to overwrite it' >&2
    exit 1
  else
    python_staging="$runtime_dir/python-unpack-$$"
    mkdir "$python_staging"
    tar -xzf "$POC_PYTHON_ARCHIVE" -C "$python_staging"
    "$python_staging/python/bin/python3.12" -c 'import sys,ssl,sqlite3,ctypes,venv; assert sys.version_info[:3] == (3,12,13)'
    mv "$python_staging" "$runtime_dir/python-standalone"
  fi
elif test -L "$runtime_dir/bin/python3.12"; then
  python_path=$(readlink "$runtime_dir/bin/python3.12")
  case "$python_path" in
    "$runtime_dir/python-standalone/python/bin/python3.12"|"$runtime_dir/python/"*/bin/python3.12) ;;
    *) echo 'Existing Python link is outside the specified PoC installations' >&2; exit 1 ;;
  esac
  "$python_path" -c 'import sys,ssl,sqlite3,ctypes,venv; assert sys.version_info[:2] == (3,12)'
else
  UV_HTTP_TIMEOUT=30 "$runtime_dir/bin/uv" python install 3.12
  python_path=$("$runtime_dir/bin/uv" python find --managed-python 3.12)
fi
ensure_link "$python_path" "$runtime_dir/bin/python3.12"
cat > "$runtime_dir/env.sh.expected" <<'EOF'
export PATH=/home/sandbox/poc-runtime/node-v22.23.1-linux-x64/bin:/home/sandbox/poc-runtime/bin:$PATH
export UV_PYTHON_INSTALL_DIR=/home/sandbox/poc-runtime/python
EOF
if test -e "$runtime_dir/env.sh"; then
  test ! -L "$runtime_dir/env.sh"
  cmp "$runtime_dir/env.sh" "$runtime_dir/env.sh.expected" || { echo 'Existing PoC env.sh differs; preserve and inspect it before continuing' >&2; exit 1; }
else
  mv "$runtime_dir/env.sh.expected" "$runtime_dir/env.sh"
fi
. "$runtime_dir/env.sh"
node --version
python3.12 --version
uv --version
