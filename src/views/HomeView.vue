<script setup lang="ts">
import { ref, computed } from 'vue'

interface Format {
  id: string
  ext: string
  resolution: string
  filesize: number | null
  vcodec: string
  acodec: string
  note: string
  fps: number | null
  tbr: number | null
}

interface VideoInfo {
  title: string
  thumbnail: string
  duration: number
  uploader: string
  formats: Format[]
}

const url = ref('')
const loading = ref(false)
const error = ref('')
const videoInfo = ref<VideoInfo | null>(null)
const downloadingId = ref<string | null>(null)

const displayFormats = computed(() => {
  if (!videoInfo.value) return []
  const map = new Map<string, Format>()
  for (const f of videoInfo.value.formats) {
    if (f.ext === 'mhtml') continue
    const key = f.resolution
    const existing = map.get(key)
    if (!existing) {
      map.set(key, f)
    } else {
      const isMp4 = f.ext === 'mp4'
      const existingIsMp4 = existing.ext === 'mp4'
      if (isMp4 && !existingIsMp4) {
        map.set(key, f)
      } else if (isMp4 === existingIsMp4 && (f.filesize ?? 0) > (existing.filesize ?? 0)) {
        map.set(key, f)
      }
    }
  }
  return Array.from(map.values())
})

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '—'
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function formatType(f: Format): 'video+audio' | 'video' | 'audio' {
  if (f.vcodec !== 'none' && f.acodec !== 'none') return 'video+audio'
  if (f.vcodec !== 'none') return 'video'
  return 'audio'
}

