# osu! API Proxy (Cloudflare Worker)

Deploy this proxy and point your google sheets to fix 429 issues when querying the osu! API (v1 and v2).

## Quick Start

### Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) v18+ installed locally

### Deployment

```bash
git clone https://github.com/ILW8/osu-api-proxy.git
cd osu-api-proxy

npm install

npm run deploy
```

`npm run deploy` will prompt you to log into your cloudflare account on the first run.

After deploy is done, your proxy address will be printed like this:

```
Published osu-api-proxy (7.27 sec)
  https://osu-api-proxy.YOUR_SUBDOMAIN.workers.dev
```

## Apps Script updates

Replace all `https://osu.ppy.sh` with your Worker URL and leave everything else unchanged.
