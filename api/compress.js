import fetch from 'node-fetch';
import sharp from 'sharp';
import { AbortController } from 'abort-controller';

// --- CONFIGURACIÓN "CAZADOR INFALIBLE" ---
const MAX_INPUT_SIZE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const MAX_IMAGE_WIDTH = 600;

// --- OBJETIVOS DE TAMAÑO ---
const TARGET_SIZE_STRICT = 100 * 1024;  // 100 KB
const TARGET_SIZE_RELAXED = 150 * 1024; // 150 KB

// --- HEADERS DE TU SCRIPT ORIGINAL (LA LLAVE MAESTRA) ---
function getHeaders(domain) {
  return {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
    'Referer': domain ? domain + '/' : 'https://www.google.com/',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  };
}

// --- NUEVO ALGORITMO "CAZADOR INFALIBLE" ---
async function compressToTargetSize(inputBuffer, targetSize) {
  let minQuality = 5;
  let maxQuality = 100;
  let bestBuffer = null;

  const baseProcessor = sharp(inputBuffer)
    .trim()
    .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
    .png({ colours: 256 });
  
  for (let i = 0; i < 8; i++) {
    const currentQuality = Math.floor((minQuality + maxQuality) / 2);
    if (currentQuality < minQuality) break;

    const currentBuffer = await baseProcessor.clone().webp({ quality: currentQuality, effort: 6 }).toBuffer();

    if (currentBuffer.length <= targetSize) {
      bestBuffer = currentBuffer;
      minQuality = currentQuality + 1;
    } else {
      maxQuality = currentQuality - 1;
    }
  }

  // --- LA LÓGICA INFALIBLE ---
  if (bestBuffer) {
    // Si encontramos una versión que cumple el objetivo, la devolvemos.
    return bestBuffer;
  } else {
    // Si NINGUNA calidad (ni siquiera la 5) cumplió el objetivo,
    // devolvemos el "mejor esfuerzo": la versión con la calidad más baja posible.
    console.log(`[WARN] No se alcanzó el objetivo de ${targetSize / 1024}KB. Devolviendo el mejor esfuerzo (calidad 5).`);
    return await baseProcessor.clone().webp({ quality: 5, effort: 6 }).toBuffer();
  }
}


export default async function handler(req, res) {
  if (req.url.includes('favicon')) {
    return res.status(204).send(null);
  }
  
  const { url: imageUrl, mode } = req.query;

  if (!imageUrl) {
    return res.status(400).json({ error: 'Falta el parámetro url' });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const parsedUrl = new URL(imageUrl);
    const domain = parsedUrl.origin;
    
    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: getHeaders(domain)
    });

    if (!response.ok) throw new Error(`Error al obtener la imagen: ${response.status} ${response.statusText}`);

    const originalContentTypeHeader = response.headers.get('content-type');
    if (!originalContentTypeHeader || !originalContentTypeHeader.startsWith('image/')) {
      throw new Error(`La URL no devolvió una imagen válida. Content-Type: ${originalContentTypeHeader || 'ninguno'}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const originalBuffer = Buffer.from(arrayBuffer);
    
    const originalSize = originalBuffer.length;
    if (originalSize === 0) throw new Error("La imagen descargada está vacía.");
    if (originalSize > MAX_INPUT_SIZE_BYTES) throw new Error(`La imagen excede el límite.`);

    const metadata = await sharp(originalBuffer).metadata();
    if (metadata.pages && metadata.pages > 1) {
      return sendOriginal(res, originalBuffer, originalContentTypeHeader);
    }
    
    const targetSize = mode === 'relaxed' ? TARGET_SIZE_RELAXED : TARGET_SIZE_STRICT;
    const compressedBuffer = await compressToTargetSize(originalBuffer, targetSize);

    if (compressedBuffer && compressedBuffer.length < originalSize) {
      return sendCompressed(res, compressedBuffer, originalSize, compressedBuffer.length, 'image/webp');
    } else {
      return sendOriginal(res, originalBuffer, originalContentTypeHeader);
    }
    
  } catch (error) {
    console.error("[FALLBACK ACTIVADO]", { url: imageUrl, errorMessage: error.message });
    res.setHeader('Location', imageUrl);
    res.status(302).send('Redireccionando a la fuente original por un error de sistema.');
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- FUNCIONES HELPER ---
function sendCompressed(res, buffer, originalSize, compressedSize, contentType) {
  res.setHeader('Cache-Control', 's-maxage=31536000, stale-while-revalidate');
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Original-Size', originalSize);
  res.setHeader('X-Compressed-Size', compressedSize);
  res.send(buffer);
}

function sendOriginal(res, buffer, contentType) {
  res.setHeader('Cache-Control', 's-maxage=31536000, stale-while-revalidate');
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Original-Size', buffer.length);
  res.setHeader('X-Compressed-Size', buffer.length);
  res.send(buffer);
      }