async function fetchFormats() {
  if (!url.value.trim()) return
  loading.value = true
  error.value = ''
  videoInfo.value = null

  try {
    const res = await fetch(`/api/formats?url=${encodeURIComponent(url.value.trim())}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Erreur inconnue')
    videoInfo.value = data
  } catch (e: any) {
    error.value = e.message ?? 'Impossible de récupérer les formats'
  } finally {
    loading.value = false
  }
}

async function download(format: Format) {
  if (!videoInfo.value) return
  downloadingId.value = format.id
  const title = videoInfo.value.title

  // Video-only formats: merge with best available audio stream
  const isVideoOnly = formatType(format) === 'video'
  const effectiveFormatId = isVideoOnly ? `${format.id}+bestaudio` : format.id
  const effectiveExt = isVideoOnly ? 'mp4' : format.ext

  const params = new URLSearchParams({
    url: url.value.trim(),
    formatId: effectiveFormatId,
    filename: title,
    ext: effectiveExt,
  })

  try {
    const response = await fetch(`/api/download?${params}`)
    if (!response.ok) {
      downloadingId.value = null
      return
    }
    // Headers received = download stream has started
    downloadingId.value = null
    const blob = await response.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = `${title}.${effectiveExt}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
  } catch {
    downloadingId.value = null
  }
}
</script>

<template>
  <main>
    <div class="hero">
      <div class="hero-icon">▶</div>
      <h1>YouTube Downloader</h1>
      <p class="subtitle">Colle un lien YouTube, choisis ton format, télécharge.</p>
    </div>

    <div class="search-bar">
      <input
        v-model="url"
        type="url"
        placeholder="https://www.youtube.com/watch?v=..."
        @keyup.enter="fetchFormats"
        :disabled="loading"
      />
      <button @click="fetchFormats" :disabled="loading || !url.trim()" class="btn-search">
        <span v-if="loading" class="spinner" />
        <span v-else>Rechercher</span>
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <Transition name="fade">
      <div v-if="loading" class="loading-state">
        <div class="loading-icon">▶</div>
        <div class="loading-bars"><span /><span /><span /><span /><span /></div>
        <p>Récupération des formats…</p>
      </div>
    </Transition>

    <div v-if="videoInfo" class="results">
      <div class="video-info">
        <img :src="videoInfo.thumbnail" :alt="videoInfo.title" class="thumbnail" />
        <div class="video-meta">
          <h2>{{ videoInfo.title }}</h2>
          <p class="meta-row">
            <span>{{ videoInfo.uploader }}</span>
            <span class="dot">·</span>
            <span>{{ formatDuration(videoInfo.duration) }}</span>
          </p>
        </div>
      </div>

      <table class="formats-table">
        <thead>
          <tr>
            <th>Format</th>
            <th>Résolution</th>
            <th>Type</th>
            <th>Taille</th>
            <th>FPS</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in displayFormats" :key="f.id">
            <td>
              <span class="ext-badge">{{ f.ext.toUpperCase() }}</span>
            </td>
            <td>{{ f.resolution }}</td>
            <td>
              <span class="type-badge" :class="formatType(f)">{{ formatType(f) }}</span>
            </td>
            <td class="size">{{ formatSize(f.filesize) }}</td>
            <td class="fps">{{ formatType(f) !== 'audio' ? (f.fps ?? '—') : '—' }}</td>
            <td>
              <button
                class="btn-download"
                :class="{ loading: downloadingId === f.id }"
                :disabled="downloadingId === f.id"
                @click="download(f)"
              >
                <span v-if="downloadingId === f.id">⏳</span>
                <span v-else>⬇ Télécharger</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="footer">
      <p>Fait par <span class="author">Young Solver</span></p>
    </footer>
  </main>
</template>

<style scoped>
main {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem 1rem 4rem;
  box-sizing: border-box;
  width: 100%;
}

.hero {
  text-align: center;
  margin-bottom: 2.5rem;
}

.hero-icon {
  font-size: 3rem;
  color: #ff0000;
  margin-bottom: 0.5rem;
}

h1 {
  font-size: clamp(1.5rem, 5vw, 2rem);
  font-weight: 700;
  margin: 0 0 0.5rem;
}

.subtitle {
  color: var(--color-text);
  opacity: 0.65;
  font-size: 1rem;
  margin: 0;
}

.search-bar {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.search-bar input {
  flex: 1;
  padding: 0.75rem 1rem;
  border: 2px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
  color: var(--color-text);
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.2s;
}

.search-bar input:focus {
  border-color: #ff0000;
}

.btn-search {
  padding: 0.75rem 1.5rem;
  background: #ff0000;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  min-width: 130px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  transition: opacity 0.2s;
}

.btn-search:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error {
  color: #f87171;
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}

.video-info {
  display: flex;
  gap: 1.25rem;
  align-items: center;
  background: var(--color-background-soft);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 1rem;
  margin-bottom: 1.5rem;
}

.thumbnail {
  width: 180px;
  min-width: 180px;
  height: 101px;
  object-fit: cover;
  border-radius: 6px;
  background: #000;
  flex-shrink: 0;
}

.video-meta h2 {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 0 0 0.4rem;
  line-height: 1.4;
}

.meta-row {
  font-size: 0.875rem;
  opacity: 0.65;
  margin: 0;
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.dot {
  opacity: 0.4;
}

.formats-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.formats-table th {
  text-align: left;
  padding: 0.6rem 0.75rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.55;
  border-bottom: 1px solid var(--color-border);
}

.formats-table td {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}

.formats-table tr:last-child td {
  border-bottom: none;
}

.formats-table tr:hover td {
  background: var(--color-background-soft);
}

.ext-badge {
  background: var(--color-background-mute);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 0.1rem 0.45rem;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: monospace;
}

.type-badge {
  display: inline-block;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 20px;
}

.type-badge.video\+audio {
  background: rgba(52, 211, 153, 0.15);
  color: #34d399;
  border: 1px solid rgba(52, 211, 153, 0.3);
}

.type-badge.video {
  background: rgba(96, 165, 250, 0.15);
  color: #60a5fa;
  border: 1px solid rgba(96, 165, 250, 0.3);
}

.type-badge.audio {
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(251, 191, 36, 0.3);
}

.size,
.fps {
  opacity: 0.65;
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
}

.btn-download {
  padding: 0.4rem 0.9rem;
  background: transparent;
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.82rem;
  cursor: pointer;
  white-space: nowrap;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.btn-download:hover:not(:disabled) {
  border-color: #ff0000;
  color: #ff0000;
  background: rgba(255, 0, 0, 0.06);
}

.btn-download.loading,
.btn-download:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Loading state */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 3rem 1rem;
  text-align: center;
  color: var(--color-text);
  opacity: 0.75;
  font-size: 0.95rem;
}

.loading-icon {
  font-size: 2.5rem;
  color: #ff0000;
  animation: pulse 1.2s ease-in-out infinite;
}

.loading-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 28px;
}

.loading-bars span {
  display: block;
  width: 5px;
  border-radius: 3px;
  background: #ff0000;
  animation: bar 1s ease-in-out infinite;
}

.loading-bars span:nth-child(1) {
  animation-delay: 0s;
  height: 40%;
}
.loading-bars span:nth-child(2) {
  animation-delay: 0.1s;
  height: 70%;
}
.loading-bars span:nth-child(3) {
  animation-delay: 0.2s;
  height: 100%;
}
.loading-bars span:nth-child(4) {
  animation-delay: 0.3s;
  height: 70%;
}
.loading-bars span:nth-child(5) {
  animation-delay: 0.4s;
  height: 40%;
}

@keyframes bar {
  0%,
  100% {
    transform: scaleY(0.4);
    opacity: 0.5;
  }
  50% {
    transform: scaleY(1);
    opacity: 1;
  }
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.7;
  }
  50% {
    transform: scale(1.15);
    opacity: 1;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.footer {
  text-align: center;
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--color-border);
  font-size: 0.85rem;
  opacity: 0.6;
}

.footer .author {
  font-weight: 600;
  opacity: 1;
}

/* ── Tablet (641px – 1024px) ── */
@media (min-width: 641px) and (max-width: 1024px) {
  main {
    padding: 2rem 1.5rem 4rem;
  }

  .formats-table {
    font-size: 0.85rem;
  }
}

/* ── Mobile (≤ 640px) ── */
@media (max-width: 640px) {
  main {
    padding: 1.25rem 0.75rem 3rem;
  }

  .hero {
    margin-bottom: 1.75rem;
  }

  .hero-icon {
    font-size: 2.25rem;
  }

  .subtitle {
    font-size: 0.9rem;
  }

  .search-bar {
    flex-direction: column;
  }

  .btn-search {
    width: 100%;
    min-width: unset;
  }

  .video-info {
    flex-direction: column;
  }

  .thumbnail {
    width: 100%;
    height: auto;
    min-width: unset;
  }

  .formats-table {
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    font-size: 0.82rem;
  }

  /* Hide FPS and Size columns on small screens */
  .formats-table th:nth-child(4),
  .formats-table td:nth-child(4),
  .formats-table th:nth-child(5),
  .formats-table td:nth-child(5) {
    display: none;
  }

  .btn-download {
    padding: 0.35rem 0.65rem;
    font-size: 0.78rem;
  }
}
</style>
