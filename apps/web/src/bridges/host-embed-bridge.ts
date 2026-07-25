/**
 * host-embed-bridge — дозволяє батьківському вікну (напр. nodeflow) вбудувати
 * OpenReel через <iframe> і підвантажити відео за URL через postMessage.
 *
 * Протокол повідомлень:
 *   parent → iframe:  { type: "openreel:load-media", items: [{ url, name? }, ...] }
 *   iframe → parent:  { type: "openreel:editor-ready" }                 // готові приймати
 *                     { type: "openreel:media-loaded", loaded, failed } // після завантаження
 *
 * Використання: викликати initHostEmbedBridge() ОДИН раз, коли редактор і всі
 * мости вже ініціалізовані (див. EditorInterface, після setBridgesReady(true)).
 */
import { useProjectStore } from "../stores/project-store";

interface LoadMediaItem {
  url: string;
  name?: string;
}

let initialized = false;
let loading = false;

/** Чи ми всередині iframe (є батьківське вікно, відмінне від нашого). */
function isEmbedded(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window;
  } catch {
    // cross-origin доступ кинув виняток → ми точно в iframe з іншим origin
    return true;
  }
}

function postToParent(message: unknown): void {
  if (isEmbedded()) {
    // "*" — бо origin батька заздалегідь невідомий; дані тут не чутливі
    window.parent.postMessage(message, "*");
  }
}

function guessMimeType(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["mp4", "webm", "m4v"].includes(ext)) return `video/${ext}`;
  if (ext === "mov") return "video/quicktime";
  if (["mp3", "wav", "aac", "ogg", "flac"].includes(ext)) return `audio/${ext}`;
  if (ext === "m4a") return "audio/mp4";
  if (["png", "gif", "webp"].includes(ext)) return `image/${ext}`;
  if (["jpg", "jpeg"].includes(ext)) return "image/jpeg";
  return "video/mp4";
}

function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop();
    if (base && base.includes(".")) return decodeURIComponent(base);
  } catch {
    /* ignore */
  }
  return fallback;
}

async function urlToFile(url: string, name: string): Promise<File> {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status} під час завантаження ${url}`);
  const blob = await res.blob();
  const type = blob.type || guessMimeType(name);
  return new File([blob], name, { type });
}

async function loadMedia(items: LoadMediaItem[]): Promise<void> {
  if (loading) return;
  loading = true;

  const store = useProjectStore.getState();
  const importMedia = store.importMedia;
  const addClipToNewTrack = store.addClipToNewTrack;

  let loaded = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !item.url) {
      failed++;
      continue;
    }
    const name = item.name || fileNameFromUrl(item.url, `clip-${i + 1}.mp4`);
    try {
      const file = await urlToFile(item.url, name);
      const result = await importMedia(file);
      if (result && result.success && result.actionId) {
        await addClipToNewTrack(result.actionId);
        loaded++;
      } else {
        failed++;
        console.error("[openreel-embed] import не вдався:", name, result && result.error);
      }
    } catch (err) {
      failed++;
      console.error("[openreel-embed] завантаження не вдалося:", name, err);
    }
  }

  loading = false;
  postToParent({ type: "openreel:media-loaded", loaded, failed });
}

function onMessage(event: MessageEvent): void {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "openreel:load-media" && Array.isArray(data.items)) {
    void loadMedia(data.items as LoadMediaItem[]);
  }
}

/**
 * Вмикає слухач postMessage і повідомляє батьківське вікно, що редактор готовий
 * приймати відео. Безпечно викликати навіть поза iframe (тоді просто нічого не
 * робить корисного). Ідемпотентно.
 */
export function initHostEmbedBridge(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("message", onMessage);
  postToParent({ type: "openreel:editor-ready" });
}

/** Чи OpenReel відкрито у вбудованому (iframe) режимі. */
export function isEmbeddedMode(): boolean {
  return isEmbedded();
}
