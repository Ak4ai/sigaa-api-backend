# Server-side authenticated sessions

Login creates a session only after the SIGAA HTTPS login succeeds and the authenticated student portal identifies the user. Invalid credentials, pending academic notices, missing portal identity, timeouts and upstream failures do not create a session or replace the existing account.

The HttpOnly, Secure, SameSite=Lax cookie contains only an opaque `s3_` identifier with 256 random bits. No JWT, password or username is embedded in it. Only a SHA-256 fingerprint of the identifier is stored in `data/sessions/sessions.sqlite`. Credentials are encrypted on the server with AES-256-GCM and a key derived from the existing encryption secrets. Session records are authenticated cryptographically and files are private.

Sessions expire after seven days with Remember me, or twelve hours otherwise. Without Remember me the browser cookie has no persistent Max-Age. Expired sessions are deleted on access and during periodic cleanup. Logout deletes the server record before clearing the cookie; account replacement creates the new session and deletes the previous record in one transaction. Invalid login attempts leave the previous session intact. Storage failures fail closed.

All former credential-bearing JWTs are rejected. Users must log in again after this migration. The frontend keeps only nonsecret account and expiration metadata. Existing CSRF, origin checks, CSP and same-origin hosting remain in effect.

Preserve the whole `data/` directory during releases. The controlled deployment shares it through `sigaa-shared`, checks encrypted storage and deletion, and verifies that a real invalid SIGAA login cannot create a cookie before switching services. Session credentials must not be included in logs or repository history. Backups need the same private permissions and retention controls as live data.

This storage supports the current VPS and processes sharing its local SQLite database. It deliberately refuses Vercel ephemeral storage. Multiple servers require a shared session store before they can be used. Do not repurpose the old token-revocation Redis configuration for sessions.

Run `npm test` in the backend and `node tests/login-profile-browser.cjs` in the frontend. Successful authentication is tested against SIGAA fixtures; production rejected-login checks use synthetic invalid credentials and do not require a real user's password.
