#!/usr/bin/env python3
"""Consistent encrypted backups; only the workstation holds the private key."""
from pathlib import Path
import os, json, sqlite3, tarfile, tempfile, struct, time, grp, io
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

STATE = Path('/var/lib/sigaa')
DEST = Path('/var/backups/sigaa')
PUBLIC = Path('/etc/sigaa-backup-public.pem')

def main():
    if os.geteuid() != 0: raise RuntimeError('Run through the root backup service')
    DEST.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chown(DEST, 0, grp.getgrnam('ubuntu').gr_gid); os.chmod(DEST, 0o750)
    with tempfile.TemporaryDirectory(prefix='.work-', dir=DEST) as directory:
        work = Path(directory)
        # Sessions are ephemeral credentials and deliberately excluded.
        source = STATE/'data/exams/exams.sqlite'
        target = work/'exams.sqlite'
        if source.exists():
            target.touch(mode=0o600)
            src = sqlite3.connect('file:'+str(source)+'?mode=ro', uri=True)
            dst = sqlite3.connect(target)
            try:
                src.backup(dst)
                if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise RuntimeError('Invalid exam snapshot')
            finally: dst.close(); src.close()
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as tar:
            tar.add(STATE/'.env', arcname='config/.env')
            if target.exists(): tar.add(target, arcname='data/exams/exams.sqlite')
            for course in ['computacao', 'mecatronica']:
                cache = STATE/'cache'/('calendario_'+course+'.json')
                if cache.exists(): tar.add(cache, arcname='cache/'+cache.name)
            config = Path('/etc/sigaa-hardened.json')
            if config.exists(): tar.add(config, arcname='deployment.json')
        key, nonce = os.urandom(32), os.urandom(12)
        pub = serialization.load_pem_public_key(PUBLIC.read_bytes())
        wrapped = pub.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
        ciphertext = AESGCM(key).encrypt(nonce, archive.getvalue(), b'SIGAA-BACKUP-v1')
        output = DEST/time.strftime('sigaa-%Y%m%d-%H%M%S.enc', time.gmtime())
        temp = output.with_suffix('.tmp')
        fd = os.open(temp, os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as file:
            file.write(b'SIGAA-BACKUP-v1\n'+struct.pack('>I',len(wrapped))+wrapped+nonce+ciphertext)
        os.chown(temp, 0, grp.getgrnam('ubuntu').gr_gid); os.chmod(temp, 0o640)
        os.replace(temp, output)
    for old in DEST.glob('sigaa-*.enc'):
        if time.time()-old.stat().st_mtime > 14*86400: old.unlink()
    print(json.dumps({'backup':output.name,'encrypted':True,'sessionsExcluded':True,'bytes':output.stat().st_size}))

if __name__ == '__main__': main()
