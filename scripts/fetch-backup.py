#!/usr/bin/env python3
"""Download only encrypted snapshots over the existing verified SSH connection."""
from pathlib import Path
import subprocess, json, re, os, time, sys, shlex

def main():
    home=Path.home();destination=home/'Documents/SIGAA_Backups'
    destination.mkdir(parents=True,exist_ok=True)
    options=['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-i',str(home/'.ssh/sigaa_oracle_ed25519')]
    target='ubuntu@163.176.42.177'
    code="from pathlib import Path;files=sorted(Path('/var/backups/sigaa').glob('sigaa-*.enc'));print(files[-1].name if files else '')"
    result=subprocess.run(['ssh',*options,target,'python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=30)
    name=result.stdout.strip()
    if result.returncode or not re.fullmatch(r'sigaa-\d{8}-\d{6}\.enc',name):raise RuntimeError('Could not discover an encrypted backup')
    output=destination/name
    if not output.exists():
        temporary=output.with_suffix('.partial')
        result=subprocess.run(['scp',*options,target+':/var/backups/sigaa/'+name,str(temporary)],capture_output=True,text=True,timeout=60)
        if result.returncode:raise RuntimeError('Encrypted backup transfer failed')
        with temporary.open('rb') as file:
            header=b'SIGAA-BACKUP-v1\n'
            if file.read(len(header))!=header:raise RuntimeError('Invalid encrypted backup header')
        os.replace(temporary,output)
    for old in destination.glob('sigaa-*.enc'):
        if time.time()-old.stat().st_mtime>30*86400:old.unlink()
    metadata={'lastSuccessfulTransferUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'file':name,'bytes':output.stat().st_size,'encrypted':True}
    (destination/'last_transfer.json').write_text(json.dumps(metadata,indent=2)+'\n')
    if sys.stdout is not None:print(json.dumps(metadata))

if __name__=='__main__':main()
