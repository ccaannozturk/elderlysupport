# Service Worker & PWA Documentation

## Architecture & Caching Strategy
The Elderly Support League PWA uses a dedicated Service Worker (`sw.js`) to provide fast loading, offline viewing, and Android/iOS home screen installation.

### Cache Versioning
- Current Cache: `esl-static-v1`
- When changes to static assets (`app.js`, `index.html`, styling) are deployed, bump the cache name in `sw.js` (e.g. `esl-static-v2`).
- The `activate` event automatically deletes all stale caches from prior versions.

### Protected Endpoints (Never Cached)
The service worker explicitly ignores and never intercepts requests matching:
- `firestore.googleapis.com` (Firestore database traffic — handled by Firestore's built-in IndexedDB persistence)
- `identitytoolkit.googleapis.com` & `securetoken.googleapis.com` (Firebase Auth session tokens)
- `*.cloudfunctions.net` (Backend Cloud Function API calls)
- `generativelanguage.googleapis.com` (Gemini API)

### Caching Rules
1. **App Shell (`index.html` & Document Navigation):** Network-First with cache fallback. This ensures new updates reach users immediately while still providing offline support.
2. **Static Assets (CSS, JS, Fonts):** Cache-First with background revalidation.

---

## 🚨 Emergency Kill Switch

If the Service Worker ever behaves unexpectedly in production:

1. Open `sw.js`.
2. Replace its entire contents with:
   ```javascript
   self.addEventListener('install', () => self.skipWaiting());
   self.addEventListener('activate', (event) => {
     event.waitUntil(
       caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
         .then(() => self.registration.unregister())
         .then(() => self.clients.claim())
     );
   });
   ```
3. Commit and deploy to `main`. Every client visiting the website will automatically unregister the worker and clear all caches on their next request.
