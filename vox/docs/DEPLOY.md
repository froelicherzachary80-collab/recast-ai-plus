# Free static deployment

```bash
cd vox && npm ci && npm run build   # output: vox/dist
```

`dist/` is plain static files (relative paths, `base: './'`), so it works from any sub-path.

### GitHub Pages
Publish `vox/dist` (e.g. with `actions/upload-pages-artifact` + `actions/deploy-pages`, or push
it to a `gh-pages` branch). GitHub Pages cannot set COOP/COEP headers → single-threaded WASM.

### Cloudflare Pages / Netlify
Build command `npm ci && npm run build`, root `vox`, output `dist`. `public/_headers` is copied
into `dist/` and sets COOP/COEP, enabling multi-threaded WASM.

### Notes
- HTTPS is required for service workers, microphone, WebGPU and OPFS (localhost is exempt).
- After deploying a new version, the service worker updates on the next load; reopen the app.
- Models are not part of the deployment; users import them on their own device.
