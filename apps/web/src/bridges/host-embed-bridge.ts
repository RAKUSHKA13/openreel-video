/**
 * host-embed-bridge — дозволяє батьківському вікну (напр. nodeflow) вбудувати
 * OpenReel через <iframe> і підвантажити медіа через postMessage.
 *
 * Протокол повідомлень:
 *   parent → iframe:  { type: "openreel:ping" }                          // "ти вже живий?"
 *                     { type: "openreel:load-media", items: [...] }
 *        item: { name?, blob? , url? , mime? }
 *        — blob (Blob/File/ArrayBuffer) кращий за url: не залежить від CORS,
 *          бо файл качає батьківське вікно зі свого origin.
 *   iframe → parent:  { type: "openreel:editor-ready" }                  // готові приймати
 *                     { type: "openreel:media-loaded", loaded, failed, errors }
 *
 * Використання: викликати initHostEmbedBridge() ОДИН раз, коли редактор і всі
 * мости вже ініціалізовані (див. EditorInterface, після setBridgesReady(true)).
 */
import { useProjectStore } from "../stores/project-store";

interface LoadMediaItem {
  url?: string;
  name?: string;
  mime?: string;
  blob?: Blob | ArrayBuffer;
}

let initialized = false;
let ready = false;
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

/** Перетворює елемент протоколу на File: спершу готовий blob, інакше качаємо url. */
async function itemToFile(item: LoadMediaItem, index: number): Promise<File> {
  const name =
    item.name || (item.url ? fileNameFromUrl(item.url, `clip-${index + 1}.mp4`) : `clip-${index + 1}.mp4`);

  if (item.blob) {
    const raw =
      item.blob instanceof Blob ? item.blob : new Blob([item.blob as ArrayBuffer]);
    const type = item.mime || raw.type || guessMimeType(name);
    return new File([raw], name, { type });
  }
  if (item.url) return urlToFile(item.url, name);
  throw new Error("елемент без blob і без url");
}

async function loadMedia(items: LoadMediaItem[]): Promise<void> {
  if (loading) return;
  loading = true;

  const store = useProjectStore.getState();
  const importMedia = store.importMedia;
  const addClipToNewTrack = store.addClipToNewTrack;

  let loaded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = (item && item.name) || `#${i + 1}`;
    if (!item || (!item.blob && !item.url)) {
      failed++;
      errors.push(`${label}: порожній елемент`);
      continue;
    }
    try {
      const file = await itemToFile(item, i);
      const result = await importMedia(file);
      if (result && result.success && result.actionId) {
        await addClipToNewTrack(result.actionId);
        loaded++;
      } else {
        failed++;
        const msg = result?.error?.message || "невідома помилка import";
        errors.push(`${label}: ${msg}`);
        console.error("[openreel-embed] import не вдався:", label, result);
      }
    } catch (err) {
      failed++;
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[openreel-embed] завантаження не вдалося:", label, err);
    }
  }

  loading = false;
  postToParent({ type: "openreel:media-loaded", loaded, failed, errors });
}

function onMessage(event: MessageEvent): void {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "openreel:ping") {
    // Батько питає, чи ми вже готові. Відповідаємо лише коли редактор змонтовано.
    if (ready) postToParent({ type: "openreel:editor-ready" });
    return;
  }
  if (data.type === "openreel:load-media" && Array.isArray(data.items)) {
    void loadMedia(data.items as LoadMediaItem[]);
  }
}

/**
 * Слухач postMessage вмикається якнайраніше (щоб не проґавити ping, поки
 * редактор ще монтується). Викликається з main.tsx / App.
 */
export function installHostEmbedListener(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("message", onMessage);
}

/**
 * Повідомляє батьківське вікно, що редактор готовий приймати відео.
 * Викликати, коли всі мости ініціалізовані (EditorInterface, після
 * setBridgesReady(true)). Ідемпотентно.
 */
export function initHostEmbedBridge(): void {
  if (typeof window === "undefined") return;
  installHostEmbedListener();
  ready = true;
  postToParent({ type: "openreel:editor-ready" });
}

/** Чи OpenReel відкрито у вбудованому (iframe) режимі. */
export function isEmbeddedMode(): boolean {
  return isEmbedded();
}
