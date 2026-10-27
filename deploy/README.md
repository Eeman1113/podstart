# Self-hosting podstart's backend

Supabase Cloud's free tier caps storage at 1 GB, which a raw take exceeds in a
single hour. Self-hosting removes that limit, at the cost of a machine to look
after. This directory installs the whole stack onto one.

## What the installer guarantees

It owns **one directory** and nothing else.

- Every container belongs to the Compose project `podstart`, so your existing
  containers cannot be confused with its own and `docker compose down` in this
  directory cannot reach them.
- Every port is checked for a conflict before it is claimed, and bound to
  `127.0.0.1` only. Nothing is exposed to the internet directly.
- It never stops, restarts, upgrades or reconfigures anything that was already
  running, including Docker and the reverse proxy.
- It refuses to start if the target directory is non-empty or if a Compose
  project of the same name exists.
- The reverse proxy block is **printed for you to add**, not applied. An
  installer that edits a live Caddyfile or nginx.conf unattended is an
  installer that eventually takes a production site down.

## Use it

Look first. This changes nothing:

```bash
./install.sh --audit
```

It prints the host's resources, every running container, every listening port,
and which reverse proxy is active. Read that before going further.

Then install:

```bash
PODSTART_API_URL=https://supabase.yourhost.example \
PODSTART_PUBLIC_HOST=supabase.yourhost.example \
./install.sh --dir /database
```

It will show you the ports it intends to claim and wait for you to confirm.

Afterwards:

1. Add the block in `/database/caddy-snippet.conf` to your Caddyfile as a new
   entry, then `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`.
2. Copy the two values from `/database/podstart-frontend.env` into the podstart
   repo under **Settings → Secrets and variables → Actions → Variables**.
3. Push to `main`; the Pages workflow deploys the frontend against your backend.

## Requirements

Docker with the Compose plugin, git, and node. The full Supabase stack wants
about 4 GB of RAM; `--audit` will tell you what the machine has.

## Afterwards

```bash
cd /database
docker compose -p podstart ps          # what is running
docker compose -p podstart logs -f db  # follow one service
docker compose -p podstart restart     # restart ONLY this stack
```

Never run a bare `docker compose` command in this directory without
`-p podstart`; the project flag is what keeps this stack separate from
everything else on the box.

`/database/.secrets.env` holds the JWT secret and the service role key. Back it
up somewhere, and keep it off the frontend — the service role key bypasses
row-level security entirely.
