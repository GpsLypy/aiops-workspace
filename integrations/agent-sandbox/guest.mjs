// The whole guest is untrusted. The broker independently validates every envelope
// and scans every byte; this helper never decides host security or approval.
export function guestSource(source) {
  const source64 = Buffer.from(source).toString('base64');
  return `
import base64, json, os, pathlib, selectors, signal, stat, subprocess, sys, time
from pathlib import Path
if any(Path(p).exists() for p in ['/app','/run/secrets','/var/run/docker.sock']):
    sys.exit(70)
if any(k.startswith(('MODEL_','MASTER_','OPENAI_','AWS_','AZURE_','GOOGLE_')) or any(t in k for t in ('SECRET','TOKEN','PASSWORD','CREDENTIAL','API_KEY')) for k in os.environ):
    sys.exit(70)
Path('/work/output').mkdir(mode=0o700)
source = base64.b64decode('${source64}').decode('utf-8')
child = subprocess.Popen([sys.executable, '-I', '-B', '-c', source], cwd='/work', stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/work','TMPDIR':'/work'})
selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
chunks = {'stdout':bytearray(), 'stderr':bytearray()}
overflow = False
while selector.get_map():
    for key, _ in selector.select(0.1):
        piece = os.read(key.fileobj.fileno(), 8192)
        if not piece:
            selector.unregister(key.fileobj)
            continue
        chunks[key.data].extend(piece)
        if sum(len(v) for v in chunks.values()) > 65536:
            overflow = True
            os.killpg(child.pid, signal.SIGKILL)
            selector.close()
            break
    if overflow: break
exit_code = child.wait()
# Descendant daemons are not allowed to survive collection.
try: os.killpg(child.pid, signal.SIGKILL)
except ProcessLookupError: pass
if overflow:
    print(json.dumps({'version':1,'exitCode':exit_code,'stdout':'','stderr':'','artifacts':[],'error':'output_quota'}))
    sys.exit(0)
artifacts=[]
total=0
error=None
for entry in sorted(Path('/work/output').iterdir()):
    descriptor=None
    try:
        descriptor=os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info=os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1048576:
            error='unsafe_artifact'; break
        data=os.read(descriptor, 1048577)
        total += len(data)
        if len(artifacts) >= 8 or total > 1048576:
            error='artifact_quota'; break
        artifacts.append({'name':entry.name,'contentBase64':base64.b64encode(data).decode('ascii')})
    except OSError:
        error='unsafe_artifact'; break
    finally:
        if descriptor is not None: os.close(descriptor)
print(json.dumps({'version':1,'exitCode':exit_code,'stdout':bytes(chunks['stdout']).decode('utf-8','replace'),'stderr':bytes(chunks['stderr']).decode('utf-8','replace'),'artifacts':artifacts if not error else [],'error':error}))
`;
}
