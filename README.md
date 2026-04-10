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

### Optional: Protect the proxy with a secret

By default, anyone who knows the Worker URL can use the proxy. You can
restrict access by setting a shared secret.

#### 1. Set the secret on the Worker

```bash
npx wrangler secret put PROXY_SECRET
```

You will be prompted to enter the secret value. Wrangler encrypts it and
stores it as a Cloudflare Worker secret (the secret will not be visible 
in plain text in the dashboard).

#### 2. Include the secret in requests

Callers must pass the exact same value in **one** of two ways:

| Method                       | Example                                                                                                              |
|------------------------------|----------------------------------------------------------------------------------------------------------------------|
| **Header** (recommended)     | `X-Proxy-Secret: your-secret-here`                                                                                   |
| **Query parameter** (API v2) | `https://osu-api-proxy.YOUR_SUBDOMAIN.workers.dev/api/v2/...?proxy_secret=your-secret-here`                          |
| **Query parameter** (API v1) | `https://osu-api-proxy.YOUR_SUBDOMAIN.workers.dev/api/get_beatmaps?k=your-osu-api-key&proxy_secret=your-secret-here` |

The query parameter is automatically stripped before the request is forwarded
to osu.ppy.sh, so the upstream API never sees it.

If the secret is set on the Worker but a request omits it (or sends the wrong
value), the proxy responds with **401 Unauthorized**.

#### 3. Remove the secret

To go back to open access, delete the secret:

```bash
npx wrangler secret delete PROXY_SECRET
```

When `PROXY_SECRET` is not set, the proxy accepts all requests without
authentication.

## Apps Script updates

Replace all `https://osu.ppy.sh` with your Worker URL and leave everything else unchanged.

If you added a secret (see above), also add the header to every `UrlFetchApp`
call:

```js
var options = {
  method: "get",
  headers: {
    "Authorization": "Bearer " + osuToken,
    "X-Proxy-Secret": "your-secret-here"   // same value you set with wrangler
  }
};
var response = UrlFetchApp.fetch(url, options);
```
