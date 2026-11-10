# Reels dışa aktarımı

`reels.html`, 1080×1920 mantıksal sahneyi pencereye orantılı sığdırır; kalan alan siyahtır. Dosyayı doğrudan açabilir veya herhangi bir statik sunucuyla servis edebilirsiniz. Kontroller fareyle üzerine gelince ya da klavye odağında görünür. Tarayıcıdaki ses için **Sesi aç** düğmesine basın.

```sh
npm ci
npm run render:reels
# Yalnızca yerleşim/oynatma testleri, PNG önizlemeler ve WAV:
node scripts/render-reels.mjs --preview-only
```

Gerekenler: Node.js, sistem Chromium, ffmpeg ve ffprobe. Chromium farklı bir konumdaysa `CHROMIUM_PATH=/path/to/chromium` verilebilir. Global paket veya tarayıcı indirilmez; tek Node bağımlılığı yerel `playwright-core` paketidir. Salt okunur npm önbelleğinde `npm --cache /tmp/tuco-npm-cache ci` kullanın.

13 sahne ve tüm özgün replikler korunur. Kaynak zaman çizelgesi, 89 saniyeye orantılı olarak eşlenir. Tüm replikleri bu süreye sığdırmak hızlı bir okuma temposu gerektirir. Üstte 250 px, altta 380 px ve sağda 120 px Instagram arayüzü için ayrılır; bu bölgelerde yalnızca arka plan vardır.

`?render=1` otomatik oynatmayı ve kontrolleri kapatır. `window.TucoReels.renderAt(saniye)` doğrudan ve geri sarılabilir bir örnekleme yapar. Kareler duvar saatine göre değil `kare / 30` zamanına göre alınır; 2670 kare üretilir. Ses, `assets/background-music.mp3` parçası (https://www.youtube.com/watch?v=h3DVBhneEWc), karakter mırıltıları ve efektlerinden sabit rastgelelik tohumu ile `OfflineAudioContext` üzerinden oluşturulur. İşletim sistemine bağlı konuşma sentezi kullanılmaz. Aynı WAV tarayıcıda çalar; MP4'e AAC olarak eklenir.

Çıktılar: `reels.mp4`, `assets/reels-audio.wav`, `previews/scene-*.png`, `previews/validation.json`, `previews/ffprobe.json`. Betik güvenli alandaki metinleri, sahne sayısını, geri sarmayı, normal oynatmayı ve üç pencere boyutundaki letterbox yerleşimini kontrol eder. MP4, H.264 / yuv420p / 30 fps / faststart olarak üretilir. Sunucu ve Chromium işlem sonunda kapatılır.

Kareler `.reels-frames/<HTML-hash>/` altında önbelleğe alınır. Kesinti sonrası aynı komut eksik karelerden devam eder; tarayıcı bağlamı her 300 karede yenilenir. Başarılı dışa aktarımdan sonra bu önbellek silinebilir. JPEG karelerin tam renk aralığı, `scale=in_range=pc:out_range=tv` ile dönüştürülerek `yuv420p` garantilenir.
