#!/usr/bin/env python3
"""Root installation isolates application code and writable state from SSH."""
from pathlib import Path
import os, sys, json, re, pwd, grp, shutil, subprocess, sqlite3, urllib.request, time

BASE = Path('/opt/sigaa')
STATE = Path('/var/lib/sigaa')
UNIT = Path('/etc/systemd/system/sigaa-backend.service')
MARKER = Path('/etc/sigaa-hardened.json')
ADMIN = Path('/home/ubuntu')

def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if result.returncode: raise RuntimeError('Command failed: '+str(args[0])+': '+result.stderr[-300:])
    return result.stdout.strip()

def snapshot(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect('file:'+str(source)+'?mode=ro', uri=True); dst = sqlite3.connect(target)
    try:
        src.backup(dst)
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise RuntimeError('Invalid snapshot')
    finally: dst.close(); src.close()

def private_state():
    user, group = pwd.getpwnam('sigaa'), grp.getgrnam('sigaa')
    for root, dirs, files in os.walk(STATE, followlinks=False):
        os.chown(root, user.pw_uid, group.gr_gid); os.chmod(root, 0o700)
        for name in files:
            path = Path(root)/name
            if path.is_symlink(): raise RuntimeError('Unexpected state symlink')
            os.chown(path, user.pw_uid, group.gr_gid); os.chmod(path, 0o600)
    os.chown(STATE/'.env', 0, group.gr_gid); os.chmod(STATE/'.env', 0o640)

def switch(target):
    temporary = BASE/'current.next'
    if temporary.is_symlink(): temporary.unlink()
    temporary.symlink_to(target, target_is_directory=True); os.replace(temporary, BASE/'current')

def main():
    if os.geteuid()!=0: raise RuntimeError('Root installer required')
    stage = Path(sys.argv[1]).resolve(); sha, front = sys.argv[2:4]
    if not stage.is_relative_to(ADMIN/'sigaa-releases') or not all(re.fullmatch('[a-f0-9]{40}',value) for value in [sha,front]): raise RuntimeError('Invalid release')
    if json.loads((stage/'backend/package.json').read_text())['name']!='sigaa-api-backend': raise RuntimeError('Wrong application')
    try: pwd.getpwnam('sigaa')
    except KeyError: run(['useradd','--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','sigaa'])
    BASE.mkdir(parents=True, exist_ok=True); STATE.mkdir(parents=True, exist_ok=True)
    release = BASE/'releases'/stage.name
    if release.exists(): raise RuntimeError('Release already installed')
    group = grp.getgrnam('sigaa').gr_gid
    def ignore(folder,names):
        excluded={'.git'}
        if Path(folder)==stage/'backend': excluded.update(['.env','data','cache','temp'])
        return excluded.intersection(names)
    shutil.copytree(stage, release, ignore=ignore, symlinks=True)
    runtime = BASE/'runtime'
    if not runtime.exists():
        node = sorted((ADMIN/'.local/lib').glob('node-v24.*-linux-x64'))[-1]
        shutil.copytree(node, runtime, symlinks=True)
    for tree in [release, runtime]:
        for folder, dirs, files in os.walk(tree, followlinks=False):
            os.chown(folder, 0, group); os.chmod(folder, 0o750)
            for name in files:
                path=Path(folder)/name
                if path.is_symlink(): continue
                executable = bool(path.stat().st_mode & 0o111)
                os.chown(path,0,group);os.chmod(path,0o750 if executable else 0o640)
    for name in ['data','cache','temp']:
        (release/'backend'/name).symlink_to(STATE/name,target_is_directory=True)
    (release/'backend/.env').symlink_to(STATE/'.env')
    old_unit=UNIT.read_text(); old_current=(BASE/'current').resolve() if (BASE/'current').exists() else None
    first = not MARKER.exists()
    old_marker=MARKER.read_text() if MARKER.exists() else None
    run(['systemctl','stop','sigaa-backend.service'])
    try:
        if first:
            shared=ADMIN/'sigaa-shared'
            shutil.copy2(shared/'.env', STATE/'.env')
            for name in ['cache','temp']:
                shutil.copytree((shared/name).resolve(),STATE/name,dirs_exist_ok=True)
            for folder in ['sessions','exams']:
                source=shared/f'data/{folder}/{folder}.sqlite'
                if source.exists(): snapshot(source,STATE/f'data/{folder}/{folder}.sqlite')
        private_state()
        switch(release)
        unit=f'''[Unit]
Description=SIGAA API (isolated user)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=sigaa
Group=sigaa
WorkingDirectory=/opt/sigaa/current/backend
ExecStart=/opt/sigaa/runtime/bin/node /opt/sigaa/current/backend/server.js
Environment=PORT=8080
Environment=HOST=127.0.0.1
Environment=NODE_ENV=vps
Environment=RELEASE_VERSION={sha}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/sigaa
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
'''
        UNIT.write_text(unit);os.chmod(UNIT,0o644)
        run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','sigaa-backend.service'])
        for _ in range(40):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=2) as response: health=json.load(response)
                if health.get('release')==sha:break
            except Exception:pass
            time.sleep(.25)
        else:raise RuntimeError('Isolated application failed health check')
        MARKER.write_text(json.dumps({'backend':sha,'frontend':front,'release':str(release),'state':str(STATE)})+'\n');os.chmod(MARKER,0o644)
        print(json.dumps({'hardened':True,'user':'sigaa','backend':sha,'frontend':front,'statePreserved':True,'release':str(release)}))
    except Exception:
        run(['systemctl','stop','sigaa-backend.service'])
        if old_current: switch(old_current)
        UNIT.write_text(old_unit)
        if old_marker: MARKER.write_text(old_marker)
        elif MARKER.exists(): MARKER.unlink()
        run(['systemctl','daemon-reload']);run(['systemctl','start','sigaa-backend.service'])
        raise

if __name__=='__main__':main()
