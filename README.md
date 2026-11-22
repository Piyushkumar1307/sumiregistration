# Gift desk scanner

Camera-based one-time gift redemption for the `ReceivedItem` device and counter. A green result means hand over the gift; an amber result means it was already given. The server securely forwards each scan to `https://airtelevents.in/api/v1/gift/redeem`.

## Run locally

```bash
npm install
cp .env.example .env
# set GIFT_DEVICE_KEY in your shell or environment manager
npm start
```

Open `http://localhost:3000`. The device key is intentionally held only by the server and is never sent to the browser.

## Deploy on Render

1. Push this folder to a private GitHub/GitLab repository.
2. In Render, choose **New → Blueprint** and select the repository. Render reads `render.yaml`.
3. Set `GIFT_DEVICE_KEY` to the supplied Gift distribution key (secret value) and deploy.
4. Visit the service URL, allow camera access, and scan a QR code.

Use HTTPS (provided by Render) for mobile camera access. Check `/health` after deployment; it returns `ready` only when the key is set.
