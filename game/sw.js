/* Service Worker：把遊戲檔案快取起來，安裝後即可完全離線遊玩 */
const CACHE = "zombie-radish-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate", e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

// 離線優先：先找快取，沒有再走網路（並順手存起來）
self.addEventListener("fetch", e=>{
  if(e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(hit=>{
      return hit || fetch(e.request).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(e.request, copy)).catch(()=>{});
        return res;
      }).catch(()=>hit);
    })
  );
});
