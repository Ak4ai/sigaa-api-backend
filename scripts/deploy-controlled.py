#!/usr/bin/env python3
"""Test candidate, switch proxy, preserve secrets/data and roll back on failure."""
from pathlib import Path
import json, os, re, signal, shutil, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error

home = Path.home()
shared, current = home/'sigaa-shared', home/'sigaa-current'
service = 'sigaa-backend.service'
unit_path = Path('/etc/systemd/system')/service
nginx_path = Path('/etc/nginx/sites-enabled/sigaa').resolve()

def log(message): print('[deploy] '+message, flush=True)

def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode: raise RuntimeError(str(args[0])+' failed: '+result.stderr[-1000:])
    return result.stdout.strip()

def request(port, endpoint, data=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{endpoint}', data=json.dumps(data).encode() if data is not None else None, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response: return json.load(response)

def running_backend():
    found=[]
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit(): continue
        try:
            args=(proc/'cmdline').read_bytes().split(b'\0')
            env=dict(x.split(b'=',1) for x in (proc/'environ').read_bytes().split(b'\0') if b'=' in x)
            if not any(x==b'server.js' or x.endswith(b'/server.js') for x in args) or int(env.get(b'PORT',b'3000'))!=8080: continue
            cwd=Path(os.readlink(proc/'cwd')).resolve()
            if cwd.is_relative_to(home.resolve()): found.append((int(proc.name),cwd,{k.decode():v.decode() for k,v in env.items()}))
        except (OSError,ValueError): pass
    if len(found)!=1: raise RuntimeError('Expected one backend on port 8080')
    return found[0]

def stop(pid):
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: return
    for _ in range(50):
        try:
            if (Path('/proc')/str(pid)/'stat').read_text().split()[2]=='Z': return
        except FileNotFoundError: return
        time.sleep(.1)
    raise RuntimeError('Process did not stop')

def link(target,destination):
    temp=destination.with_name(destination.name+'.next')
    if temp.is_symlink(): temp.unlink()
    if temp.exists(): raise RuntimeError('Unexpected temporary path')
    temp.symlink_to(target,target_is_directory=target.is_dir());os.replace(temp,destination)

def install_text(text,destination):
    with tempfile.NamedTemporaryFile(mode='w',delete=False) as out: out.write(text);source=Path(out.name)
    try: run(['sudo','-n','install','-m','644',str(source),str(destination)])
    finally: source.unlink()

def configure_proxy(text):
    install_text(text,nginx_path)
    run(['sudo','-n','nginx','-t']);run(['sudo','-n','systemctl','reload','nginx'])

def proxy_config(text,port):
    result,count=re.subn(r'proxy_pass http://(?:localhost|127\.0\.0\.1):\d+;',f'proxy_pass http://127.0.0.1:{port};',text)
    if count!=1: raise RuntimeError('Unexpected proxy configuration')
    if 'proxy_read_timeout' not in result:
        marker=f'proxy_pass http://127.0.0.1:{port};'
        result=result.replace(marker,marker+'\n        proxy_read_timeout 180s;\n        proxy_send_timeout 15s;\n        client_max_body_size 16k;\n        client_body_timeout 15s;')
    return result

def probe(port,sha):
    for _ in range(30):
        try:
            if request(port,'/api/health').get('release')==sha: break
        except Exception: pass
        time.sleep(.25)
    else: raise RuntimeError('Health check failed')
    token=request(port,'/api/login',{'user':'deployment-smoke','pass':'not-a-real-password'})['token']
    if not request(port,'/api/logout',{'token':token}).get('success'): raise RuntimeError('Logout failed')
    try: request(port,'/api/scraper',{'token':token})
    except urllib.error.HTTPError as error:
        if error.code!=401: raise
    else: raise RuntimeError('Revoked token accepted')

def main():
    refs=[sys.argv[1] if len(sys.argv)>1 else 'main',sys.argv[2] if len(sys.argv)>2 else 'main']
    if any(ref!='main' and not re.fullmatch('[a-f0-9]{40}',ref) for ref in refs): raise RuntimeError('Invalid commit')
    nodes=sorted((home/'.local/lib').glob('node-v24.*-linux-x64/bin/node'),key=lambda p:tuple(map(int,p.parent.parent.name.split('-')[1][1:].split('.'))))
    if not nodes: raise RuntimeError('Install verified Node 24 LTS first')
    node=nodes[-1];version=run([str(node),'--version'])
    env=os.environ.copy();env['PATH']=str(node.parent)+':'+env.get('PATH','')
    old_pid,old_dir,old_env=running_backend()
    if json.loads((old_dir/'package.json').read_text()).get('name')!='sigaa-api-backend': raise RuntimeError('Unexpected backend application')
    old_current=current.resolve() if current.is_symlink() else None
    old_proxy=nginx_path.read_text();old_unit=unit_path.read_text() if unit_path.exists() else None
    old_service_pid=run(['systemctl','show',service,'--property=MainPID','--value'])
    if old_service_pid not in ['', '0', str(old_pid)]: raise RuntimeError('Service belongs to another process')
    release=home/'sigaa-releases'/time.strftime('%Y%m%d-%H%M%S',time.gmtime());release.mkdir(parents=True,exist_ok=False)
    backend,frontend=release/'backend',release/'Sigaa-API-webapp'
    log('Cloning backend and frontend commits')
    for folder,url,ref in [(backend,'https://github.com/Ak4ai/sigaa-api-backend.git',refs[0]),(frontend,'https://github.com/Ak4ai/Sigaa-API-webapp.git',refs[1])]:
        run(['git','clone','--quiet','--branch','main','--single-branch',url,str(folder)])
        if ref!='main': run(['git','fetch','--quiet','origin',ref],cwd=folder)
        run(['git','checkout','--quiet',ref],cwd=folder)
    sha=run(['git','rev-parse','HEAD'],cwd=backend);front_sha=run(['git','rev-parse','HEAD'],cwd=frontend)
    shared.mkdir(mode=0o700,exist_ok=True);os.chmod(shared,0o700)
    if not (shared/'.env').exists(): shutil.copy2(old_dir/'.env',shared/'.env')
    os.chmod(shared/'.env',0o600)
    for name in ['cache','temp','data']:
        target=shared/name
        # Share the same physical files during transition: no stale cache copy.
        if not target.exists():
            if (old_dir/name).exists(): target.symlink_to(old_dir/name,target_is_directory=True)
            else: target.mkdir(mode=0o700)
        (backend/name).symlink_to(target,target_is_directory=True)
    (backend/'.env').symlink_to(shared/'.env')
    log('Installing locked dependencies and testing with '+version)
    run([str(node.parent/'npm'),'ci','--omit=dev','--ignore-scripts'],cwd=backend,env=env,timeout=180)
    run([str(node.parent/'npm'),'audit','--omit=dev','--audit-level=low'],cwd=backend,env=env,timeout=60)
    run([str(node),'--test',*map(str,sorted((backend/'tests').glob('*.test.js')))],cwd=backend,env=env,timeout=90)
    with socket.socket() as sock: sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    candidate_env=env.copy();candidate_env.update(PORT=str(port),HOST='127.0.0.1',RELEASE_VERSION=sha,DISABLE_CALENDAR_CRON='1')
    for key in ['SECRET','ENC_SECRET','ENC_SECRET_USER']: candidate_env.pop(key,None)
    logs=shared/'logs';logs.mkdir(mode=0o700,exist_ok=True)
    output=open(logs/('candidate-'+sha[:8]+'.log'),'ab',buffering=0)
    candidate=subprocess.Popen([str(node),'server.js'],cwd=backend,env=candidate_env,stdin=subprocess.DEVNULL,stdout=output,stderr=output,start_new_session=True)
    switched=stopped=installed=False
    try:
        log('Checking candidate while current API stays online');probe(port,sha)
        (release/'deployment.json').write_text(json.dumps({'backend':sha,'frontend':front_sha,'node':version})+'\n')
        configure_proxy(proxy_config(old_proxy,port));switched=True
        log('Proxy switched; draining previous backend')
        deadline=time.monotonic()+150
        while True:
            queue=request(8080,'/api/queue-status')
            if not queue.get('processing') and not queue.get('queueLength'): break
            if time.monotonic()>deadline: raise RuntimeError('Previous backend still busy')
            time.sleep(1)
        if old_service_pid==str(old_pid): run(['sudo','-n','systemctl','stop',service])
        else: stop(old_pid)
        stopped=True;link(release,current)
        unit=f'''[Unit]
Description=SIGAA API
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory={current}/backend
ExecStart={node} {current}/backend/server.js
Environment=PORT=8080
Environment=HOST=127.0.0.1
Environment=NODE_ENV=vps
Environment=RELEASE_VERSION={sha}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
[Install]
WantedBy=multi-user.target
'''
        install_text(unit,unit_path);installed=True
        run(['sudo','-n','systemctl','daemon-reload']);run(['sudo','-n','systemctl','enable','--now',service])
        probe(8080,sha);configure_proxy(proxy_config(old_proxy,8080));stop(candidate.pid)
        wrapper=home/'deploy.sh';wrapper.write_text('#!/bin/sh\nset -eu\nexec python3 "'+str(current/'backend/scripts/deploy-controlled.py')+'" "$@"\n');os.chmod(wrapper,0o700)
        log('Validated; previous release retained for rollback')
        print(json.dumps({'deployed':True,'backend':sha,'frontend':front_sha,'node':version,'releaseDir':str(release),'service':service,'secretsPreserved':True}),flush=True)
    except Exception:
        log('Validation failed; restoring previous service')
        if installed:
            run(['sudo','-n','systemctl','stop',service])
            if old_unit is None: run(['sudo','-n','rm','-f',str(unit_path)])
            else: install_text(old_unit,unit_path)
            run(['sudo','-n','systemctl','daemon-reload'])
        if old_current: link(old_current,current)
        elif current.is_symlink(): current.unlink()
        if stopped:
            if old_unit and old_service_pid==str(old_pid): run(['sudo','-n','systemctl','start',service])
            else:
                old_log=open(home/'sigaa_server.log','ab',buffering=0)
                subprocess.Popen(['/usr/bin/node','server.js'],cwd=old_dir,env=old_env,stdin=subprocess.DEVNULL,stdout=old_log,stderr=old_log,start_new_session=True);time.sleep(.5)
        if switched: configure_proxy(old_proxy)
        if candidate.poll() is None: stop(candidate.pid)
        raise

if __name__=='__main__': main()
