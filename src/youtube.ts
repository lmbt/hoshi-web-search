/**
 * YouTube transcript extraction via Innertube API.
 * No API key or yt-dlp required. Falls back to video description.
 */

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

export function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com|youtu\.be)\//.test(url);
}

function extractVideoId(url: string): string | undefined {
  const m = url.match(YOUTUBE_RE);
  return m ? m[1] : undefined;
}

interface CaptionTrack { baseUrl: string; languageCode: string; kind: string; }

function pickBestTrack(tracks: CaptionTrack[], lang = "en"): CaptionTrack {
  return tracks.find(t => t.kind !== "asr" && t.languageCode === lang)
    || tracks.find(t => t.kind !== "asr")
    || tracks.find(t => t.languageCode === lang)
    || tracks[0];
}

function parseTranscriptXml(xml: string): string {
  const segments: string[] = [];
  const re = /<text[^>]*>([^<]*)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    segments.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  }
  return segments.join(" ").replace(/\s+/g, " ").trim();
}

export interface YouTubeResult {
  title: string;
  transcript: string;
  hasTranscript: boolean;
}

/**
 * Extract transcript from a YouTube URL.
 * Returns title + transcript text, or title + description if no captions available.
 */
export async function fetchYouTubeTranscript(url: string, signal?: AbortSignal): Promise<YouTubeResult> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error(`Not a valid YouTube URL: ${url}`);

  // Step 1: GET watch page to extract API key and title
  const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  const watchHtml = await watchRes.text();

  if (watchHtml.includes('class="g-recaptcha"')) throw new Error("YouTube rate limited");

  const apiKeyMatch = watchHtml.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!apiKeyMatch) throw new Error("Could not extract YouTube API key");

  const titleMatch = watchHtml.match(/"title":"([^"]+)"/) || watchHtml.match(/<title>([^<]+)<\/title>/);
  const rawTitle = titleMatch?.[1] || "YouTube Video";

  // Step 2: POST Innertube player API
  const playerRes = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKeyMatch[1]}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } }, videoId }),
    signal,
  });
  const playerData = await playerRes.json() as any;

  const title = playerData?.videoDetails?.title || rawTitle.replace(/ - YouTube$/, "");
  const captionTracks: CaptionTrack[] | undefined = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  // No captions — fall back to description
  if (!captionTracks || captionTracks.length === 0) {
    const description = playerData?.videoDetails?.shortDescription || "";
    return { title, transcript: description, hasTranscript: false };
  }

  // Step 3: GET transcript XML
  const track = pickBestTrack(captionTracks);
  const transcriptRes = await fetch(track.baseUrl.replace(/&fmt=[^&]*/, ""), {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  const transcriptXml = await transcriptRes.text();
  const transcript = parseTranscriptXml(transcriptXml);

  if (!transcript) {
    const description = playerData?.videoDetails?.shortDescription || "";
    return { title, transcript: description, hasTranscript: false };
  }

  return { title, transcript, hasTranscript: true };
}
