#!/usr/bin/env python3
"""Stage as the SSH administrator; install immutable code through the root installer."""
from pathlib import Path
import subprocess, sys, re, os, time, json, urllib.request, http.cookiejar, urllib.error

def run(args,**kwargs):
    result=subprocess.run(args,capture_output=True,text=True,**kwargs)
    if result.returncode:raise RuntimeError(str(args[0])+' failed: '+(result.stderr or result.stdout)[-1200:])
    return result.stdout.strip()

def main():
    refs=[sys.argv[1] if len(sys.argv)>1 else 'main',sys.argv[2] if len(sys.argv)>2 else 'main']
    if any(ref!='main' and not re.fullmatch('[a-f0-9]{40}',ref) for ref in refs):raise RuntimeError('Invalid commit')
    home=Path.home();stage=home/'sigaa-releases'/time.strftime('%Y%m%d-%H%M%S-hardened',time.gmtime())
    stage.mkdir(parents=True,exist_ok=False)
    node=sorted((home/'.local/lib').glob('node-v24.*-linux-x64/bin/node'))[-1]
    env=os.environ.copy();env['PATH']=str(node.parent)+':'+env.get('PATH','')
    print('[deploy] Staging isolated backend and frontend',flush=True)
    for folder,url,ref in [('backend','https://github.com/Ak4ai/sigaa-api-backend.git',refs[0]),('Sigaa-API-webapp','https://github.com/Ak4ai/Sigaa-API-webapp.git',refs[1])]:
        path=stage/folder;run(['git','clone','--quiet','--branch','main','--single-branch',url,str(path)])
        if ref!='main':run(['git','fetch','--quiet','origin',ref],cwd=path)
        run(['git','checkout','--quiet',ref],cwd=path)
    backend=stage/'backend'
    sha=run(['git','rev-parse','HEAD'],cwd=backend);front=run(['git','rev-parse','HEAD'],cwd=stage/'Sigaa-API-webapp')
    run([str(node.parent/'npm'),'ci','--omit=dev','--ignore-scripts'],cwd=backend,env=env,timeout=180)
    run([str(node.parent/'npm'),'audit','--omit=dev','--audit-level=low'],cwd=backend,env=env,timeout=60)
    run([str(node),'--test',*map(str,sorted((backend/'tests').glob('*.test.js')))],cwd=backend,env=env,timeout=90)
    # Drain ordinary scraping before the short service transition.
    deadline=time.monotonic()+150
    while True:
        with urllib.request.urlopen('http://127.0.0.1:8080/api/queue-status',timeout=5) as response:queue=json.load(response)
        if not queue.get('processing') and not queue.get('queueLength'):break
        if time.monotonic()>deadline:raise RuntimeError('Backend remains busy')
        time.sleep(1)
    print('[deploy] Installing root-owned release for the isolated account',flush=True)
    print(run(['sudo','-n','python3',str(backend/'scripts/install-hardened-release.py'),str(stage),sha,front],timeout=90),flush=True)
    wrapper=home/'deploy.sh'
    # The SSH administrator needs a readable deploy entry point, not access to application secrets.
    wrapper.write_text('#!/bin/sh\nset -eu\nexec python3 "'+str(backend/'scripts/deploy-hardened.py')+'" "$@"\n')
    os.chmod(wrapper,0o700)
    print(json.dumps({'deployed':True,'backend':sha,'frontend':front,'isolatedUser':'sigaa'}),flush=True)

if __name__=='__main__':main()
