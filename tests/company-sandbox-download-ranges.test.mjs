import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Python range helper validates final 206 and resumes only unchanged verified bytes without network', () => {
  const code = `
import importlib.util,pathlib,tempfile
spec=importlib.util.spec_from_file_location('poc_range_helper','deploy/company-sandbox/download-python-ranges.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
headers='HTTP/1.1 302 Found\\r\\nLocation: https://official.example/archive\\r\\n\\r\\nHTTP/2 206\\r\\nContent-Range: bytes 0-3/'+str(module.SIZE)+'\\r\\n\\r\\n'
assert module.valid_range_headers(headers,0,3)
assert not module.valid_range_headers(headers.replace('HTTP/2 206','HTTP/2 200'),0,3)
assert not module.valid_range_headers(headers,1,4)
with tempfile.TemporaryDirectory(prefix='company-poc-range-unit-') as temporary:
    target=pathlib.Path(temporary)/'000';target.write_bytes(b'abcd')
    target.with_name('000.headers').write_text(headers)
    assert module.valid_cached_part(target,0,3)
    target.write_bytes(b'dcba')
    assert not module.valid_cached_part(target,0,3)
print('Offline range validation passed')
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Offline range validation passed/);
});

test('Python range helper checkpoints smaller failed ranges and atomically requires full SHA without network', () => {
  const code = `
import hashlib,importlib.util,pathlib,subprocess,tempfile
spec=importlib.util.spec_from_file_location('poc_range_helper','deploy/company-sandbox/download-python-ranges.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
payload=bytes(range(256))*256
module.SIZE=len(payload);module.SHA256=hashlib.sha256(payload).hexdigest()
calls=[]
def synthetic_curl(arguments,**kwargs):
    start,end=map(int,arguments[arguments.index('--range')+1].split('-'));calls.append((start,end))
    if end-start+1>module.MIN_CHUNK:raise subprocess.CalledProcessError(28,arguments)
    pathlib.Path(arguments[arguments.index('-D')+1]).write_text('HTTP/2 206\\nContent-Range: bytes '+str(start)+'-'+str(end)+'/'+str(module.SIZE)+'\\n\\n')
    pathlib.Path(arguments[arguments.index('-o')+1]).write_bytes(payload[start:end+1])
module.subprocess.run=synthetic_curl
with tempfile.TemporaryDirectory(prefix='company-poc-range-resume-') as temporary:
    target=pathlib.Path(temporary)/'000';module.fetch_range(target,0,len(payload)-1)
    assert target.read_bytes()==payload and len(calls)>1
    count=len(calls);module.fetch_range(target,0,len(payload)-1);assert len(calls)==count
    output=pathlib.Path(temporary)/'archive.tar.gz';module.assemble([target],output);assert output.read_bytes()==payload
    module.SHA256='0'*64
    try:module.assemble([target],output)
    except RuntimeError:pass
    else:raise AssertionError('wrong archive SHA accepted')
    assert output.read_bytes()==payload
print('Offline split/resume/SHA validation passed')
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Offline split\/resume\/SHA validation passed/);
});
