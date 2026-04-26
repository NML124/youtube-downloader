import express from 'express'
import cors from 'cors'
import YTDlpWrapModule from 'yt-dlp-wrap'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWriteStream, chmodSync, existsSync } from 'node:fs'
import https from 'node:https'

// yt-dlp-wrap ships CJS; under ESM the real constructor lives on module.exports
const YTDlpWrap: typeof YTDlpWrapModule =
  (YTDlpWrapModule as any)['module.exports'] ?? (YTDlpWrapModule as any).default ?? YTDlpWrapModule

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN_PATH = path.join(__dirname, 'yt-dlp-exec')

/** Download a URL following redirects and save to dest. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl: string) => {
      https
        .get(currentUrl, (res) => {
          if (
            res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307 ||
            res.statusCode === 308
          ) {
            res.resume() // drain the redirect body
            follow(res.headers.location!)
            return
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed with status ${res.statusCode}`))
            return
          }
          // Only open the file stream once we have the final 200 response
          const file = createWriteStream(dest)
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
          file.on('error', (err) => {
            file.close()
            reject(err)
          })
          res.on('error', reject)
        })
        .on('error', reject)
    }
    follow(url)
  })
}

function platformBinaryName(): string {
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (process.platform === 'win32') return 'yt-dlp.exe'
  return 'yt-dlp'
}

async function getYtDlp(): Promise<typeof YTDlpWrap.prototype> {
  if (!existsSync(BIN_PATH)) {
    const asset = platformBinaryName()
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`
    console.log(`Downloading yt-dlp standalone binary from ${url} ...`)
    await downloadFile(url, BIN_PATH)
    chmodSync(BIN_PATH, 0o755)
    console.log('yt-dlp downloaded.')
  }
  return new YTDlpWrap(BIN_PATH)
}

const ytDlpPromise = getYtDlp()

function isYouTube(url: string): boolean {
  return /youtube\.com|youtu\.be/.test(url)
}

/** Extra yt-dlp args to bypass YouTube bot detection */
function youtubeArgs(): string[] {
  // Use the TV embedded client which is less restricted than the web client
  const args = ['--extractor-args', 'youtube:player_client=tv_embedded,web_embedded']
  // Pass cookies from the system browser for authentication
  const browser = process.platform === 'darwin' ? 'safari' : 'chrome'
  args.push('--cookies-from-browser', browser)
  return args
}

const app = express()
app.use(cors())
app.use(express.json())

// GET /api/formats?url=...
app.get('/api/formats', async (req, res) => {
  const url = req.query.url as string
  if (!url) {
    res.status(400).json({ error: 'url parameter is required' })
    return
  }

  try {
    const ytDlp = await ytDlpPromise
    const extraArgs = isYouTube(url) ? youtubeArgs() : []
    const info = await ytDlp.getVideoInfo(url, extraArgs)

    const formats = (info.formats as any[])
      .filter((f) => f.url) // only playable formats
      .map((f) => ({
        id: f.format_id as string,
        ext: f.ext as string,
        resolution: f.resolution ?? (f.height ? `${f.height}p` : null) ?? 'audio only',
        filesize: (f.filesize ?? f.filesize_approx ?? null) as number | null,
        vcodec: f.vcodec as string,
        acodec: f.acodec as string,
        note: (f.format_note ?? '') as string,
        fps: (f.fps ?? null) as number | null,
        tbr: (f.tbr ?? null) as number | null,
      }))
      .sort((a, b) => {
        // sort: video+audio > video > audio, then by resolution desc
        const aHasVideo = a.vcodec !== 'none'
        const bHasVideo = b.vcodec !== 'none'
        const aHasAudio = a.acodec !== 'none'
        const bHasAudio = b.acodec !== 'none'
        const aScore = (aHasVideo ? 2 : 0) + (aHasAudio ? 1 : 0)
        const bScore = (bHasVideo ? 2 : 0) + (bHasAudio ? 1 : 0)
        if (bScore !== aScore) return bScore - aScore
        // same type: sort by bitrate desc
        return (b.tbr ?? 0) - (a.tbr ?? 0)
      })

    res.json({
      title: info.title as string,
      thumbnail: info.thumbnail as string,
      duration: info.duration as number,
      uploader: info.uploader as string,
      formats,
    })
  } catch (err: any) {
    console.error(err)
    res.status(500).json({ error: err?.message ?? 'Failed to fetch formats' })
  }
})

// GET /api/download?url=...&formatId=...&filename=...
app.get('/api/download', async (req, res) => {
  const url = req.query.url as string
  const formatId = req.query.formatId as string
  const filename = (req.query.filename as string) || 'video'
  const ext = (req.query.ext as string) || 'mp4'

  if (!url || !formatId) {
    res.status(400).json({ error: 'url and formatId are required' })
    return
  }

  try {
    const ytDlp = await ytDlpPromise

    const safeName = filename.replace(/[^\w\s\-().]/g, '').trim() || 'video'
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`)
    res.setHeader('Content-Type', 'application/octet-stream')

    const extraArgs = isYouTube(url) ? youtubeArgs() : []
    const stream = ytDlp.execStream([url, '-f', formatId, ...extraArgs, '-o', '-'])

    stream.on('error', (err) => {
      console.error('Stream error:', err)
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' })
      } else {
        res.destroy()
      }
    })

    stream.pipe(res)
  } catch (err: any) {
    console.error(err)
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ?? 'Download failed' })
    }
  }
})

const PORT = 3001
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
