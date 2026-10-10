# Isolated runtime and backups

The service uses the dedicated `sigaa` system account, without an interactive
shell, sudo access or membership in the SSH administrator's group. Application
code and Node are installed under `/opt/sigaa`, owned by root and read-only to
the service. `ProtectHome`, `ProtectSystem=strict`, `NoNewPrivileges`, an empty
capability set and explicit writable data directories are enforced by systemd.

Persistent state is under `/var/lib/sigaa`. Its root-owned `.env` is readable by
the application group but cannot be changed or replaced by the application.
Only `data`, `cache` and `temp` are writable. Initial migration uses consistent
SQLite backups after stopping the previous service; current sessions and keys
are preserved. Failed service startup restores the previous unit.

The deployment entry detects `/etc/sigaa-hardened.json` and uses
`scripts/deploy-hardened.py`. It stages and tests as the SSH administrator, then
uses the root installer for immutable release installation. Do not restore the
old `User=ubuntu` unit or make application code writable to `sigaa`.

`sigaa-backup.timer` runs daily at 03:30 UTC, with up to five minutes of jitter.
The backup script snapshots the exam database using SQLite's backup API and
includes the institutional calendar cache, configuration and deployment marker.
Session credentials are deliberately excluded; after disaster recovery users
log in again. Snapshots are sealed with AES-256-GCM; each random key is wrapped
with RSA-OAEP/SHA-256 using the workstation's public key. No private backup key
is installed on the VPS. Server retention is fourteen days.

The workstation task `SIGAA Encrypted Backup` downloads encrypted snapshots
daily at 01:00 local time and at login. It uses verified SSH host keys and stores
copies in `Documents/SIGAA_Backups`, with thirty days of retention. Transfers
depend on the workstation being online. The private restore key is in
`.ssh/sigaa_backup_private.pem`, protected by Windows ACLs and outside Git.
Preserve that key separately: encrypted snapshots cannot be restored without it.

Restore into a private temporary directory first, validate authenticated
decryption and SQLite integrity, and only then schedule replacement of live
data. Never extract arbitrary archive paths or expose decrypted configuration
through logs or the frontend.
