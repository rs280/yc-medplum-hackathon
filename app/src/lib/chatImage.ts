/**
 * Client-side image handling for copilot document attachments.
 *
 * Both halves run in the browser deliberately: the picked file is normalized
 * here before upload, and the redaction is burned on here once the server says
 * where the identifiers sit. The only copy of the document that survives the
 * turn — in React state, in the transcript, on screen — is redacted.
 */

/** A region of the source image to cover, as 0–1 fractions with a top-left origin. */
export interface PhiBox {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageAttachment {
  fileName: string;
  mediaType: 'image/jpeg';
  /** Full data: URL — the canvas source for redaction. Never leaves the browser. */
  dataUrl: string;
  /** Payload only, for the vision pass. */
  base64: string;
}

export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

// Big enough to read a member ID off a phone photo, small enough to stay cheap.
const MAX_EDGE = 1400;

// Detection edges run small, and a sliver of a member ID is still a member ID.
const BOX_PADDING_FRACTION = 0.012;

export function isSupportedImage(file: File): boolean {
  return /^image\/(png|jpeg|jpg|webp|gif)$/.test(file.type);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file could not be opened as an image.'));
    image.src = dataUrl;
  });
}

function canvasFor(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot process images.');
  return [canvas, ctx];
}

/**
 * Decode, downscale, and re-encode as JPEG. Everything is normalized to one
 * media type so the route has a single format to validate and the vision pass
 * a single format to read.
 */
export async function loadAttachment(file: File): Promise<ImageAttachment> {
  if (!isSupportedImage(file)) throw new Error('Attach a PNG, JPEG, WebP, or GIF image.');
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('That image is larger than 12 MB.');

  const image = await decodeImage(await readAsDataUrl(file));
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
  const [canvas, ctx] = canvasFor(Math.round(image.width * scale), Math.round(image.height * scale));
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return { fileName: file.name, mediaType: 'image/jpeg', dataUrl, base64: dataUrl.split(',')[1] ?? '' };
}

/**
 * Render the safe copy of a document: the page as-is, with opaque boxes over
 * the regions the pass identified. The rest stays readable so the front desk
 * can still see the insurer, plan, and copay.
 *
 * The boxes are therefore the only thing covering PHI, and they are only as
 * good as the coordinates the vision model returned — measured against a known
 * card those ran 3%–17% of image height off and undersized, so a bad reading
 * leaves an identifier visible here. The padding below buys back a little
 * margin; it does not fix a badly placed box.
 */
export async function drawRedactedImage(dataUrl: string, boxes: PhiBox[]): Promise<string> {
  const image = await decodeImage(dataUrl);
  const [canvas, ctx] = canvasFor(image.width, image.height);
  ctx.drawImage(image, 0, 0);

  ctx.fillStyle = '#000';
  const padX = canvas.width * BOX_PADDING_FRACTION;
  const padY = canvas.height * BOX_PADDING_FRACTION;
  for (const box of boxes) {
    ctx.fillRect(
      box.x * canvas.width - padX,
      box.y * canvas.height - padY,
      box.width * canvas.width + padX * 2,
      box.height * canvas.height + padY * 2,
    );
  }
  return canvas.toDataURL('image/jpeg', 0.9);
}
